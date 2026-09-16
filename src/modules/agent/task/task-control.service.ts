import { Injectable } from '@nestjs/common';

interface ClientControl {
  paused: boolean;
  pauseWaiters: Array<() => void>;
  guidanceQueue: string[];
  abort?: AbortController;
}

/**
 * Per-client pause / resume / stop / inject_guidance for the agent loop.
 */
@Injectable()
export class TaskControlService {
  private readonly byClient = new Map<string, ClientControl>();

  private ensure(clientId: string): ClientControl {
    let state = this.byClient.get(clientId);
    if (!state) {
      state = { paused: false, pauseWaiters: [], guidanceQueue: [] };
      this.byClient.set(clientId, state);
    }
    return state;
  }

  beginRun(clientId: string): AbortSignal {
    this.clear(clientId);
    const state = this.ensure(clientId);
    state.abort = new AbortController();
    return state.abort.signal;
  }

  getAbortSignal(clientId: string): AbortSignal | undefined {
    return this.byClient.get(clientId)?.abort?.signal;
  }

  pause(clientId: string): void {
    this.ensure(clientId).paused = true;
  }

  resume(clientId: string): void {
    const state = this.byClient.get(clientId);
    if (!state) {
      return;
    }
    state.paused = false;
    const waiters = state.pauseWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** Block until resumed or aborted (used from beforeToolCallback). */
  async waitIfPaused(clientId: string): Promise<void> {
    const state = this.byClient.get(clientId);
    if (!state?.paused) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error('Task aborted while paused'));
      };
      const signal = state.abort?.signal;
      if (signal?.aborted) {
        reject(new Error('Task aborted while paused'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      state.pauseWaiters.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  stop(clientId: string): void {
    const state = this.byClient.get(clientId);
    if (!state) {
      return;
    }
    state.paused = false;
    const waiters = state.pauseWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
    state.abort?.abort();
  }

  queueGuidance(clientId: string, message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    this.ensure(clientId).guidanceQueue.push(trimmed);
  }

  /** Drain queued guidance as a single string (or null). */
  drainGuidance(clientId: string): string | null {
    const state = this.byClient.get(clientId);
    if (!state || state.guidanceQueue.length === 0) {
      return null;
    }
    const text = state.guidanceQueue.splice(0).join('\n');
    return text || null;
  }

  isPaused(clientId: string): boolean {
    return this.byClient.get(clientId)?.paused === true;
  }

  clear(clientId: string): void {
    const state = this.byClient.get(clientId);
    if (!state) {
      return;
    }
    state.paused = false;
    const waiters = state.pauseWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
    this.byClient.delete(clientId);
  }
}
