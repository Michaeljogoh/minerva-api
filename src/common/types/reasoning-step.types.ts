export type ReasoningStepType =
  | 'reasoning'
  | 'action'
  | 'observation'
  | 'error'
  | 'screenshot'
  | 'approval';

export interface ReasoningStep {
  id: string;
  timestamp: number;
  type: ReasoningStepType;
  content: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  screenshotUrl?: string;
  metadata?: {
    confidence?: number;
    retryCount?: number;
    executionTimeMs?: number;
  };
}

/** Pending ask_human — Redis only (not TypeORM). Key: approval:{approvalId} */
export interface ApprovalRequest {
  approvalId: string;
  question: string;
  context: string;
  timestamp: number;
  timeoutAt: number;
}
