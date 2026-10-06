import {
  isBrowserConnectionLostError,
  isNonRetryableToolError,
} from '../recovery/error-recovery';
import { withRetry, type ToolResult } from './tool-helpers';

export type BrowserToolRunnerCtx = {
  requireClientId: () => string;
  assertPageAllowed: () => Promise<void>;
  assertCanPerformAction: (clientId: string) => void;
  captureAfterAction: (
    clientId: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  reconnect: (clientId: string) => Promise<void>;
  toolFail: (clientId: string, observation: string, error: unknown) => ToolResult;
};

export const defaultToolShouldRetry = (error: unknown) =>
  !isNonRetryableToolError(error);

export async function runBrowserTool<T extends ToolResult>(
  ctx: BrowserToolRunnerCtx,
  opts: {
    failObservation: string;
    requireAllowlistedPage?: boolean;
    captureOnSuccess?: boolean;
    action: () => Promise<T>;
  },
): Promise<ToolResult> {
  const clientId = ctx.requireClientId();
  try {
    ctx.assertCanPerformAction(clientId);
    const result = await withBrowserReconnect(ctx, clientId, async () => {
      if (opts.requireAllowlistedPage !== false) {
        await ctx.assertPageAllowed();
      }
      return opts.action();
    });
    if (opts.captureOnSuccess !== false) {
      await ctx.captureAfterAction(clientId);
    }
    return result;
  } catch (error) {
    await ctx.captureAfterAction(clientId, { force: true });
    return ctx.toolFail(clientId, opts.failObservation, error);
  }
}

/** Steel can drop an idle CDP socket (e.g. during a long approval wait); rebuild it once and rerun. */
async function withBrowserReconnect<T>(
  ctx: BrowserToolRunnerCtx,
  clientId: string,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!isBrowserConnectionLostError(error)) {
      throw error;
    }
    await ctx.reconnect(clientId);
    return step();
  }
}

export async function runWithToolRetry<T>(
  fn: () => Promise<T>,
  shouldRetry = defaultToolShouldRetry,
): Promise<T> {
  return withRetry(fn, { shouldRetry });
}
