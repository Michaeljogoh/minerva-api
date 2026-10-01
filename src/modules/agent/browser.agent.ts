import { Injectable, Logger } from '@nestjs/common';
import type { TaskType } from '@common/schemas/task-result.schemas';
import {
  BROWSER_AGENT_INSTRUCTION,
  BROWSER_AGENT_NAME,
  TASK_SCHEMA_HINTS,
} from '@common/constants/agent.constants';
import { runWithLlmRetry } from './recovery/error-recovery';
import { PlannerAgent } from './planner/planner.agent';
import { TaskControlService } from './task/task-control.service';
import { StagehandToolsService } from './tools/stagehand.tools';
import { ToolSessionContext } from './tools/tool-session.context';
import type { AgentEventLike } from './orchestrator/agent-event';
import { ToolCallingOrchestrator } from './orchestrator/tool-calling.orchestrator';

export interface RunGoalParams {
  clientId: string;
  goal: string;
  taskType?: TaskType | null;
  /** When liveUrl is unavailable — screenshot-only degradation (§13.4). */
  screenshotOnly?: boolean;
  /** Optional upfront plan. Default false. */
  usePlanner?: boolean;
  abortSignal?: AbortSignal;
  /** Called before LLM retry backoff sleeps (§13.3 / §13.4). */
  onLlmRetry?: (
    attempt: number,
    error: unknown,
    delayMs: number,
  ) => void | Promise<void | { handledDelay?: boolean }>;
}

@Injectable()
export class BrowserAgent {
  private readonly logger = new Logger(BrowserAgent.name);

  constructor(
    private readonly tools: StagehandToolsService,
    private readonly toolCtx: ToolSessionContext,
    private readonly planner: PlannerAgent,
    private readonly taskControl: TaskControlService,
    private readonly orchestrator: ToolCallingOrchestrator,
  ) {}

  /**
   * Run a goal for a connected client. Sets tool session context for the
   * duration of the async generator, then clears it.
   */
  async *runGoal(
    params: RunGoalParams,
  ): AsyncGenerator<AgentEventLike, void, undefined> {
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
      () =>
        this.runGoalInner({
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
  ): AsyncGenerator<AgentEventLike, void, undefined> {
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
      const agentTools = this.tools.createTools();
      const self = this;

      yield* runWithLlmRetry(
        async function* () {
          self.logger.log(
            `runGoal clientId=${clientId} taskType=${taskType ?? 'infer'}`,
          );

          yield* self.orchestrator.run({
            system: BROWSER_AGENT_INSTRUCTION,
            userMessage: message,
            tools: agentTools,
            author: BROWSER_AGENT_NAME,
            abortSignal,
            beforeTool: async () => {
              await self.taskControl.waitIfPaused(clientId);
            },
            injectGuidance: () =>
              self.taskControl.drainGuidance(clientId) || null,
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
      const hint = TASK_SCHEMA_HINTS[taskType] ?? '';
      return `Active task type: ${taskType}\n\nValidate done.extractedData against this schema.\n${hint}\n\nGoal:\n${goal}`;
    }

    return goal;
  }
}
