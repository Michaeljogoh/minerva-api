import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '@modules/redis/redis.service';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  timestamp: number;
  checks: {
    api: { ok: true };
    postgres: { ok: boolean; latencyMs: number; error?: string };
    redis: {
      ok: boolean;
      latencyMs: number;
      error?: string;
      skipped?: boolean;
    };
  };
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      this.pingPostgres(),
      this.redis.ping(),
    ]);

    let status: HealthReport['status'] = 'ok';
    if (!postgres.ok) {
      status = redis.skipped || redis.ok ? 'degraded' : 'error';
      if (!redis.ok && !redis.skipped) {
        status = 'error';
      }
    } else if (!redis.ok && !redis.skipped) {
      status = 'degraded';
    }

    return {
      status,
      timestamp: Date.now(),
      checks: {
        api: { ok: true },
        postgres,
        redis,
      },
    };
  }

  private async pingPostgres(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
  }> {
    const started = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
