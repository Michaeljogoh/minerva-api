import { Injectable, Logger } from '@nestjs/common';
import { BrowserAgent } from '@modules/agent/browser.agent';
import {
  LLM_HEARTBEAT_MS,
  STEP_TIMEOUT_MS,
  classifyAgentError,
  extractRetrySeconds,
  isLlmRateLimitError,
  sleep,
} from '@modules/agent/recovery/error-recovery';
import { STEP_WATCH_INTERVAL_MS } from '@common/constants/session-lifecycle.constants';
import { TaskControlService } from '@modules/agent/task/task-control.service';
import { BrowserSessionManager } from '@modules/browser/browser-session.manager';
import type { TaskType } from '@common/schemas/task-result.schemas';
import type { ExternalModelConfig } from '@modules/model/external-model.types';
import {
  mapAdkEventToProtocol,
  type ProtocolOutbound,
} from './adk-event.mapper';

export interface TaskRunCallbacks {
  onBrowserReady: (payload: { liveUrl: string; sessionId: string }) => void;
  onScreenshotOnlyNotice: () => void;
  onAgentReasoning: (thought: string) => void;
  onProtocolEvent: (event: ProtocolOutbound) => void;
  onError: (
    message: string,
    opts: { recoverable: boolean; fatal: boolean },
  ) => void;
}

export interface TaskRunParams {
  clientId: string;
  goal: string;
  taskType?: TaskType;
  usePlanner?: boolean;
  externalModel?: ExternalModelConfig | null;
  abortSignal: AbortSignal;
  callbacks: TaskRunCallbacks;
  lastReasoning: { value: string };
}

@Injectable()
export class TaskRunCoordinator {
  private readonly logger = new Logger(TaskRunCoordinator.name);

  constructor(
    private readonly browsers: BrowserSessionManager,
    private readonly agent: BrowserAgent,
    private readonly taskControl: TaskControlService,
  ) {}

  async execute(params: TaskRunParams): Promise<void> {
    const {
      clientId,
      goal,
      taskType,
      usePlanner,
      externalModel = null,
      abortSignal,
      callbacks,
      lastReasoning,
    } = params;

    let lastActivityAt = Date.now();
    let stepTimedOut = false;

    const stepWatch = setInterval(() => {
      if (abortSignal.aborted) {
        return;
      }
      if (Date.now() - lastActivityAt < STEP_TIMEOUT_MS) {
        return;
      }
      if (stepTimedOut) {
        return;
      }
      stepTimedOut = true;
      callbacks.onError(
        'Single step exceeded 5 minutes without progress',
        { recoverable: true, fatal: false },
      );
      this.taskControl.queueGuidance(
        clientId,
        'Step timed out after 5 minutes. Call ask_human with context explaining where you are stuck, or try a different approach.',
      );
      lastActivityAt = Date.now();
      stepTimedOut = false;
    }, STEP_WATCH_INTERVAL_MS);

    try {
      const { sessionId, liveUrl } = await this.browsers.createBrowserSession(
        clientId,
        goal,
        externalModel,
      );
      if (abortSignal.aborted) {
        return;
      }

      const screenshotOnly = !liveUrl;
      callbacks.onBrowserReady({ liveUrl, sessionId });

      for await (const event of this.agent.runGoal({
        clientId,
        goal,
        taskType,
        screenshotOnly,
        usePlanner,
        externalModel,
        abortSignal,
        onLlmRetry: async (attempt, error, delayMs) => {
          const rateLimited = isLlmRateLimitError(error);
          const providerRetryMs = (extractRetrySeconds(error) ?? 0) * 1000;
          const waitMs = Math.max(delayMs, providerRetryMs);
          const retrySec = Math.ceil(waitMs / 1000);
          callbacks.onAgentReasoning(
            rateLimited
              ? `AI rate limit hit — waiting about ${retrySec}s before retry ${attempt + 1}…`
              : `Temporary AI issue — retrying (attempt ${attempt + 1}) in ${retrySec}s…`,
          );
          lastActivityAt = Date.now();

          if (!rateLimited) {
            return;
          }

          let waited = 0;
          while (waited < waitMs) {
            if (abortSignal.aborted) {
              return { handledDelay: true };
            }
            const slice = Math.min(LLM_HEARTBEAT_MS, waitMs - waited);
            await sleep(slice);
            waited += slice;
            if (waited < waitMs) {
              const remaining = Math.ceil((waitMs - waited) / 1000);
              callbacks.onAgentReasoning(
                `Still waiting on AI rate limit (${remaining}s left)…`,
              );
            }
          }
          return { handledDelay: true };
        },
      })) {
        if (abortSignal.aborted) {
          break;
        }
        lastActivityAt = Date.now();
        for (const item of mapAdkEventToProtocol(event, lastReasoning)) {
          callbacks.onProtocolEvent(item);
        }
      }
    } catch (err) {
      const classified = classifyAgentError(err);
      if (!abortSignal.aborted) {
        // Closing the browser ends the run — mark fatal so the UI leaves
        // "planning…" instead of looking stuck with Steel "Browser Disconnected".
        callbacks.onError(classified.message, {
          recoverable: classified.recoverable,
          fatal: true,
        });
        await this.browsers.closeBrowserSession(clientId, {
          status: 'error',
          error: classified.message,
        });
      }
    } finally {
      clearInterval(stepWatch);
    }
  }

  async releaseBrowserIfIdle(clientId: string): Promise<void> {
    if (
      this.browsers.hasLiveSession(clientId) &&
      !this.browsers.hasDeferredClose(clientId)
    ) {
      await this.browsers.closeBrowserSession(clientId, { status: 'stopped' });
    }
  }
}
