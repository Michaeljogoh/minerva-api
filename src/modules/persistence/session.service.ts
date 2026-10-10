import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ReasoningStep } from '@common/types/reasoning-step.types';
import type { TaskResult, TaskType } from '@common/schemas/task-result.schemas';
import { createReasoningStep } from './session-step.mapper';
import {
  SessionRecordEntity,
  type SessionScreenshotEntry,
} from './entities/session-record.entity';

/**
 * PostgreSQL session queries (milestone B9).
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(SessionRecordEntity)
    private readonly sessions: Repository<SessionRecordEntity>,
  ) {}

  async list(userId: string, limit = 20): Promise<SessionRecordEntity[]> {
    const take = Math.min(Math.max(limit, 1), 100);
    return this.sessions.find({
      where: { userId },
      order: { startedAt: 'DESC' },
      take,
      select: [
        'id',
        'goal',
        'taskType',
        'status',
        'startedAt',
        'endedAt',
        'error',
        'createdAt',
      ],
    });
  }

  async getById(userId: string, id: string): Promise<SessionRecordEntity> {
    // Another user's record is reported as missing, not forbidden.
    const record = await this.sessions.findOne({ where: { id, userId } });
    if (!record) {
      throw new NotFoundException(`SessionRecord ${id} not found`);
    }
    return record;
  }

  /** Fire-and-forget append when a session record id is known. */
  queueStep(
    recordId: string | undefined,
    step: Omit<ReasoningStep, 'id'>,
  ): void {
    if (!recordId) {
      return;
    }
    void this.appendStep(recordId, step);
  }

  /** Append a timeline step to a session record (best-effort, non-blocking). */
  async appendStep(
    recordId: string,
    step: Omit<ReasoningStep, 'id'>,
  ): Promise<void> {
    try {
      const record = await this.sessions.findOne({
        where: { id: recordId },
        select: ['id', 'steps'],
      });
      if (!record) {
        return;
      }
      record.steps = [...(record.steps ?? []), createReasoningStep(step)];
      await this.sessions.save(record);
    } catch (err) {
      this.logger.warn(
        `Failed to append step to SessionRecord ${recordId}: ${String(err)}`,
      );
    }
  }

  queueScreenshot(
    recordId: string | undefined,
    entry: SessionScreenshotEntry,
  ): void {
    if (!recordId) {
      return;
    }
    void this.appendScreenshot(recordId, entry);
  }

  async appendScreenshot(
    recordId: string,
    entry: SessionScreenshotEntry,
  ): Promise<void> {
    try {
      const record = await this.sessions.findOne({
        where: { id: recordId },
        select: ['id', 'screenshots'],
      });
      if (!record) {
        return;
      }
      record.screenshots = [...(record.screenshots ?? []), entry];
      await this.sessions.save(record);
    } catch (err) {
      this.logger.warn(
        `Failed to append screenshot to SessionRecord ${recordId}: ${String(err)}`,
      );
    }
  }

  /** Persist structured task output before session close. */
  async persistResult(
    recordId: string,
    result: TaskResult,
    taskType?: TaskType,
  ): Promise<void> {
    try {
      const resolvedTaskType = taskType ?? result.taskType;
      await this.sessions.update(recordId, {
        result,
        ...(resolvedTaskType ? { taskType: resolvedTaskType } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist result for SessionRecord ${recordId}: ${String(err)}`,
      );
    }
  }
}
