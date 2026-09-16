import { SessionService } from './session.service';
import type { SessionRecordEntity } from './entities/session-record.entity';

describe('SessionService', () => {
  const store = new Map<string, SessionRecordEntity>();

  const repo = {
    find: jest.fn(),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
      store.get(where.id),
    ),
    update: jest.fn(async (id: string, patch: Partial<SessionRecordEntity>) => {
      const current = store.get(id);
      if (!current) {
        return;
      }
      store.set(id, { ...current, ...patch });
    }),
  };

  const service = new SessionService(repo as never);

  beforeEach(() => {
    store.clear();
    store.set('rec-1', {
      id: 'rec-1',
      goal: 'test',
      taskType: null,
      status: 'running',
      startedAt: new Date(),
      endedAt: null,
      steps: [],
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('appendStep adds a reasoning step with id', async () => {
    await service.appendStep('rec-1', {
      timestamp: 1,
      type: 'reasoning',
      content: 'thinking',
    });

    const record = store.get('rec-1');
    expect(record?.steps).toHaveLength(1);
    expect(record?.steps[0]?.id).toEqual(expect.any(String));
    expect(record?.steps[0]?.content).toBe('thinking');
  });

  it('persistResult stores task output', async () => {
    await service.persistResult('rec-1', {
      taskType: 'month_end_exception',
      summary: 'done',
      extractedData: { rows: [] },
      completedAt: 1,
      totalSteps: 2,
      totalExecutionTimeMs: 3,
    });

    const record = store.get('rec-1');
    expect(record?.result?.summary).toBe('done');
    expect(record?.taskType).toBe('month_end_exception');
  });
});
