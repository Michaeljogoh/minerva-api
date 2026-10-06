import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * In-memory rate limits for MVP. Swap counters to Redis SessionStore later (§6 / redis).
 */
@Injectable()
export class RateLimitService {
  private readonly sessionsByIp = new Map<string, Set<string>>();
  private readonly actionsBySession = new Map<string, number>();
  private readonly keyChecksByIp = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  private get maxKeyChecksPerMinute(): number {
    return this.config.get<number>('security.maxKeyChecksPerMinute') ?? 10;
  }

  /** Sliding one-minute window so the key check can't be used to test keys in bulk. */
  assertCanCheckModelKey(ip: string): void {
    const key = ip || 'unknown';
    const now = Date.now();
    const recent = (this.keyChecksByIp.get(key) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= this.maxKeyChecksPerMinute) {
      this.keyChecksByIp.set(key, recent);
      throw new Error('Too many key checks. Wait a minute and try again.');
    }
    recent.push(now);
    this.keyChecksByIp.set(key, recent);
  }

  private get maxSessionsPerIp(): number {
    return this.config.get<number>('security.maxSessionsPerIp') ?? 5;
  }

  private get maxActionsPerSession(): number {
    return this.config.get<number>('security.maxActionsPerSession') ?? 100;
  }

  /** Register a new session for an IP. Throws if over the concurrent limit. */
  assertCanStartSession(ip: string, sessionKey: string): void {
    const key = ip || 'unknown';
    let set = this.sessionsByIp.get(key);
    if (!set) {
      set = new Set();
      this.sessionsByIp.set(key, set);
    }
    if (!set.has(sessionKey) && set.size >= this.maxSessionsPerIp) {
      throw new Error(
        `Rate limit: max ${this.maxSessionsPerIp} concurrent sessions per IP`,
      );
    }
    set.add(sessionKey);
    this.actionsBySession.set(sessionKey, 0);
  }

  releaseSession(ip: string, sessionKey: string): void {
    const key = ip || 'unknown';
    this.sessionsByIp.get(key)?.delete(sessionKey);
    this.actionsBySession.delete(sessionKey);
  }

  /** Call before each tool action. Throws if session exceeds action cap. */
  assertCanPerformAction(sessionKey: string): void {
    const current = this.actionsBySession.get(sessionKey) ?? 0;
    if (current >= this.maxActionsPerSession) {
      throw new Error(
        `Rate limit: max ${this.maxActionsPerSession} actions per session`,
      );
    }
    this.actionsBySession.set(sessionKey, current + 1);
  }

  getActionCount(sessionKey: string): number {
    return this.actionsBySession.get(sessionKey) ?? 0;
  }
}
