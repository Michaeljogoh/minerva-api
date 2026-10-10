import { NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';

describe('SessionService ownership', () => {
  const record = { id: 'r1', userId: 'user_a', goal: 'g' };
  const repo = {
    find: jest.fn(async () => [record]),
    findOne: jest.fn(
      async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === record.id && where.userId === record.userId ? record : null,
    ),
  };
  const service = new SessionService(repo as never);

  it('lists only the caller\'s sessions', async () => {
    await service.list('user_b');
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_b' } }),
    );
  });

  it('returns the owner\'s session', async () => {
    await expect(service.getById('user_a', 'r1')).resolves.toBe(record);
  });

  it('reports another user\'s session as not found', async () => {
    await expect(service.getById('user_b', 'r1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
