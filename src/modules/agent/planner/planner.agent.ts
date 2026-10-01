import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '@modules/model/model-provider';
import {
  agentPlanSchema,
  formatPlanForExecutor,
  type AgentPlan,
} from './agent-plan';
import type { TaskType } from '@common/schemas/task-result.schemas';

const PLANNER_INSTRUCTION = `You are a planning assistant for a browser automation agent that helps accountants.

Given a natural-language goal, produce an ordered plan of high-level browser steps.
Infer the task type when possible:
- month_end_exception: month-end close, bank/books exceptions, missing docs, categorize proposals, tax flags
- tax_code_delta: multi-site tax / IRS research brief
- commerce_reconciliation: Shopify + Stripe (or similar) order/payout matching
- bank_rec_diff: bank reconciliation mismatches
- receipt_chase: find missing receipts / chase vendors

Use only real public websites named in the goal (for example https://www.irs.gov, https://admin.shopify.com, https://dashboard.stripe.com, https://mail.google.com, https://drive.google.com). Never plan localhost, ngrok, or fixture portals. Keep steps concrete and short. Output must match the schema.`;

@Injectable()
export class PlannerAgent {
  private readonly logger = new Logger(PlannerAgent.name);

  constructor(@Inject(MODEL_PROVIDER) private readonly model: ModelProvider) {}

  /**
   * Produce an ordered plan for the goal. Returns null on failure
   * so the caller can fall back to direct execution.
   */
  async plan(
    goal: string,
    taskType?: TaskType | null,
  ): Promise<AgentPlan | null> {
    const hint = taskType
      ? `Hinted task type: ${taskType}\n\nGoal:\n${goal}`
      : `Goal:\n${goal}`;

    try {
      return await this.model.completeJson({
        system: PLANNER_INSTRUCTION,
        user: hint,
        schema: agentPlanSchema,
      });
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
