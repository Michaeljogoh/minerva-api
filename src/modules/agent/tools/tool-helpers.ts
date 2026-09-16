import {
  TOOL_RETRY_ATTEMPTS,
  TOOL_RETRY_DELAYS_MS,
} from '../recovery/error-recovery';

export type ToolResult = {
  success: boolean;
  observation: string;
  error?: string;
  [key: string]: unknown;
};

export interface WithRetryOptions {
  attempts?: number;
  delaysMs?: number[];
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? TOOL_RETRY_ATTEMPTS;
  const delaysMs = opts.delaysMs ?? [...TOOL_RETRY_DELAYS_MS];
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    const delay = delaysMs[i] ?? delaysMs[delaysMs.length - 1] ?? 0;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}

export function truncateContent(content: string, max = 8000): string {
  if (content.length <= max) {
    return content;
  }
  return `${content.slice(0, max)}…[truncated]`;
}

export function fail(observation: string, error: unknown): ToolResult {
  return {
    success: false,
    observation,
    error: error instanceof Error ? error.message : String(error),
  };
}
