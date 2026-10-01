import { randomUUID } from 'crypto';
import type { ReasoningStep } from '@common/types/reasoning-step.types';

export function createReasoningStep(
  step: Omit<ReasoningStep, 'id'>,
): ReasoningStep {
  return { ...step, id: randomUUID() };
}

export function stepFromAgentReasoning(payload: {
  timestamp: number;
  thought: string;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'reasoning',
    content: payload.thought,
  };
}

export function stepFromAgentAction(payload: {
  timestamp: number;
  tool: string;
  args: Record<string, unknown>;
  reasoning: string;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'action',
    content: payload.reasoning || payload.tool,
    tool: payload.tool,
    args: payload.args,
  };
}

export function stepFromAgentObservation(payload: {
  timestamp: number;
  tool: string;
  result: unknown;
  success: boolean;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'observation',
    content: payload.success
      ? `${payload.tool} succeeded`
      : `${payload.tool} failed`,
    tool: payload.tool,
    result: payload.result,
    metadata: { confidence: payload.success ? 1 : 0 },
  };
}

export function stepFromScreenshot(payload: {
  timestamp: number;
  url: string;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'screenshot',
    content: 'Page screenshot captured',
    screenshotUrl: payload.url,
  };
}

export function stepFromApproval(payload: {
  timestamp: number;
  question: string;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'approval',
    content: payload.question,
  };
}

export function stepFromError(payload: {
  timestamp: number;
  error: string;
}): Omit<ReasoningStep, 'id'> {
  return {
    timestamp: payload.timestamp,
    type: 'error',
    content: payload.error,
  };
}
