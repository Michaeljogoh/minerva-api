import { z } from 'zod';
import {
  taskTypeSchema,
  type TaskType,
} from '@common/schemas/task-result.schemas';

export const agentPlanSchema = z.object({
  inferredTaskType: taskTypeSchema.optional(),
  steps: z
    .array(
      z.object({
        order: z.number().int().positive(),
        action: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .min(1),
  notes: z.string().optional(),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;

export function formatPlanForExecutor(goal: string, plan: AgentPlan): string {
  const lines = plan.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}. ${s.action} — ${s.rationale}`);

  const parts = [
    `Goal:\n${goal}`,
    plan.inferredTaskType
      ? `Inferred task type: ${plan.inferredTaskType}`
      : null,
    `Upfront plan (follow unless the page state requires adaptation):\n${lines.join('\n')}`,
    plan.notes ? `Notes: ${plan.notes}` : null,
  ];

  return parts.filter(Boolean).join('\n\n');
}

export type { TaskType };
