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

export function isNonRetryableToolError(error: unknown): boolean {
  if (isBadUrlError(error)) {
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
  const message = error instanceof Error ? error.message : String(error);

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
    message,
  };
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
