import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type {
  Page as StagehandPage,
  Stagehand,
} from '@browserbasehq/stagehand';
import type { ExternalModelConfig } from '@modules/model/external-model.types';
import { SessionStore } from '@modules/redis/session.store';
import { BROWSER_DEFERRED_CLOSE_MS } from '@common/constants/session-lifecycle.constants';
import { BrowserSessionFactory } from './browser-session.factory';
import { BrowserSessionRegistry } from './browser-session.registry';
import type { BrowserCloseOpts, BrowserSession } from './browser-session.types';
import { ScreenshotStore } from './screenshot.store';
import { isBrowserConnectionLostError } from '@modules/agent/recovery/error-recovery';

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
    externalModel: ExternalModelConfig | null = null,
  ): Promise<{ sessionId: string; liveUrl: string }> {
    if (this.registry.has(clientId)) {
      await this.closeBrowserSession(clientId);
    }
    this.registry.cancelDeferredClose(clientId);

    const created = await this.factory.create(clientId, goal, externalModel);
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

  /**
   * Re-attach Stagehand to the same Steel browser after its connection dropped.
   * The Steel session (tabs, page state) survives; only our link to it is rebuilt.
   */
  async reconnect(clientId: string): Promise<void> {
    const live = this.requireLive(clientId);
    await this.closeQuietly(clientId, 'Stagehand', () =>
      live.stagehand.close(),
    );
    await this.closeQuietly(clientId, 'browser', () =>
      live.browserHandle.close(),
    );

    const connection = await this.factory.connect(live.connectTarget);
    this.registry.set(clientId, { ...live, ...connection });
    this.logger.log(
      `Reconnected Stagehand to Steel session ${live.sessionId} for client ${clientId}`,
    );
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

    await this.closeQuietly(clientId, 'Stagehand', () =>
      live.stagehand.close(),
    );
    await this.closeQuietly(clientId, 'browser', () =>
      live.browserHandle.close(),
    );

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

  /** A connection that already dropped has nothing left to close; anything else is logged. */
  private async closeQuietly(
    clientId: string,
    label: string,
    close: () => Promise<void>,
  ): Promise<void> {
    try {
      await close();
    } catch (err) {
      if (isBrowserConnectionLostError(err)) {
        return;
      }
      this.logger.warn(
        `Error closing ${label} for ${clientId}: ${String(err)}`,
      );
    }
  }

  private requireLive(clientId: string): BrowserSession {
    const live = this.registry.get(clientId);
    if (!live) {
      throw new Error(`No live Stagehand session for client ${clientId}`);
    }
    return live;
  }
}
