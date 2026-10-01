import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared ioredis client for optional live session keys / health pings.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private lastError: string | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.enabled = this.config.get<boolean>('redis.enabled') ?? false;
    if (!this.enabled) {
      this.logger.log('Redis disabled (REDIS_ENABLED=false); using in-memory session store');
      return;
    }

    const url = this.config.get<string>('redis.url') ?? 'redis://localhost:6379';
    this.warnIfUrlLooksBroken(url);
    const password = this.config.get<string>('redis.password') ?? '';

    this.client = new Redis(url, {
      password: password || undefined,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });

    this.client.on('error', (err) => {
      this.lastError = err.message;
      this.logger.warn(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getClient(): Redis {
    if (!this.enabled || !this.client) {
      throw new Error('Redis is not enabled or client not initialized');
    }
    return this.client;
  }

  tryGetClient(): Redis | null {
    if (!this.enabled || !this.client) {
      return null;
    }
    return this.client;
  }

  private async ensureConnected(): Promise<Redis | null> {
    const client = this.tryGetClient();
    if (!client) {
      return null;
    }
    if (client.status === 'wait') {
      await client.connect();
    }
    return client;
  }

  async ping(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
    skipped?: boolean;
  }> {
    if (!this.enabled) {
      return { ok: true, latencyMs: 0, skipped: true };
    }

    const started = Date.now();
    try {
      const client = await this.ensureConnected();
      if (!client || client.status !== 'ready') {
        throw new Error(this.lastError ?? 'Redis not connected');
      }
      const pong = await client.ping();
      return {
        ok: pong === 'PONG',
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.lastError = error;
      return { ok: false, latencyMs: Date.now() - started, error };
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private warnIfUrlLooksBroken(url: string): void {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const local =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'redis';
      if (!local && !host.includes('.')) {
        this.logger.warn(
          `REDIS_URL host "${host}" is not a resolvable hostname. Use redis://localhost:6379 for local Docker Redis.`,
        );
      }
    } catch {
      this.logger.warn('REDIS_URL is not a valid URL. Expected redis://localhost:6379');
    }
  }
}
