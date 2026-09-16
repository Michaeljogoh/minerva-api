import {
  runBrowserTool,
  runWithToolRetry,
} from './browser-tool.runner';
import { fail } from './tool-helpers';

describe('browser-tool.runner', () => {
  const ctx = {
    requireClientId: () => 'client-1',
    assertPageAllowed: async () => {},
    assertCanPerformAction: () => {},
    captureAfterAction: jest.fn(async () => {}),
    toolFail: (clientId: string, observation: string, error: unknown) =>
      fail(observation, error),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs action and captures on success', async () => {
    const result = await runBrowserTool(ctx, {
      failObservation: 'failed',
      action: async () => ({
        success: true,
        observation: 'ok',
      }),
    });
    expect(result.success).toBe(true);
    expect(ctx.captureAfterAction).toHaveBeenCalledWith('client-1');
  });

  it('captures on failure and returns toolFail shape', async () => {
    const result = await runBrowserTool(ctx, {
      failObservation: 'tool broke',
      action: async () => {
        throw new Error('boom');
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(ctx.captureAfterAction).toHaveBeenCalledWith('client-1', {
      force: true,
    });
  });

  it('runWithToolRetry stops on non-retryable errors', async () => {
    let n = 0;
    await expect(
      runWithToolRetry(async () => {
        n += 1;
        throw new Error('URL not allowlisted');
      }),
    ).rejects.toThrow(/allowlisted/);
    expect(n).toBe(1);
  });
});
