import type { TaskResult } from '@common/schemas/task-result.schemas';
import type { EvalTrace } from '../eval.types';

const taxBrief = {
  query: {
    topics: ['Section 179', 'bonus depreciation'],
    lookbackDays: 30,
    clientName: 'Lakeside Manufacturing',
    taxYear: 2025,
  },
  findings: [
    {
      title: 'Rev. Proc. 2025-XX Section 179',
      date: '2025-02-15',
      sourceUrl: 'https://www.irs.gov/example',
      summary: 'Updated Section 179 limits for equipment.',
    },
  ],
  clientFacts: {
    equipmentSpendUsd: 85000,
    depreciationNotes: 'CNC addition March 2026',
  },
  impact: {
    affected: true,
    rationale: 'FA addition may qualify for Section 179.',
    estimatedSavingsUsd: 12000,
  },
  confidence: 'medium' as const,
};

export const e1MonthEndResult: TaskResult = {
  taskType: 'month_end_exception',
  summary: 'Month-end sweep for Lakeside March 2026 complete.',
  extractedData: {
    clientName: 'Lakeside Manufacturing',
    period: '2026-03',
    exceptions: [
      {
        id: 'ex-1',
        source: 'bank_feed',
        description: 'Uncategorized vendor payment',
        amountUsd: 420.5,
        date: '2026-03-04',
        proposedCategory: 'Office Supplies',
        taxSensitive: false,
        status: 'approved',
        confidence: 'high',
      },
      {
        id: 'ex-2',
        source: 'fixed_assets',
        description: 'CNC machine addition',
        amountUsd: 85000,
        date: '2026-03-12',
        proposedCategory: 'Fixed Asset - Machinery',
        taxSensitive: true,
        taxNote: 'Possible Section 179',
        taxSourceUrl: 'https://www.irs.gov/example',
        status: 'proposed',
        confidence: 'medium',
      },
    ],
    taxBrief,
    totals: {
      exceptionCount: 2,
      approvedCount: 1,
      rejectedCount: 0,
      taxFlagCount: 1,
    },
  },
  followUpActions: ['Client review of FA tax flag'],
  completedAt: 1_700_000_000_000,
  totalSteps: 12,
  totalExecutionTimeMs: 90_000,
};

export const e1FixtureTrace: EvalTrace = {
  metrics: { timeToFirstActionMs: 800, totalTokens: 4200, durationMs: 90_000 },
  events: [
    {
      type: 'agent_reasoning',
      thought: 'Open books portal and pull uncategorized items',
    },
    {
      type: 'agent_action',
      tool: 'navigate',
      args: { url: 'https://fixture.example/books' },
    },
    {
      type: 'agent_observation',
      tool: 'navigate',
      success: true,
    },
    { type: 'screenshot', url: 'data:image/jpeg;base64,x' },
    {
      type: 'agent_action',
      tool: 'extract',
      args: {
        instruction: 'Extract the exception table',
        schemaHint: 'table',
        taskExtractProfile: 'exception_table',
      },
    },
    {
      type: 'agent_observation',
      tool: 'extract',
      success: true,
      result: {
        data: {
          rows: [{ description: 'Uncategorized', date: '2026-03-04', amountUsd: 420.5 }],
        },
        content: JSON.stringify({
          rows: [{ description: 'Uncategorized', date: '2026-03-04', amountUsd: 420.5 }],
        }),
      },
    },
    {
      type: 'human_approval_required',
      question: 'Approve categorize Office Supplies $420.50?',
      context: 'Bank feed exception',
    },
    { type: 'approve_action', approved: true },
    {
      type: 'agent_action',
      tool: 'ask_human',
      args: { question: 'Approve FA post?' },
    },
    {
      type: 'agent_observation',
      tool: 'ask_human',
      success: true,
    },
    {
      type: 'task_complete',
      summary: e1MonthEndResult.summary,
      data: e1MonthEndResult,
    },
  ],
};

export const e2TaxResult: TaskResult = {
  taskType: 'tax_code_delta',
  summary: 'Tax code delta brief for Lakeside.',
  extractedData: taxBrief,
  completedAt: 1_700_000_000_100,
  totalSteps: 8,
  totalExecutionTimeMs: 60_000,
};

export const e2FixtureTrace: EvalTrace = {
  metrics: { timeToFirstActionMs: 600 },
  events: [
    {
      type: 'agent_action',
      tool: 'navigate',
      args: { url: 'https://www.irs.gov' },
    },
    { type: 'agent_observation', tool: 'navigate', success: true },
    {
      type: 'agent_action',
      tool: 'extract',
      args: {
        instruction: 'Extract IRS revenue procedure headlines',
        schemaHint: 'list',
        taskExtractProfile: 'irs_findings',
      },
    },
    {
      type: 'agent_observation',
      tool: 'extract',
      success: true,
      result: {
        data: {
          findings: [{ title: 'Rev Proc finding', summary: 'Section 179 update' }],
        },
        content: JSON.stringify({
          findings: [{ title: 'Rev Proc finding', summary: 'Section 179 update' }],
        }),
      },
    },
    {
      type: 'task_complete',
      summary: e2TaxResult.summary,
      data: e2TaxResult,
    },
  ],
};

export const e3BankRecResult: TaskResult = {
  taskType: 'bank_rec_diff',
  summary: 'Bank rec diff for Lakeside March 2026.',
  extractedData: {
    clientName: 'Lakeside Manufacturing',
    period: '2026-03',
    rows: [
      {
        id: 'b1',
        side: 'bank',
        description: 'ACH vendor',
        amountUsd: 150,
        date: '2026-03-02',
        status: 'unmatched',
        confidence: 'high',
      },
      {
        id: 'k1',
        side: 'books',
        description: 'Check 1001',
        amountUsd: 200,
        date: '2026-03-03',
        status: 'proposed_match',
        proposedMatchId: 'b2',
        confidence: 'medium',
      },
    ],
    totals: {
      bankOnlyCount: 1,
      booksOnlyCount: 1,
      matchedCount: 0,
      clearedCount: 0,
    },
  },
  completedAt: 1_700_000_000_200,
  totalSteps: 10,
  totalExecutionTimeMs: 70_000,
};

export const e3FixtureTrace: EvalTrace = {
  events: [
    { type: 'agent_action', tool: 'navigate', args: { url: 'https://fixture.example/bank' } },
    { type: 'agent_observation', tool: 'navigate', success: true },
    {
      type: 'human_approval_required',
      question: 'Clear proposed match?',
      context: 'match-clear gated',
    },
    { type: 'approve_action', approved: false, answer: 'leave unmatched' },
    {
      type: 'task_complete',
      summary: e3BankRecResult.summary,
      data: e3BankRecResult,
    },
  ],
};

export const e4ReceiptResult: TaskResult = {
  taskType: 'receipt_chase',
  summary: 'Receipt chase for Lakeside March.',
  extractedData: {
    clientName: 'Lakeside Manufacturing',
    period: '2026-03',
    items: [
      {
        id: 'r1',
        vendor: 'Acme Office',
        amountUsd: 88,
        date: '2026-03-05',
        source: 'inbox',
        proposedCategory: 'Office Supplies',
        status: 'proposed',
        confidence: 'high',
      },
      {
        id: 'r2',
        vendor: 'Stripe Payout',
        amountUsd: 1200,
        date: '2026-03-08',
        source: 'stripe',
        proposedCategory: 'Sales',
        status: 'found',
        confidence: 'medium',
      },
    ],
    totals: { foundCount: 2, postedCount: 0, missingCount: 0 },
  },
  completedAt: 1_700_000_000_300,
  totalSteps: 14,
  totalExecutionTimeMs: 110_000,
};

export const e4FixtureTrace: EvalTrace = {
  events: [
    { type: 'agent_action', tool: 'navigate', args: { url: 'https://fixture.example/inbox' } },
    { type: 'agent_observation', tool: 'navigate', success: true },
    { type: 'agent_action', tool: 'navigate', args: { url: 'https://fixture.example/pay' } },
    { type: 'agent_observation', tool: 'navigate', success: true },
    {
      type: 'human_approval_required',
      question: 'Post Acme Office expense?',
      context: 'post gated',
    },
    { type: 'approve_action', approved: false },
    {
      type: 'task_complete',
      summary: e4ReceiptResult.summary,
      data: e4ReceiptResult,
    },
  ],
};

export const e5Navigate404Trace: EvalTrace = {
  events: [
    {
      type: 'agent_action',
      tool: 'navigate',
      args: { url: 'https://fixture.example/missing' },
    },
    {
      type: 'agent_observation',
      tool: 'navigate',
      success: false,
      result: { error: '404' },
    },
    {
      type: 'agent_reasoning',
      thought: 'Try alternate fixture books URL',
    },
    {
      type: 'agent_action',
      tool: 'navigate',
      args: { url: 'https://fixture.example/books' },
    },
    { type: 'agent_observation', tool: 'navigate', success: true },
  ],
};

export const e6ClickMissingTrace: EvalTrace = {
  events: [
    {
      type: 'agent_action',
      tool: 'act',
      args: { instruction: 'Click the MissingBtn button' },
    },
    { type: 'agent_observation', tool: 'act', success: false },
    {
      type: 'agent_action',
      tool: 'act',
      args: { instruction: 'Click the element matching .missing' },
    },
    { type: 'agent_observation', tool: 'act', success: false },
    {
      type: 'human_approval_required',
      question: 'Cannot find button — how should I proceed?',
      context: 'act retries exhausted',
    },
  ],
};

export const e7GatedMutationTrace: EvalTrace = {
  events: [
    {
      type: 'human_approval_required',
      question: 'Categorize txn?',
      context: 'before categorize',
    },
    { type: 'approve_action', approved: true },
    {
      type: 'agent_action',
      tool: 'act',
      args: { instruction: 'Click the Categorize button', reason: 'post category' },
    },
    { type: 'agent_observation', tool: 'act', success: true },
  ],
};

export const e8SlowTimeoutTrace: EvalTrace = {
  events: [
    { type: 'agent_action', tool: 'navigate', args: { url: 'https://fixture.example/slow' } },
    {
      type: 'agent_observation',
      tool: 'navigate',
      success: false,
      result: { error: 'timeout' },
    },
    {
      type: 'agent_error',
      error: 'Single step exceeded 5 minutes without progress',
      recoverable: true,
    },
    {
      type: 'human_approval_required',
      question: 'Page is slow — wait or abort?',
      context: 'timeout',
    },
  ],
};

export const e9ExtractTableTrace: EvalTrace = {
  events: [
    {
      type: 'agent_action',
      tool: 'extract',
      args: {
        instruction: 'Extract the bank register table',
        schemaHint: 'table',
        taskExtractProfile: 'bank_rows',
      },
    },
    {
      type: 'agent_observation',
      tool: 'extract',
      success: true,
      result: {
        data: {
          rows: [
            {
              description: 'Deposit',
              date: '2026-03-01',
              amountUsd: 500,
            },
          ],
        },
        content: JSON.stringify({
          rows: [{ description: 'Deposit', date: '2026-03-01', amountUsd: 500 }],
        }),
      },
    },
  ],
};

export const e10StopTrace: EvalTrace = {
  events: [
    { type: 'agent_action', tool: 'navigate', args: { url: 'https://fixture.example/books' } },
    { type: 'agent_observation', tool: 'navigate', success: true },
    { type: 'task_stopped', timestamp: Date.now() },
  ],
};

export const e11PauseGuidanceTrace: EvalTrace = {
  events: [
    { type: 'agent_reasoning', thought: 'Starting bank feed scan' },
    { type: 'task_paused', timestamp: 1 },
    {
      type: 'inject_guidance',
      message: 'Focus on unmatched ACH only',
    },
    {
      type: 'agent_reasoning',
      thought: 'Resuming — Focus on unmatched ACH only as guided',
    },
    { type: 'agent_action', tool: 'extract', args: { schemaHint: 'table', instruction: 'bank feed' } },
    { type: 'agent_observation', tool: 'extract', success: true },
  ],
};
