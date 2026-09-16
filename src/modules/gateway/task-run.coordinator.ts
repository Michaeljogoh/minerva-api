import { Injectable } from '@nestjs/common';
import type { Event } from '@google/adk';
import { BrowserAgent } from '@modules/agent/browser.agent';
import {
  LLM_HEARTBEAT_MS,
  STEP_TIMEOUT_MS,
  classifyAgentError,
  isLlmRateLimitError,
  sleep,
} from '@modules/agent/recovery/error-recovery';
import { STEP_WATCH_INTERVAL_MS } from '@common/constants/session-lifecycle.constants';
import { TaskControlService } from '@modules/agent/task/task-control.service';
import { BrowserbaseManager } from '@modules/browser/browserbase.manager';
import type { TaskType } from '@common/schemas/task-result.schemas';

export interface TaskRunCallbacks {
  onBrowserReady: (payload: { liveUrl: string; sessionId: string }) => void;
  onScreenshotOnlyNotice: () => void;
  onAgentReasoning: (thought: string) => void;
  onProtocolEvent: (name: string, payload: unknown) => void;
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
  abortSignal: AbortSignal;
  callbacks: TaskRunCallbacks;
  mapEvent: (
    event: Event,
    lastReasoning: { value: string },
  ) => Array<{ name: string; payload: unknown }>;
  lastReasoning: { value: string };
}

@Injectable()
export class TaskRunCoordinator {
  constructor(
    private readonly browsers: BrowserbaseManager,
    private readonly agent: BrowserAgent,
    private readonly taskControl: TaskControlService,
  ) {}

  async execute(params: TaskRunParams): Promise<void> {
    const {
      clientId,
      goal,
      taskType,
      usePlanner,
      abortSignal,
      callbacks,
      mapEvent,
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
      const sessionId = await this.browsers.createBrowserSession(clientId, goal);
      if (abortSignal.aborted) {
        return;
      }

      let liveUrl = '';
      try {
        liveUrl = this.browsers.getLiveSessionUrl(clientId);
      } catch {
        liveUrl = '';
      }

      if (abortSignal.aborted) {
        return;
      }

      const screenshotOnly = !liveUrl;
      callbacks.onBrowserReady({ liveUrl, sessionId });
      if (screenshotOnly) {
        callbacks.onScreenshotOnlyNotice();
      }

      if (abortSignal.aborted) {
        return;
      }

      for await (const event of this.agent.runGoal({
        clientId,
        goal,
        taskType,
        screenshotOnly,
        usePlanner,
        abortSignal,
        onLlmRetry: async (attempt, error, delayMs) => {
          const rateLimited = isLlmRateLimitError(error);
          callbacks.onAgentReasoning(
            rateLimited
              ? `LLM rate limited — waiting ${delayMs}ms before retry ${attempt + 1}…`
              : `LLM transient error — retrying (attempt ${attempt + 1}) in ${delayMs}ms…`,
          );
          lastActivityAt = Date.now();

          if (!rateLimited) {
            return;
          }

          let waited = 0;
          while (waited < delayMs) {
            if (abortSignal.aborted) {
              return { handledDelay: true };
            }
            const slice = Math.min(LLM_HEARTBEAT_MS, delayMs - waited);
            await sleep(slice);
            waited += slice;
            if (waited < delayMs) {
              callbacks.onAgentReasoning('Still waiting on LLM rate limit…');
            }
          }
          return { handledDelay: true };
        },
      })) {
        if (abortSignal.aborted) {
          break;
        }
        lastActivityAt = Date.now();
        for (const item of mapEvent(event, lastReasoning)) {
          callbacks.onProtocolEvent(item.name, item.payload);
        }
      }
    } catch (err) {
      const classified = classifyAgentError(err);
      if (!abortSignal.aborted) {
        callbacks.onError(classified.message, {
          recoverable: classified.recoverable,
          fatal: classified.fatal,
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
