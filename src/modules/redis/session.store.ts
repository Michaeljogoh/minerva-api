import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

export interface LiveSessionMeta {
  clientId: string;
  browserSessionId: string;
  liveUrl: string;
  createdAt: string; // ISO
}

/**
 * Live session metadata (Steel ids + live view URL).
 * In-process Map for sync access + optional Redis mirror with TTL.
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

  async getBrowserContextId(ownerKey: string): Promise<string | null> {
    const client = this.redis.tryGetClient();
    if (!client) {
      return this.readContextFile(ownerKey);
    }
    try {
      if (client.status === 'wait') {
        await client.connect();
      }
      if (client.status === 'ready') {
        const fromRedis = await client.get(`bb-context:${ownerKey}`);
        if (fromRedis) {
          return fromRedis;
        }
      }
    } catch {
      // Fall through to the on-disk copy.
    }
    return this.readContextFile(ownerKey);
  }

  async setBrowserContextId(
    ownerKey: string,
    contextId: string,
  ): Promise<void> {
    this.writeContextFile(ownerKey, contextId);
    const client = this.redis.tryGetClient();
    if (!client) {
      return;
    }
    try {
      if (client.status === 'wait') {
        await client.connect();
      }
      if (client.status !== 'ready') {
        return;
      }
      await client.set(`bb-context:${ownerKey}`, contextId);
    } catch {
      // File copy is enough if Redis is down.
    }
  }

  private contextFilePath(ownerKey: string): string {
    const safe = ownerKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(process.cwd(), '.data', `bb-context-${safe}`);
  }

  private readContextFile(ownerKey: string): string | null {
    try {
      const file = this.contextFilePath(ownerKey);
      if (!existsSync(file)) {
        return null;
      }
      const id = readFileSync(file, 'utf8').trim();
      return id || null;
    } catch {
      return null;
    }
  }

  private writeContextFile(ownerKey: string, contextId: string): void {
    try {
      const file = this.contextFilePath(ownerKey);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contextId, 'utf8');
    } catch {
      // Redis may still hold the id.
    }
  }

  private async mirrorSet(
    clientId: string,
    meta: LiveSessionMeta,
  ): Promise<void> {
    const client = this.redis.tryGetClient();
    if (!client) {
      return;
    }
    try {
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
    const client = this.redis.tryGetClient();
    if (!client) {
      return;
    }
    try {
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
