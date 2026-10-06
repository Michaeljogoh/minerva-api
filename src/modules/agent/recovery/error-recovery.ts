/** PRD §13 — error recovery constants and classifiers. */

export const TOOL_RETRY_ATTEMPTS = 3;
/** Exponential-ish backoff for Playwright tools: 0s, 1s, 2s. */
export const TOOL_RETRY_DELAYS_MS = [0, 1000, 2000] as const;

export const LLM_RETRY_ATTEMPTS = 3;
export const LLM_RETRY_DELAYS_MS = [0, 1000, 2000] as const;

/** Single tool/LLM step idle timeout (§13.3). */
export const STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Screenshot capture slower than this enters throttle mode (§13.4). */
export const SCREENSHOT_SLOW_MS = 1000;

/** Minimum gap between non-forced screenshot emits while throttling. */
export const SCREENSHOT_THROTTLE_MS = 2500;

/** Heartbeat interval while waiting on LLM rate limits. */
export const LLM_HEARTBEAT_MS = 15_000;

export type ErrorKind =
  | 'browser_crash'
  | 'llm_rate_limit'
  | 'llm_transient'
  | 'step_timeout'
  | 'bad_url'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  fatal: boolean;
  recoverable: boolean;
  message: string;
}

function errText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function isBrowserCrashError(error: unknown): boolean {
  const text = errText(error).toLowerCase();
  return (
    text.includes('target closed') ||
    text.includes('browser has been closed') ||
    text.includes('browser disconnected') ||
    text.includes('page crashed') ||
    text.includes('session closed') ||
    text.includes('no live browser session') ||
    text.includes('no live stagehand session')
  );
}

/** Our link to the Steel browser dropped; the browser itself may still be alive. */
export function isBrowserConnectionLostError(error: unknown): boolean {
  const text = errText(error).toLowerCase();
  return (
    text.includes('rpc client is closed') ||
    text.includes('rpc client closed') ||
    text.includes('stagehand closed') ||
    text.includes('cdp connection closed') ||
    text.includes('cdp client is closed') ||
    text.includes('cdp connection is not open')
  );
}

export function isNonRetryableToolError(error: unknown): boolean {
  if (isBadUrlError(error) || isBrowserConnectionLostError(error)) {
    return true;
  }
  const text = errText(error).toLowerCase();
  return (
    text.includes('sensitive action blocked') ||
    text.includes('url not allowlisted')
  );
}

export function isLlmRateLimitError(error: unknown): boolean {
  const text = errText(error).toLowerCase();
  return (
    text.includes('resource_exhausted') ||
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('429') ||
    text.includes('too many requests')
  );
}

export function isLlmTransientError(error: unknown): boolean {
  if (isLlmRateLimitError(error)) {
    return true;
  }
  const text = errText(error).toLowerCase();
  return (
    text.includes('unavailable') ||
    text.includes('deadline') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('fetch failed') ||
    text.includes('503') ||
    text.includes('500') ||
    text.includes('internal error')
  );
}

export function isBadUrlError(error: unknown): boolean {
  const text = errText(error).toLowerCase();
  return (
    text.includes('allowlist') ||
    text.includes('invalid url') ||
    text.includes('net::err_') ||
    text.includes('navigation')
  );
}

export function classifyAgentError(error: unknown): ClassifiedError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = formatUserFacingErrorMessage(error);

  if (isBrowserCrashError(error)) {
    return {
      kind: 'browser_crash',
      fatal: true,
      recoverable: false,
      message,
    };
  }
  if (isLlmRateLimitError(error)) {
    return {
      kind: 'llm_rate_limit',
      fatal: false,
      recoverable: true,
      message,
    };
  }
  if (isLlmTransientError(error)) {
    return {
      kind: 'llm_transient',
      fatal: false,
      recoverable: true,
      message,
    };
  }
  if (isBadUrlError(error)) {
    return {
      kind: 'bad_url',
      fatal: false,
      recoverable: true,
      message,
    };
  }
  return {
    kind: 'unknown',
    fatal: false,
    recoverable: true,
    message: message || rawMessage,
  };
}

/**
 * Turn provider dumps (OpenAI rate limits, etc.) into short chat-friendly copy.
 */
export function formatUserFacingErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return humanizeErrorText(raw);
}

function humanizeErrorText(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return 'Something went wrong';
  }

  const quota = formatQuotaExceededMessage(text);
  if (quota) {
    return quota;
  }

  if (isLlmRateLimitError(text)) {
    const retrySec = extractRetrySeconds(text);
    return retrySec
      ? `AI rate limit reached. Please wait about ${retrySec} seconds and try again.`
      : 'AI rate limit reached. Please wait a moment and try again.';
  }

  if (isBrowserCrashError(text)) {
    return 'The browser session closed unexpectedly. Start the job again.';
  }

  if (isBadUrlError(text)) {
    return 'That page could not be opened. Check the URL or try a different site.';
  }

  const provider = formatProviderDumpMessage(text);
  if (provider) {
    return provider;
  }

  if (text.length > 280) {
    return `${text.slice(0, 220).trimEnd()}…`;
  }

  return text;
}

/** Map OpenAI-style dumps to a short, specific user message. */
function formatProviderDumpMessage(text: string): string | null {
  if (!looksLikeProviderDump(text)) {
    return null;
  }

  const lower = text.toLowerCase();
  const providerMessage = extractProviderErrorMessage(text);
  const suggestedModel =
    /use models\/([a-z0-9._-]+)/i.exec(text)?.[1] ??
    /please update your code to use ([a-z0-9._-]+)/i.exec(text)?.[1];
  const unavailableModel =
    /models\/([a-z0-9._-]+) is no longer available/i.exec(text)?.[1] ??
    /model[:\s]+([a-z0-9._-]+) is (?:no longer available|not found)/i.exec(
      text,
    )?.[1];

  if (
    lower.includes('no longer available') ||
    lower.includes('not_found') ||
    /^\s*404\b/.test(text)
  ) {
    if (unavailableModel && suggestedModel) {
      return `AI model "${unavailableModel}" is unavailable. Switch OPENAI_MODEL to "${suggestedModel}" and restart the API.`;
    }
    if (unavailableModel) {
      return `AI model "${unavailableModel}" is unavailable. Update OPENAI_MODEL in your .env and restart the API.`;
    }
    return 'The configured AI model was not found. Check OPENAI_MODEL and restart the API.';
  }

  if (
    lower.includes('api key') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission_denied') ||
    /^\s*401\b/.test(text) ||
    /^\s*403\b/.test(text)
  ) {
    return 'AI API key is invalid or missing permissions. Check OPENAI_API_KEY and restart the API.';
  }

  if (/^\s*400\b/.test(text) || lower.includes('invalid_argument')) {
    if (lower.includes('api key')) {
      return 'AI API key is invalid or missing permissions. Check OPENAI_API_KEY and restart the API.';
    }
    return providerMessage
      ? `AI request rejected: ${providerMessage}`
      : 'The AI provider rejected the request. Check the model name and API key.';
  }

  if (/^\s*5\d{2}\b/.test(text) || lower.includes('unavailable')) {
    return 'The AI provider is temporarily unavailable. Please try again in a moment.';
  }

  if (providerMessage) {
    const short =
      providerMessage.length > 180
        ? `${providerMessage.slice(0, 160).trimEnd()}…`
        : providerMessage;
    return `AI provider error: ${short}`;
  }

  return 'The AI provider returned an error. Please try again in a moment.';
}

function extractProviderErrorMessage(text: string): string | null {
  const fromJson =
    /"message"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(text)?.[1] ??
    /"message"\s*:\s*'((?:\\.|[^'\\])*)'/i.exec(text)?.[1];
  if (fromJson) {
    return fromJson
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return null;
}

function formatQuotaExceededMessage(text: string): string | null {
  const lower = text.toLowerCase();
  const isQuota =
    lower.includes('resource_exhausted') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('quota exceeded') ||
    (lower.includes('429') && lower.includes('quota'));
  if (!isQuota) {
    return null;
  }

  const model =
    /model:\s*([a-z0-9._-]+)/i.exec(text)?.[1] ??
    /"model"\s*:\s*"([^"]+)"/i.exec(text)?.[1];
  const limit = /limit:\s*(\d+)/i.exec(text)?.[1];
  const retrySec = extractRetrySeconds(text);
  const freeTier = /free[_ ]?tier/i.test(text);

  const parts = [
    freeTier
      ? 'AI free-tier quota exceeded'
      : 'AI quota exceeded',
  ];
  if (model) {
    parts[0] += ` for ${model}`;
  }
  if (limit) {
    parts.push(`limit ${limit} requests`);
  }

  let message = parts.join(' — ');
  if (retrySec) {
    message += `. Try again in about ${retrySec} seconds`;
  } else {
    message += '. Try again later';
  }
  message += ', or check your plan and billing.';
  return message;
}

export function extractRetrySeconds(error: unknown): number | null {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  const match =
    /retry in\s+(\d+(?:\.\d+)?)\s*s/i.exec(text) ??
    /retryDelay["\s:]+(\d+(?:\.\d+)?)s?/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const seconds = Math.ceil(Number.parseFloat(match[1]));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function looksLikeProviderDump(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith('{') && trimmed.includes('"error"')) ||
    /^\d{3}\s*\[/.test(trimmed) ||
    trimmed.includes('"@type":"type.googleapis.com/') ||
    trimmed.includes('generativelanguage.googleapis.com')
  );
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async factory up to N times with backoff when `shouldRetry` matches.
 */
export async function withLlmRetry<T>(
  factory: (attempt: number) => Promise<T>,
  opts?: {
    attempts?: number;
    delaysMs?: readonly number[];
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void | Promise<void>;
  },
): Promise<T> {
  const attempts = opts?.attempts ?? LLM_RETRY_ATTEMPTS;
  const delays = opts?.delaysMs ?? LLM_RETRY_DELAYS_MS;
  const shouldRetry = opts?.shouldRetry ?? isLlmTransientError;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    const delay = delays[i] ?? delays[delays.length - 1] ?? 0;
    if (delay > 0) {
      await opts?.onRetry?.(i, lastError, delay);
      await sleep(delay);
    }
    try {
      return await factory(i);
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err) && i < attempts - 1;
      if (!retryable) {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Drain an async generator, retrying the whole run on transient LLM failures.
 */
export async function* runWithLlmRetry<T>(
  factory: (attempt: number) => AsyncGenerator<T, void, undefined>,
  opts?: {
    attempts?: number;
    delaysMs?: readonly number[];
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (
      attempt: number,
      error: unknown,
      delayMs: number,
    ) => void | Promise<void | { handledDelay?: boolean }>;
    abortSignal?: AbortSignal;
  },
): AsyncGenerator<T, void, undefined> {
  const attempts = opts?.attempts ?? LLM_RETRY_ATTEMPTS;
  const delays = opts?.delaysMs ?? LLM_RETRY_DELAYS_MS;
  const shouldRetry = opts?.shouldRetry ?? isLlmTransientError;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    if (opts?.abortSignal?.aborted) {
      return;
    }
    const delay = delays[i] ?? delays[delays.length - 1] ?? 0;
    if (i > 0 && delay > 0) {
      const result = await opts?.onRetry?.(i, lastError, delay);
      if (!result?.handledDelay) {
        await sleep(delay);
      }
    }
    try {
      yield* factory(i);
      return;
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err) && i < attempts - 1;
      if (!retryable) {
        throw err;
      }
    }
  }
  throw lastError;
}
