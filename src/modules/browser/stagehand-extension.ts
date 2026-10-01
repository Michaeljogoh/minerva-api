import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import Steel, { toFile } from 'steel-sdk';

const STAGEHAND_EXTENSION_NAME_RE = /stagehand/i;
/** Chrome extension ids are 32 chars in a–p (not a full hex alphabet). */
const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/u;
const DISCOVER_TIMEOUT_MS = 30_000;
const DISCOVER_POLL_MS = 200;
const CDP_CONNECT_ATTEMPTS = 5;
const CDP_CONNECT_RETRY_MS = 500;

let cachedSteelExtensionId: string | null = null;

/**
 * Stagehand uploads a Chrome extension zip when launching Browserbase.
 * Ensure the archive exists (some installs ship `dist/extension/` only).
 *
 * Do not `require.resolve('@browserbasehq/stagehand/package.json')` — that
 * subpath is not in the package `exports` map.
 */
export function ensureStagehandExtensionZip(): string {
  const pkgJson = findPackageJSON(
    '@browserbasehq/stagehand',
    path.join(process.cwd(), 'package.json'),
  );
  if (!pkgJson) {
    throw new Error(
      'Could not locate @browserbasehq/stagehand. Reinstall the package.',
    );
  }
  const pkgRoot = path.dirname(pkgJson);
  const zipPath = path.join(pkgRoot, 'dist/assets/stagehand-extension.zip');
  const extDir = path.join(pkgRoot, 'dist/extension');

  if (!existsSync(zipPath)) {
    if (!existsSync(extDir)) {
      throw new Error(
        'Stagehand Chrome extension is missing. Reinstall @browserbasehq/stagehand.',
      );
    }
    mkdirSync(path.dirname(zipPath), { recursive: true });
    execFileSync(
      'python3',
      [
        '-c',
        'import pathlib, sys, zipfile\nroot = pathlib.Path(sys.argv[1])\nout = pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:\n    for path in root.rglob("*"):\n        if path.is_file():\n            archive.write(path, path.relative_to(root))',
        extDir,
        zipPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH = zipPath;
  return zipPath;
}

/**
 * Upload (or reuse) the Stagehand Chrome extension on Steel so remote sessions
 * can load it without CDP `Extensions.loadUnpacked` (which fails over Steel).
 */
export async function resolveSteelStagehandExtensionId(
  steel: Steel,
): Promise<string> {
  if (cachedSteelExtensionId) {
    return cachedSteelExtensionId;
  }

  const listed = await steel.extensions.list();
  const existing = listed.extensions.find((ext) =>
    STAGEHAND_EXTENSION_NAME_RE.test(ext.name),
  );
  if (existing?.id) {
    cachedSteelExtensionId = existing.id;
    return existing.id;
  }

  const zipPath = ensureStagehandExtensionZip();
  const file = await toFile(
    createReadStream(zipPath),
    'stagehand-extension.zip',
  );
  const uploaded = await steel.extensions.upload({ file });
  if (!uploaded.id) {
    throw new Error('Steel extension upload did not return an id');
  }
  cachedSteelExtensionId = uploaded.id;
  return uploaded.id;
}

/**
 * Steel's uploaded extension id is the Chrome extension id for CRX uploads.
 * Prefer that over a CDP round-trip when the id shape matches.
 */
export function chromeExtensionIdFromSteelId(
  steelExtensionId: string,
): string | null {
  return CHROME_EXTENSION_ID_RE.test(steelExtensionId)
    ? steelExtensionId
    : null;
}

/**
 * After Steel installs the Stagehand extension into a session, discover the
 * Chrome extension id so `localBrowser.connect({ extensionId })` skips
 * `loadUnpacked` (which cannot resolve local paths on remote Steel Chrome).
 */
export async function discoverStagehandChromeExtensionId(
  cdpUrl: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const ws = await openCdpSocketWithRetry(cdpUrl, timeoutMs);
  let nextId = 1;

  try {
    while (Date.now() < deadline) {
      const result = await cdpSend<{
        targetInfos?: Array<{ type?: string; url?: string }>;
      }>(ws, nextId++, 'Target.getTargets');

      const worker = (result.targetInfos ?? []).find(
        (target) =>
          target.type === 'service_worker' &&
          typeof target.url === 'string' &&
          target.url.startsWith('chrome-extension://') &&
          target.url.includes('service-worker.js'),
      );

      const extensionId = worker?.url
        ? extensionIdFromUrl(worker.url)
        : undefined;
      if (extensionId) {
        return extensionId;
      }

      await sleep(DISCOVER_POLL_MS);
    }

    throw new Error(
      `Timed out waiting for Stagehand Chrome extension on Steel CDP (${timeoutMs}ms)`,
    );
  } finally {
    ws.close();
  }
}

function extensionIdFromUrl(url: string): string | undefined {
  return /^chrome-extension:\/\/([^/]+)\//u.exec(url)?.[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openCdpSocketWithRetry(
  cdpUrl: string,
  timeoutMs: number,
): Promise<WebSocket> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt++) {
    try {
      return await openCdpSocket(cdpUrl, timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt === CDP_CONNECT_ATTEMPTS) {
        break;
      }
      await sleep(CDP_CONNECT_RETRY_MS * attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('CDP WebSocket connection failed');
}

function openCdpSocket(cdpUrl: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cdpUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      ws.close();
      reject(new Error(`CDP WebSocket connect timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', (event) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const detail =
        event instanceof ErrorEvent && event.message
          ? event.message
          : 'connection failed';
      reject(new Error(`CDP WebSocket connection failed: ${detail}`));
    });
  });
}

function cdpSend<T>(
  ws: WebSocket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      let payload: {
        id?: number;
        result?: T;
        error?: { message?: string };
      };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        return;
      }
      if (payload.id !== id) {
        return;
      }
      ws.removeEventListener('message', onMessage);
      if (payload.error) {
        reject(
          new Error(payload.error.message ?? `CDP ${method} failed`),
        );
        return;
      }
      resolve((payload.result ?? {}) as T);
    };

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
}
