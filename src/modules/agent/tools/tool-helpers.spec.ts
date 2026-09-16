import {
  fail,
  truncateContent,
  withRetry,
} from './tool-helpers';
import { isNonRetryableToolError } from '../recovery/error-recovery';

describe('tool-helpers', () => {
  it('truncates long content', () => {
    const out = truncateContent('a'.repeat(10), 5);
    expect(out.startsWith('aaaaa')).toBe(true);
    expect(out).toContain('truncated');
  });

  it('retries then succeeds', async () => {
    let n = 0;
    const value = await withRetry(async () => {
      n += 1;
      if (n < 3) {
        throw new Error('fail');
      }
      return 'ok';
    }, { delaysMs: [0, 0, 0] });
    expect(value).toBe('ok');
    expect(n).toBe(3);
  });

  it('fail helper shapes errors', () => {
    const result = fail('oops', new Error('boom'));
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('does not retry non-retryable tool errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new Error('URL not allowlisted: https://evil.com');
        },
        {
          delaysMs: [0, 0, 0],
          shouldRetry: (e) => !isNonRetryableToolError(e),
        },
      ),
    ).rejects.toThrow(/allowlisted/);
    expect(n).toBe(1);
  });
});
