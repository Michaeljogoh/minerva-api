import { Injectable } from '@nestjs/common';
import type { BrowserCloseOpts, BrowserSession } from './browser-session.types';

@Injectable()
export class BrowserSessionRegistry {
  private readonly live = new Map<string, BrowserSession>();
  private readonly deferredCloseTimers = new Map<string, NodeJS.Timeout>();

  get(clientId: string): BrowserSession | undefined {
    return this.live.get(clientId);
  }

  set(clientId: string, session: BrowserSession): void {
    this.live.set(clientId, session);
  }

  delete(clientId: string): BrowserSession | undefined {
    const live = this.live.get(clientId);
    this.live.delete(clientId);
    return live;
  }

  has(clientId: string): boolean {
    return this.live.has(clientId);
  }

  clientIds(): string[] {
    return [...this.live.keys()];
  }

  hasDeferredClose(clientId: string): boolean {
    return this.deferredCloseTimers.has(clientId);
  }

  scheduleDeferredClose(
    clientId: string,
    delayMs: number,
    onClose: (opts?: BrowserCloseOpts) => void | Promise<void>,
    opts?: BrowserCloseOpts,
  ): void {
    this.cancelDeferredClose(clientId);
    const timer = setTimeout(() => {
      this.deferredCloseTimers.delete(clientId);
      void onClose(opts);
    }, delayMs);
    this.deferredCloseTimers.set(clientId, timer);
  }

  cancelDeferredClose(clientId: string): void {
    const timer = this.deferredCloseTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.deferredCloseTimers.delete(clientId);
    }
  }
}
