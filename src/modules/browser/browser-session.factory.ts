import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import Steel from 'steel-sdk';
import type { StagehandBrowser } from '@browserbasehq/stagehand';
import { SessionRecordEntity } from '@modules/persistence/entities/session-record.entity';
import { STAGEHAND_DOM_SETTLE_MS } from '@common/constants/session-lifecycle.constants';
import type { ExternalModelConfig } from '@modules/model/external-model.types';
import type {
  BrowserSession,
  StagehandConnectTarget,
  StagehandConnection,
} from './browser-session.types';
import {
  chromeExtensionIdFromSteelId,
  discoverStagehandChromeExtensionId,
  ensureStagehandExtensionZip,
  resolveSteelStagehandExtensionId,
} from './stagehand-extension';

type StagehandModule = typeof import('@browserbasehq/stagehand');

let stagehandModulePromise: Promise<StagehandModule> | null = null;

function loadStagehandModule(): Promise<StagehandModule> {
  if (!stagehandModulePromise) {
    stagehandModulePromise = import('@browserbasehq/stagehand');
  }
  return stagehandModulePromise;
}

export interface CreatedBrowserSession {
  browserSessionId: string;
  liveUrl: string;
  recordId: string;
  live: BrowserSession;
}

@Injectable()
export class BrowserSessionFactory {
  private readonly logger = new Logger(BrowserSessionFactory.name);
  private client: Steel | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(SessionRecordEntity)
    private readonly sessionsRepo: Repository<SessionRecordEntity>,
  ) {}

  async create(
    clientId: string,
    goal: string,
    externalModel: ExternalModelConfig | null = null,
  ): Promise<CreatedBrowserSession> {
    const steelApiKey = this.steelApiKey();
    const createdAt = new Date();

    const record = this.sessionsRepo.create({
      id: randomUUID(),
      goal: goal || '(pending)',
      taskType: null,
      status: 'running',
      startedAt: createdAt,
      endedAt: null,
      steps: [],
      screenshots: [],
      result: null,
      error: null,
    });
    await this.sessionsRepo.save(record);

    let browserSessionId = '';
    let liveUrl = '';

    try {
      const steel = this.getClient();
      // Stagehand v4 needs its Chrome extension in the remote browser. Steel
      // cannot resolve local paths via Extensions.loadUnpacked, so upload once
      // and attach via extensionIds, then connect with the Chrome extension id.
      ensureStagehandExtensionZip();
      const steelExtensionId = await resolveSteelStagehandExtensionId(steel);
      const session = await steel.sessions.create({
        extensionIds: [steelExtensionId],
        // Headful WebRTC at 1080p for a sharper live stream in the embed.
        headless: false,
        dimensions: { width: 1920, height: 1080 },
        deviceConfig: { device: 'desktop' },
      });
      browserSessionId = session.id ?? '';
      if (!browserSessionId) {
        throw new Error('Steel session create did not return an id');
      }

      // Prefer Steel's embeddable debug/player URL (WebRTC live stream).
      // sessionViewerUrl is the dashboard page and does not stream well in an iframe.
      const debugUrl =
        (session as { debugUrl?: string }).debugUrl?.trim() || '';
      const viewerUrl = session.sessionViewerUrl?.trim() || '';
      liveUrl = debugUrl || viewerUrl;

      const wsBase = session.websocketUrl ?? '';
      if (!wsBase) {
        throw new Error('Steel session did not return websocketUrl');
      }
      const cdpUrl = `${wsBase}${wsBase.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(steelApiKey)}`;

      // Prefer Steel's extension id when it is already a Chrome extension id —
      // avoids an extra CDP open that races while the session is still warming.
      const chromeExtensionId =
        chromeExtensionIdFromSteelId(steelExtensionId) ??
        (await discoverStagehandChromeExtensionId(cdpUrl));
      const connectTarget: StagehandConnectTarget = {
        cdpUrl,
        extensionId: chromeExtensionId,
        externalModel,
      };
      const connection = await this.connect(connectTarget);

      const live: BrowserSession = {
        ...connection,
        connectTarget,
        sessionId: browserSessionId,
        liveUrl,
        createdAt,
        recordId: record.id,
      };

      this.logger.log(
        `Steel session ${browserSessionId} created for client ${clientId} (stagehand)`,
      );

      return {
        browserSessionId,
        liveUrl,
        recordId: record.id,
        live,
      };
    } catch (err) {
      this.logger.error(
        `Stagehand connect failed for client ${clientId}, rolling back Steel session ${browserSessionId || 'unknown'}: ${formatUnknownError(err)}`,
      );
      if (browserSessionId) {
        await this.releaseSteelSession(browserSessionId);
      }
      try {
        await this.sessionsRepo.delete(record.id);
      } catch (dbErr) {
        this.logger.warn(
          `Failed to delete SessionRecord ${record.id}: ${String(dbErr)}`,
        );
      }
      throw err;
    }
  }

  /** Attach Stagehand to a running Steel browser; reused on reconnect. */
  async connect(target: StagehandConnectTarget): Promise<StagehandConnection> {
    const { localBrowser, Stagehand } = await loadStagehandModule();
    const browserHandle = await connectLocalBrowserWithRetry(localBrowser, {
      cdpUrl: target.cdpUrl,
      extensionId: target.extensionId,
    });

    try {
      const stagehand = await Stagehand.create({
        browser: browserHandle,
        model: this.stagehandModelConfig(target.externalModel),
        cache: false,
        domSettleTimeoutMs: STAGEHAND_DOM_SETTLE_MS,
        logging: { level: 'warn', format: 'json' },
      });

      const pages = await browserHandle.context.pages();
      const page = pages[0] ?? (await browserHandle.context.newPage());
      return { stagehand, browserHandle, page };
    } catch (err) {
      try {
        await browserHandle.close();
      } catch (closeErr) {
        this.logger.warn(
          `Failed to close browser handle after connect error: ${String(closeErr)}`,
        );
      }
      throw err;
    }
  }

  async releaseSteelSession(sessionId: string): Promise<void> {
    try {
      await this.getClient().sessions.release(sessionId);
    } catch (err) {
      this.logger.warn(
        `Failed to release Steel session ${sessionId}: ${formatUnknownError(err)}`,
      );
    }
  }

  async finalizeRecord(
    recordId: string,
    opts?: { status?: 'complete' | 'stopped' | 'error'; error?: string },
  ): Promise<void> {
    try {
      await this.sessionsRepo.update(recordId, {
        status: opts?.status ?? 'stopped',
        endedAt: new Date(),
        error: opts?.error ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to finalize SessionRecord ${recordId}: ${String(err)}`,
      );
    }
  }

  private getClient(): Steel {
    if (this.client) {
      return this.client;
    }
    this.client = new Steel({ steelAPIKey: this.steelApiKey() });
    return this.client;
  }

  private steelApiKey(): string {
    const key = this.config.get<string>('steel.apiKey') ?? '';
    if (!key) {
      throw new Error('STEEL_API_KEY is required to create browser sessions');
    }
    return key;
  }

  /** Stagehand ids are `<provider>/<model>`; Gemini is `google/` in Stagehand. */
  private stagehandModelConfig(externalModel: ExternalModelConfig | null) {
    if (externalModel) {
      const prefix = externalModel.provider === 'gemini' ? 'google' : 'openai';
      return {
        modelName: `${prefix}/${externalModel.model}` as never,
        apiKey: externalModel.apiKey,
      };
    }
    return {
      modelName: this.stagehandModel() as never,
      apiKey: this.openAiApiKey(),
    };
  }

  private openAiApiKey(): string {
    const key = this.config.get<string>('openai.apiKey') ?? '';
    if (!key) {
      throw new Error('OPENAI_API_KEY is required for Stagehand browser sessions');
    }
    return key;
  }

  private stagehandModel(): string {
    const model = this.config.get<string>('openai.stagehandModel')?.trim() ?? '';
    if (!model) {
      throw new Error(
        'OPENAI_STAGEHAND_MODEL is required for Stagehand browser sessions',
      );
    }
    return model;
  }
}

function formatUnknownError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause =
    err.cause instanceof Error
      ? err.cause.message
      : err.cause != null
        ? String(err.cause)
        : '';
  return cause ? `${err.message} (${cause})` : err.message;
}

async function connectLocalBrowserWithRetry(
  localBrowser: StagehandModule['localBrowser'],
  opts: { cdpUrl: string; extensionId: string },
): Promise<StagehandBrowser> {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await localBrowser.connect(opts);
    } catch (err) {
      lastError = err;
      const message = formatUnknownError(err);
      if (
        attempt === attempts ||
        !/CDP WebSocket|Failed to open CDP/i.test(message)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}
