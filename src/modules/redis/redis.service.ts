import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared ioredis client for live session keys / health pings (§5.3 / B1).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private lastError: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('redis.url') ?? 'redis://localhost:6379';
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

  getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client;
  }

  private async ensureConnected(): Promise<Redis> {
    const client = this.getClient();
    if (client.status === 'wait') {
      await client.connect();
    }
    return client;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const client = await this.ensureConnected();
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
}
