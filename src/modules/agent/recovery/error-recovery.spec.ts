import {
  classifyAgentError,
  isBrowserCrashError,
  isLlmRateLimitError,
  isLlmTransientError,
  runWithLlmRetry,
  withLlmRetry,
} from './error-recovery';

describe('error-recovery', () => {
  it('classifies browser crash as fatal', () => {
    const c = classifyAgentError(new Error('Target closed'));
    expect(c.kind).toBe('browser_crash');
    expect(c.fatal).toBe(true);
  });

  it('classifies rate limit as recoverable', () => {
    expect(isLlmRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    const c = classifyAgentError(new Error('RESOURCE_EXHAUSTED'));
    expect(c.kind).toBe('llm_rate_limit');
    expect(c.recoverable).toBe(true);
  });

  it('retries transient LLM errors then succeeds', async () => {
    let n = 0;
    const value = await withLlmRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw new Error('503 unavailable');
        }
        return 'ok';
      },
      { delaysMs: [0, 0, 0] },
    );
    expect(value).toBe('ok');
    expect(n).toBe(3);
  });

  it('runWithLlmRetry restarts generator after transient failure', async () => {
    let attempts = 0;
    const out: number[] = [];
    for await (const n of runWithLlmRetry(
      async function* (attempt) {
        attempts = attempt + 1;
        if (attempt === 0) {
          throw new Error('fetch failed');
        }
        yield 1;
        yield 2;
      },
      { delaysMs: [0, 0, 0], shouldRetry: isLlmTransientError },
    )) {
      out.push(n);
    }
    expect(attempts).toBe(2);
    expect(out).toEqual([1, 2]);
  });

  it('detects browser crash helpers', () => {
    expect(isBrowserCrashError(new Error('Browser has been closed'))).toBe(
      true,
    );
    expect(
      isBrowserCrashError(new Error('No live Stagehand session for client x')),
    ).toBe(true);
    expect(isBrowserCrashError(new Error('click timeout'))).toBe(false);
  });
});
