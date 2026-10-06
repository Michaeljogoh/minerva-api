import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import type { TaskType } from '@common/schemas/task-result.schemas';
import type {
  ExternalModelConfig,
  ModelRunConfigSource,
} from '@modules/model/external-model.types';

interface RunContext {
  clientId: string;
  taskType: TaskType | null;
  screenshotOnly: boolean;
  runStartedAt: number;
  humanApprovalGranted: boolean;
  externalModel: ExternalModelConfig | null;
}

export interface RunContextInit {
  clientId: string;
  taskType?: TaskType | null;
  screenshotOnly?: boolean;
  externalModel?: ExternalModelConfig | null;
}

/**
 * Per-run context for tools. Uses AsyncLocalStorage so concurrent client runs
 * do not overwrite each other's clientId / taskType / user model key.
 */
@Injectable()
export class ToolSessionContext implements ModelRunConfigSource {
  private readonly storage = new AsyncLocalStorage<RunContext>();

  /**
   * Wrap an async generator so each `next()` executes inside the run's ALS scope.
   */
  bindGenerator<T>(
    init: RunContextInit,
    factory: () => AsyncGenerator<T, void, undefined>,
  ): AsyncGenerator<T, void, undefined> {
    const store: RunContext = {
      clientId: init.clientId,
      taskType: init.taskType ?? null,
      screenshotOnly: init.screenshotOnly ?? false,
      runStartedAt: Date.now(),
      humanApprovalGranted: false,
      externalModel: init.externalModel ?? null,
    };
    const storage = this.storage;
    const gen = factory();

    return (async function* () {
      while (true) {
        const result = await storage.run(store, () => gen.next());
        if (result.done) {
          return;
        }
        yield result.value;
      }
    })();
  }

  clear(): void {
    // ALS scope ends when bindGenerator completes.
  }

  isScreenshotOnly(): boolean {
    return this.storage.getStore()?.screenshotOnly ?? false;
  }

  requireClientId(): string {
    const ctx = this.storage.getStore();
    if (!ctx?.clientId) {
      throw new Error('ToolSessionContext: no active clientId');
    }
    return ctx.clientId;
  }

  getExternalModel(): ExternalModelConfig | null {
    return this.storage.getStore()?.externalModel ?? null;
  }

  getTaskType(): TaskType | null {
    return this.storage.getStore()?.taskType ?? null;
  }

  setTaskType(taskType: TaskType): void {
    const ctx = this.storage.getStore();
    if (ctx) {
      ctx.taskType = taskType;
    }
  }

  grantHumanApproval(): void {
    const ctx = this.storage.getStore();
    if (ctx) {
      ctx.humanApprovalGranted = true;
    }
  }

  consumeHumanApproval(): boolean {
    const ctx = this.storage.getStore();
    if (ctx?.humanApprovalGranted) {
      ctx.humanApprovalGranted = false;
      return true;
    }
    return false;
  }

  hasHumanApproval(): boolean {
    return this.storage.getStore()?.humanApprovalGranted ?? false;
  }

  getRunStartedAt(): number {
    return this.storage.getStore()?.runStartedAt ?? Date.now();
  }

  getElapsedMs(): number {
    return Date.now() - this.getRunStartedAt();
  }
}
