import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

export interface LiveSessionMeta {
  clientId: string;
  browserbaseSessionId: string;
  createdAt: string; // ISO
}

/**
 * Live session metadata (Browserbase ids).
 * In-process Map for sync access + Redis mirror with TTL (§6 / B1).
 */
@Injectable()
export class SessionStore {
  private readonly sessions = new Map<string, LiveSessionMeta>();

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  getTtlSeconds(): number {
    return this.config.get<number>('redis.sessionTtlSeconds') ?? 3600;
  }

  set(clientId: string, meta: LiveSessionMeta): void {
    this.sessions.set(clientId, meta);
    void this.mirrorSet(clientId, meta);
  }

  get(clientId: string): LiveSessionMeta | undefined {
    return this.sessions.get(clientId);
  }

  delete(clientId: string): void {
    this.sessions.delete(clientId);
    void this.mirrorDelete(clientId);
  }

  has(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  private async mirrorSet(
    clientId: string,
    meta: LiveSessionMeta,
  ): Promise<void> {
    try {
      const client = this.redis.getClient();
      if (client.status === 'wait') {
        await client.connect();
      }
      if (client.status !== 'ready') {
        return;
      }
      await client.set(
        `session:${clientId}`,
        JSON.stringify(meta),
        'EX',
        this.getTtlSeconds(),
      );
    } catch {
      // Hot path stays on in-memory Map if Redis is down.
    }
  }

  private async mirrorDelete(clientId: string): Promise<void> {
    try {
      const client = this.redis.getClient();
      if (client.status === 'wait') {
        await client.connect();
      }
      if (client.status !== 'ready') {
        return;
      }
      await client.del(`session:${clientId}`);
    } catch {
      // ignore
    }
  }
}
