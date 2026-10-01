import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type {
  Page as StagehandPage,
  Stagehand,
} from '@browserbasehq/stagehand';
import { SessionStore } from '@modules/redis/session.store';
import { BROWSER_DEFERRED_CLOSE_MS } from '@common/constants/session-lifecycle.constants';
import { BrowserSessionFactory } from './browser-session.factory';
import { BrowserSessionRegistry } from './browser-session.registry';
import type { BrowserCloseOpts, BrowserSession } from './browser-session.types';
import { ScreenshotStore } from './screenshot.store';

export type { BrowserSession } from './browser-session.types';

@Injectable()
export class BrowserSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserSessionManager.name);

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly screenshotStore: ScreenshotStore,
    private readonly registry: BrowserSessionRegistry,
    private readonly factory: BrowserSessionFactory,
  ) {}

  async createBrowserSession(
    clientId: string,
    goal = '',
  ): Promise<{ sessionId: string; liveUrl: string }> {
    if (this.registry.has(clientId)) {
      await this.closeBrowserSession(clientId);
    }
    this.registry.cancelDeferredClose(clientId);

    const created = await this.factory.create(clientId, goal);
    this.registry.set(clientId, created.live);

    this.sessionStore.set(clientId, {
      clientId,
      browserSessionId: created.browserSessionId,
      liveUrl: created.liveUrl,
      createdAt: created.live.createdAt.toISOString(),
    });

    return {
      sessionId: created.browserSessionId,
      liveUrl: created.liveUrl,
    };
  }

  hasLiveSession(clientId: string): boolean {
    return this.registry.has(clientId);
  }

  hasDeferredClose(clientId: string): boolean {
    return this.registry.hasDeferredClose(clientId);
  }

  scheduleDeferredClose(
    clientId: string,
    delayMs = BROWSER_DEFERRED_CLOSE_MS,
    opts?: BrowserCloseOpts,
  ): void {
    this.registry.scheduleDeferredClose(clientId, delayMs, (closeOpts) =>
      this.closeBrowserSession(clientId, closeOpts ?? opts),
    );
  }

  getStagehand(clientId: string): Stagehand {
    const live = this.requireLive(clientId);
    return live.stagehand;
  }

  getStagehandPage(clientId: string): StagehandPage {
    const live = this.requireLive(clientId);
    return live.page;
  }

  getBrowserSession(clientId: string): BrowserSession | undefined {
    return this.registry.get(clientId);
  }

  getLiveSessionUrl(clientId: string): string {
    const fromLive = this.registry.get(clientId)?.liveUrl;
    if (fromLive) {
      return fromLive;
    }
    return this.sessionStore.get(clientId)?.liveUrl ?? '';
  }

  async closeBrowserSession(
    clientId: string,
    opts?: BrowserCloseOpts,
  ): Promise<void> {
    this.registry.cancelDeferredClose(clientId);
    const live = this.registry.delete(clientId);
    if (!live) {
      this.sessionStore.delete(clientId);
      return;
    }

    try {
      await live.stagehand.close();
      await live.browserHandle.close();
    } catch (err) {
      this.logger.warn(
        `Error closing browser for ${clientId}: ${String(err)}`,
      );
    }

    await this.factory.releaseSteelSession(live.sessionId);

    this.sessionStore.delete(clientId);
    this.screenshotStore.clearClient(clientId);
    await this.factory.finalizeRecord(live.recordId, opts);

    this.logger.log(
      `Steel session ${live.sessionId} closed for client ${clientId}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.registry.clientIds().map((id) =>
        this.closeBrowserSession(id, { status: 'stopped' }),
      ),
    );
  }

  private requireLive(clientId: string): BrowserSession {
    const live = this.registry.get(clientId);
    if (!live) {
      throw new Error(`No live Stagehand session for client ${clientId}`);
    }
    return live;
  }
}
