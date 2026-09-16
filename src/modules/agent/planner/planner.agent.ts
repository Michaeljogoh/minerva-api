import { Injectable, Logger } from '@nestjs/common';
import {
  InMemoryRunner,
  LlmAgent,
  isFinalResponse,
  stringifyContent,
  type Event,
} from '@google/adk';
import { PLANNER_AGENT_MODEL } from '@common/constants/agent.constants';
import {
  agentPlanSchema,
  formatPlanForExecutor,
  type AgentPlan,
} from './agent-plan';
import type { TaskType } from '@common/schemas/task-result.schemas';

const PLANNER_INSTRUCTION = `You are a planning assistant for a browser automation agent that helps accountants.

Given a natural-language goal, produce an ordered plan of high-level browser steps.
Infer the task type when possible:
- month_end_exception: bank feed / books exceptions, categorize proposals, tax flags
- tax_code_delta: IRS / tax research brief
- bank_rec_diff: bank reconciliation mismatches
- receipt_chase: find missing receipts / chase vendors

Do not invent URLs. Keep steps concrete and short. Output must match the schema.`;

/**
 * Optional Gemini Pro upfront planning (§11.2).
 * Per-step Flash reasoning remains the MVP planning requirement.
 */
@Injectable()
export class PlannerAgent {
  private readonly logger = new Logger(PlannerAgent.name);

  /**
   * Produce an ordered plan for the goal. Returns null on failure
   * so the caller can fall back to Flash-only execution.
   */
  async plan(
    goal: string,
    taskType?: TaskType | null,
  ): Promise<AgentPlan | null> {
    const agent = new LlmAgent({
      name: 'browser-planner-agent',
      description: 'Upfront planning for browser automation goals',
      model: PLANNER_AGENT_MODEL,
      instruction: PLANNER_INSTRUCTION,
      outputSchema: agentPlanSchema,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'minerva-planner',
    });

    const hint = taskType
      ? `Hinted task type: ${taskType}\n\nGoal:\n${goal}`
      : `Goal:\n${goal}`;

    try {
      let lastFinal: Event | undefined;
      for await (const event of runner.runEphemeral({
        userId: 'planner',
        newMessage: { role: 'user', parts: [{ text: hint }] },
      })) {
        if (isFinalResponse(event)) {
          lastFinal = event;
        }
      }

      if (!lastFinal) {
        this.logger.warn('Planner produced no final response');
        return null;
      }

      const text = stringifyContent(lastFinal).trim();
      if (!text) {
        this.logger.warn('Planner final response was empty');
        return null;
      }

      const parsed: unknown = JSON.parse(text);
      return agentPlanSchema.parse(parsed);
    } catch (err) {
      this.logger.warn(
        `Planner failed; continuing without upfront plan: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  formatPlanForExecutor(goal: string, plan: AgentPlan): string {
    return formatPlanForExecutor(goal, plan);
  }
}
