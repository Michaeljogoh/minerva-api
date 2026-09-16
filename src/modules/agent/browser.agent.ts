import { Injectable, Logger } from '@nestjs/common';
import {
  InMemoryRunner,
  LlmAgent,
  type Event,
} from '@google/adk';
import type { TaskType } from '@common/schemas/task-result.schemas';
import {
  BROWSER_AGENT_DESCRIPTION,
  BROWSER_AGENT_INSTRUCTION,
  BROWSER_AGENT_MODEL,
  BROWSER_AGENT_NAME,
} from '@common/constants/agent.constants';
import { runWithLlmRetry } from './recovery/error-recovery';
import { PlannerAgent } from './planner/planner.agent';
import { TaskControlService } from './task/task-control.service';
import { StagehandToolsService } from './tools/stagehand.tools';
import { ToolSessionContext } from './tools/tool-session.context';

export interface RunGoalParams {
  clientId: string;
  goal: string;
  taskType?: TaskType | null;
  /** When liveUrl is unavailable — screenshot-only degradation (§13.4). */
  screenshotOnly?: boolean;
  /** Optional Gemini Pro upfront plan (§11.2). Default false. */
  usePlanner?: boolean;
  abortSignal?: AbortSignal;
  /** Called before LLM retry backoff sleeps (§13.3 / §13.4). */
  onLlmRetry?: (
    attempt: number,
    error: unknown,
    delayMs: number,
  ) => void | Promise<void | { handledDelay?: boolean }>;
}

/**
 * ADK browser agent + system instruction + tools (§11.1).
 *
 * Uses {@link InMemoryRunner.runAsync} for the tool-calling loop. Socket
 * streaming maps ADK events onto the public protocol in the gateway (Step 10).
 * ADK `runLive` is reserved for Live API media sessions, not this text/tool loop.
 */
@Injectable()
export class BrowserAgent {
  private readonly logger = new Logger(BrowserAgent.name);
  private llmAgent: LlmAgent | null = null;

  constructor(
    private readonly tools: StagehandToolsService,
    private readonly toolCtx: ToolSessionContext,
    private readonly planner: PlannerAgent,
    private readonly taskControl: TaskControlService,
  ) {}

  /** Lazily build the Flash agent with Stagehand browser tools. */
  getAgent(): LlmAgent {
    if (!this.llmAgent) {
      this.llmAgent = new LlmAgent({
        name: BROWSER_AGENT_NAME,
        description: BROWSER_AGENT_DESCRIPTION,
        model: BROWSER_AGENT_MODEL,
        instruction: () => this.buildInstruction(),
        tools: this.tools.createTools(),
        disallowTransferToParent: true,
        disallowTransferToPeers: true,
        beforeToolCallback: async (_params) => {
          const clientId = this.toolCtx.requireClientId();
          await this.taskControl.waitIfPaused(clientId);
          return undefined;
        },
        beforeModelCallback: async ({ request }) => {
          let clientId: string;
          try {
            clientId = this.toolCtx.requireClientId();
          } catch {
            return undefined;
          }
          const guidance = this.taskControl.drainGuidance(clientId);
          if (guidance) {
            request.contents.push({
              role: 'user',
              parts: [
                {
                  text: `Human guidance (follow on the next steps):\n${guidance}`,
                },
              ],
            });
          }
          return undefined;
        },
      });
    }
    return this.llmAgent;
  }

  /**
   * Run a goal for a connected client. Sets tool session context for the
   * duration of the async generator, then clears it.
   */
  async *runGoal(params: RunGoalParams): AsyncGenerator<Event, void, undefined> {
    const {
      clientId,
      goal,
      taskType,
      screenshotOnly = false,
      usePlanner = false,
      abortSignal,
      onLlmRetry,
    } = params;

    if (!goal.trim()) {
      throw new Error('BrowserAgent.runGoal: goal must be non-empty');
    }

    yield* this.toolCtx.bindGenerator(
      { clientId, taskType, screenshotOnly },
      () => this.runGoalInner({
        clientId,
        goal,
        taskType,
        usePlanner,
        abortSignal,
        onLlmRetry,
      }),
    );
  }

  private async *runGoalInner(
    params: Omit<RunGoalParams, 'screenshotOnly'>,
  ): AsyncGenerator<Event, void, undefined> {
    const {
      clientId,
      goal,
      taskType,
      usePlanner = false,
      abortSignal,
      onLlmRetry,
    } = params;

    try {
      const message = await this.buildUserMessage(goal, taskType, usePlanner);
      const self = this;

      yield* runWithLlmRetry(
        async function* (attempt: number) {
          const runner = new InMemoryRunner({
            agent: self.getAgent(),
            appName: 'minerva-browser-agent',
          });

          const session = await runner.sessionService.createSession({
            appName: runner.appName,
            userId: clientId,
          });

          self.logger.log(
            `runGoal clientId=${clientId} sessionId=${session.id} attempt=${attempt + 1} taskType=${taskType ?? 'infer'}`,
          );

          yield* runner.runAsync({
            userId: clientId,
            sessionId: session.id,
            newMessage: { role: 'user', parts: [{ text: message }] },
            abortSignal,
          });
        },
        {
          abortSignal,
          onRetry: onLlmRetry,
        },
      );
    } finally {
      this.toolCtx.clear();
    }
  }

  private async buildUserMessage(
    goal: string,
    taskType: TaskType | null | undefined,
    usePlanner: boolean,
  ): Promise<string> {
    if (usePlanner) {
      const plan = await this.planner.plan(goal, taskType);
      if (plan) {
        if (plan.inferredTaskType && !taskType) {
          this.toolCtx.setTaskType(plan.inferredTaskType);
        }
        return this.planner.formatPlanForExecutor(goal, plan);
      }
    }

    if (taskType) {
      return `Active task type: ${taskType}\n\nValidate done.extracted_data against this schema.\n\nGoal:\n${goal}`;
    }

    return goal;
  }

  private buildInstruction(): string {
    return BROWSER_AGENT_INSTRUCTION;
  }
}
