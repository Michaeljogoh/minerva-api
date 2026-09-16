import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Browserbase from '@browserbasehq/sdk';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import type { StagehandBrowser } from '@browserbasehq/stagehand';
import { STAGEHAND_MODEL } from '@common/constants/agent.constants';
import { SessionRecordEntity } from '@modules/persistence/entities/session-record.entity';
import type { BrowserSession } from './browser-session.types';

type StagehandModule = typeof import('@browserbasehq/stagehand');

let stagehandModulePromise: Promise<StagehandModule> | null = null;

function loadStagehandModule(): Promise<StagehandModule> {
  if (!stagehandModulePromise) {
    stagehandModulePromise = import('@browserbasehq/stagehand');
  }
  return stagehandModulePromise;
}

export interface CreatedBrowserSession {
  browserbaseSessionId: string;
  recordId: string;
  live: BrowserSession;
}

@Injectable()
export class BrowserSessionFactory {
  private readonly logger = new Logger(BrowserSessionFactory.name);
  private client: Browserbase | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(SessionRecordEntity)
    private readonly sessionsRepo: Repository<SessionRecordEntity>,
  ) {}

  async create(clientId: string, goal: string): Promise<CreatedBrowserSession> {
    const projectId = this.config.get<string>('browserbase.projectId') ?? '';
    if (!projectId) {
      throw new Error('BROWSERBASE_PROJECT_ID is required to create browser sessions');
    }

    const apiKey = this.config.get<string>('browserbase.apiKey') ?? '';
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY is required to create browser sessions');
    }

    const bb = this.getClient();
    const createdAt = new Date();

    const record = this.sessionsRepo.create({
      id: randomUUID(),
      goal: goal || '(pending)',
      taskType: null,
      status: 'running',
      startedAt: createdAt,
      endedAt: null,
      steps: [],
      result: null,
      error: null,
    });
    await this.sessionsRepo.save(record);

    let browserHandle: StagehandBrowser | null = null;
    let browserbaseSessionId = '';

    try {
      const { browserbase, Stagehand } = await loadStagehandModule();
      browserHandle = await browserbase.launch({
        apiKey,
        projectId,
      });
      browserbaseSessionId = browserHandle.sessionId ?? '';
      if (!browserbaseSessionId) {
        throw new Error('Browserbase launch did not return a session ID');
      }

      const stagehand = await Stagehand.create({
        browser: browserHandle,
        model: {
          modelName: STAGEHAND_MODEL,
          apiKey: this.geminiApiKey(),
        },
        cache: { threshold: 1 },
        logging: { level: 'warn', format: 'json' },
      });

      const pages = await browserHandle.context.pages();
      const page = pages[0] ?? (await browserHandle.context.newPage());

      const live: BrowserSession = {
        stagehand,
        browserHandle,
        page,
        sessionId: browserbaseSessionId,
        createdAt,
        recordId: record.id,
      };

      this.logger.log(
        `Browserbase session ${browserbaseSessionId} created for client ${clientId} (stagehand)`,
      );

      return {
        browserbaseSessionId,
        recordId: record.id,
        live,
      };
    } catch (err) {
      this.logger.error(
        `Stagehand connect failed for client ${clientId}, rolling back BB session ${browserbaseSessionId || 'unknown'}`,
      );
      if (browserHandle) {
        try {
          await browserHandle.close();
        } catch (closeErr) {
          this.logger.warn(
            `Failed to close browser handle for ${clientId}: ${String(closeErr)}`,
          );
        }
      }
      if (browserbaseSessionId) {
        await this.rollback(bb, browserbaseSessionId, record.id);
      } else {
        try {
          await this.sessionsRepo.delete(record.id);
        } catch (dbErr) {
          this.logger.warn(
            `Failed to delete SessionRecord ${record.id}: ${String(dbErr)}`,
          );
        }
      }
      throw err;
    }
  }

  async rollback(
    bb: Browserbase,
    browserbaseSessionId: string,
    recordId: string,
  ): Promise<void> {
    try {
      await bb.sessions.update(browserbaseSessionId, {
        status: 'REQUEST_RELEASE',
      });
    } catch (releaseErr) {
      this.logger.warn(
        `Failed to release Browserbase session ${browserbaseSessionId}: ${String(releaseErr)}`,
      );
    }
    try {
      await this.sessionsRepo.delete(recordId);
    } catch (dbErr) {
      this.logger.warn(
        `Failed to delete SessionRecord ${recordId}: ${String(dbErr)}`,
      );
    }
  }

  async finalizeRecord(
    recordId: string,
    opts?: { status?: 'complete' | 'stopped' | 'error'; error?: string },
  ): Promise<void> {
    try {
      await this.sessionsRepo.update(recordId, {
        status: opts?.status ?? 'stopped',
        endedAt: new Date(),
        error: opts?.error ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to finalize SessionRecord ${recordId}: ${String(err)}`,
      );
    }
  }

  getBrowserbaseClient(): Browserbase {
    return this.getClient();
  }

  private getClient(): Browserbase {
    if (this.client) {
      return this.client;
    }
    const apiKey = this.config.get<string>('browserbase.apiKey') ?? '';
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY is required to create browser sessions');
    }
    this.client = new Browserbase({ apiKey });
    return this.client;
  }

  private geminiApiKey(): string {
    const key = this.config.get<string>('gemini.apiKey') ?? '';
    if (!key) {
      throw new Error('GEMINI_API_KEY is required for Stagehand browser sessions');
    }
    return key;
  }
}
