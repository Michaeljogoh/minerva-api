import type { TaskResult, TaskType } from '@common/schemas/task-result.schemas';

/** Protocol-shaped events recorded for offline / live scoring. */
export type EvalTraceEvent =
  | {
      type: 'agent_reasoning';
      timestamp?: number;
      thought: string;
    }
  | {
      type: 'agent_action';
      timestamp?: number;
      tool: string;
      args?: Record<string, unknown>;
      reasoning?: string;
    }
  | {
      type: 'agent_observation';
      timestamp?: number;
      tool: string;
      success: boolean;
      result?: unknown;
    }
  | {
      type: 'human_approval_required';
      approvalId?: string;
      question: string;
      context?: string;
    }
  | {
      type: 'approve_action';
      approvalId?: string;
      approved: boolean;
      answer?: string;
    }
  | {
      type: 'screenshot';
      timestamp?: number;
      url?: string;
    }
  | {
      type: 'task_complete';
      timestamp?: number;
      summary: string;
      data: TaskResult;
    }
  | {
      type: 'task_stopped';
      timestamp?: number;
    }
  | {
      type: 'task_paused';
      timestamp?: number;
    }
  | {
      type: 'inject_guidance';
      message: string;
    }
  | {
      type: 'agent_error';
      timestamp?: number;
      error: string;
      recoverable?: boolean;
      fatal?: boolean;
    };

export interface EvalTrace {
  events: EvalTraceEvent[];
  /** Optional timing / token metrics (§14). */
  metrics?: {
    timeToFirstActionMs?: number;
    totalTokens?: number;
    durationMs?: number;
  };
}

export interface EvalAssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  assertions: EvalAssertionResult[];
  metrics: {
    askHumanCount: number;
    actionCount: number;
    firstAttemptSuccessRate: number;
    timeToFirstActionMs?: number;
    humanInterventionRate: number;
  };
}

export interface EvalSuiteResult {
  passed: boolean;
  results: EvalCaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    taskSuccessByType: Partial<Record<TaskType, { passed: number; total: number }>>;
  };
}

export type EvalAssertFn = (trace: EvalTrace) => EvalAssertionResult[];

export interface EvalCase {
  id: string;
  name: string;
  goal: string;
  taskType?: TaskType;
  /** CI / offline fixture that should pass all asserts. */
  fixtureTrace: EvalTrace;
  assert: EvalAssertFn;
}
