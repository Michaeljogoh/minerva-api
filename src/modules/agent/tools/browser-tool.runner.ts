import { isNonRetryableToolError } from '../recovery/error-recovery';
import { withRetry, type ToolResult } from './tool-helpers';

export type BrowserToolRunnerCtx = {
  requireClientId: () => string;
  assertPageAllowed: () => Promise<void>;
  assertCanPerformAction: (clientId: string) => void;
  captureAfterAction: (
    clientId: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
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
    if (opts.requireAllowlistedPage !== false) {
      await ctx.assertPageAllowed();
    }
    const result = await opts.action();
    if (opts.captureOnSuccess !== false) {
      await ctx.captureAfterAction(clientId);
    }
    return result;
  } catch (error) {
    await ctx.captureAfterAction(clientId, { force: true });
    return ctx.toolFail(clientId, opts.failObservation, error);
  }
}

export async function runWithToolRetry<T>(
  fn: () => Promise<T>,
  shouldRetry = defaultToolShouldRetry,
): Promise<T> {
  return withRetry(fn, { shouldRetry });
}
