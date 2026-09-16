import { BrowserSessionRegistry } from './browser-session.registry';

describe('BrowserSessionRegistry', () => {
  it('tracks live sessions and deferred close timers', () => {
    const registry = new BrowserSessionRegistry();
    const closed: string[] = [];

    registry.set('c1', {
      stagehand: {} as never,
      browserHandle: {} as never,
      page: {} as never,
      sessionId: 'bb-1',
      createdAt: new Date(),
      recordId: 'rec-1',
    });

    expect(registry.has('c1')).toBe(true);
    registry.scheduleDeferredClose('c1', 10, (opts) => {
      closed.push(opts?.status ?? 'unknown');
    });
    expect(registry.hasDeferredClose('c1')).toBe(true);

    registry.cancelDeferredClose('c1');
    expect(registry.hasDeferredClose('c1')).toBe(false);

    const live = registry.delete('c1');
    expect(live?.sessionId).toBe('bb-1');
    expect(registry.has('c1')).toBe(false);
  });
});
