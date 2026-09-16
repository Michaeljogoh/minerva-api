import { UrlAllowlistService } from './url-allowlist.service';
import { RateLimitService } from './rate-limit.service';
import { looksSensitiveAction } from './sensitive-action';

describe('UrlAllowlistService', () => {
  const config = {
    get: (key: string) => {
      const map: Record<string, unknown> = {
        'security.urlAllowlist': ['irs.gov', 'www.irs.gov'],
      };
      return map[key];
    },
  };

  const service = new UrlAllowlistService(config as never);

  it('allows IRS hosts', () => {
    expect(service.isUrlAllowed('https://www.irs.gov/path')).toBe(true);
    expect(service.isUrlAllowed('https://irs.gov/')).toBe(true);
  });

  it('blocks unknown hosts', () => {
    expect(service.isUrlAllowed('https://evil.example.com')).toBe(false);
    expect(service.isUrlAllowed('https://abc.ngrok-free.app/x')).toBe(false);
  });
});

describe('RateLimitService', () => {
  const config = {
    get: (key: string) => {
      if (key === 'security.maxSessionsPerIp') return 2;
      if (key === 'security.maxActionsPerSession') return 3;
      return undefined;
    },
  };
  const service = new RateLimitService(config as never);

  it('enforces concurrent sessions per IP', () => {
    service.assertCanStartSession('1.1.1.1', 's1');
    service.assertCanStartSession('1.1.1.1', 's2');
    expect(() => service.assertCanStartSession('1.1.1.1', 's3')).toThrow(
      /max 2 concurrent/,
    );
  });

  it('enforces actions per session', () => {
    service.assertCanStartSession('2.2.2.2', 'a1');
    service.assertCanPerformAction('a1');
    service.assertCanPerformAction('a1');
    service.assertCanPerformAction('a1');
    expect(() => service.assertCanPerformAction('a1')).toThrow(/max 3 actions/);
  });
});

describe('looksSensitiveAction', () => {
  it('flags submit/pay/categorize instructions', () => {
    expect(looksSensitiveAction('Click Submit to post')).toBe(true);
    expect(looksSensitiveAction('Confirm payment')).toBe(true);
    expect(looksSensitiveAction('Scroll down')).toBe(false);
  });

  it('avoids false positives on profile/file wording', () => {
    expect(looksSensitiveAction('Scroll to the profile section')).toBe(false);
    expect(looksSensitiveAction('file the tax return')).toBe(true);
    expect(looksSensitiveAction('send payment to vendor')).toBe(true);
    expect(looksSensitiveAction('send keys to the input field')).toBe(false);
  });
});
