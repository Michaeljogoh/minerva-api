import { z } from 'zod';

export const confidenceSchema = z.enum(['high', 'medium', 'low']);

export const taskTypeSchema = z.enum([
  'month_end_exception',
  'tax_code_delta',
  'commerce_reconciliation',
  'bank_rec_diff',
  'receipt_chase',
]);

export type TaskType = z.infer<typeof taskTypeSchema>;

export const taxCodeDeltaBriefResultSchema = z.object({
  query: z.object({
    topics: z.array(z.string()),
    lookbackDays: z.number(),
    clientName: z.string(),
    taxYear: z.number(),
  }),
  findings: z.array(
    z.object({
      title: z.string(),
      date: z.string(),
      sourceUrl: z.string(),
      summary: z.string(),
    }),
  ),
  clientFacts: z.object({
    equipmentSpendUsd: z.number().optional(),
    depreciationNotes: z.string().optional(),
    sourceUrl: z.string().optional(),
  }),
  impact: z.object({
    affected: z.boolean(),
    rationale: z.string(),
    estimatedSavingsUsd: z.number().optional(),
  }),
  recommendedActions: z.array(z.string()).optional(),
  sourcesChecked: z.array(z.string()).optional(),
  confidence: confidenceSchema,
});

export type TaxCodeDeltaBriefResult = z.infer<
  typeof taxCodeDeltaBriefResultSchema
>;

export const monthEndExceptionReportSchema = z.object({
  clientName: z.string(),
  period: z.string(),
  exceptions: z.array(
    z.object({
      id: z.string(),
      source: z.enum(['bank_feed', 'fixed_assets', 'register', 'other']),
      description: z.string(),
      amountUsd: z.number().optional(),
      date: z.string().optional(),
      proposedCategory: z.string().optional(),
      taxSensitive: z.boolean(),
      taxNote: z.string().optional(),
      taxSourceUrl: z.string().optional(),
      status: z.enum(['proposed', 'approved', 'rejected', 'skipped']),
      confidence: confidenceSchema,
    }),
  ),
  taxBrief: taxCodeDeltaBriefResultSchema.optional(),
  closeStatus: z.enum(['ready', 'blocked', 'needs_review']).optional(),
  blockers: z.array(z.string()).optional(),
  missingDocuments: z.array(z.string()).optional(),
  checklist: z.array(z.string()).optional(),
  totals: z.object({
    exceptionCount: z.number(),
    approvedCount: z.number(),
    rejectedCount: z.number(),
    taxFlagCount: z.number(),
  }),
});

export type MonthEndExceptionReport = z.infer<
  typeof monthEndExceptionReportSchema
>;

export const commerceReconciliationResultSchema = z.object({
  clientName: z.string(),
  period: z.string(),
  connectedSources: z.array(z.string()),
  rows: z.array(
    z.object({
      id: z.string(),
      source: z.enum(['shopify', 'stripe', 'bank', 'other']),
      orderId: z.string().optional(),
      payoutId: z.string().optional(),
      description: z.string(),
      saleDate: z.string().optional(),
      payoutDate: z.string().optional(),
      grossUsd: z.number().optional(),
      taxUsd: z.number().optional(),
      refundUsd: z.number().optional(),
      feeUsd: z.number().optional(),
      netUsd: z.number(),
      status: z.enum([
        'matched',
        'mismatch',
        'missing_payout',
        'needs_review',
        'approved',
      ]),
      exceptionReason: z.string().optional(),
      confidence: confidenceSchema,
    }),
  ),
  totals: z.object({
    grossUsd: z.number(),
    taxUsd: z.number(),
    refundUsd: z.number(),
    feeUsd: z.number(),
    netUsd: z.number(),
    matchedCount: z.number(),
    exceptionCount: z.number(),
  }),
  nextActions: z.array(z.string()),
});

export type CommerceReconciliationResult = z.infer<
  typeof commerceReconciliationResultSchema
>;

export const bankRecDiffResultSchema = z.object({
  clientName: z.string(),
  period: z.string(),
  rows: z.array(
    z.object({
      id: z.string(),
      side: z.enum(['bank', 'books', 'matched']),
      description: z.string(),
      amountUsd: z.number(),
      date: z.string(),
      proposedMatchId: z.string().optional(),
      status: z.enum([
        'unmatched',
        'proposed_match',
        'cleared',
        'rejected',
      ]),
      confidence: confidenceSchema,
    }),
  ),
  totals: z.object({
    bankOnlyCount: z.number(),
    booksOnlyCount: z.number(),
    matchedCount: z.number(),
    clearedCount: z.number(),
  }),
});

export type BankRecDiffResult = z.infer<typeof bankRecDiffResultSchema>;

export const receiptChaseResultSchema = z.object({
  clientName: z.string(),
  period: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      vendor: z.string().optional(),
      amountUsd: z.number().optional(),
      date: z.string().optional(),
      source: z.enum(['inbox', 'stripe', 'upload', 'other']),
      sourceUrl: z.string().optional(),
      proposedCategory: z.string().optional(),
      status: z.enum([
        'found',
        'proposed',
        'posted',
        'rejected',
        'missing',
      ]),
      confidence: confidenceSchema,
    }),
  ),
  totals: z.object({
    foundCount: z.number(),
    postedCount: z.number(),
    missingCount: z.number(),
  }),
});

export type ReceiptChaseResult = z.infer<typeof receiptChaseResultSchema>;

export const taskExtractedDataSchema = z.union([
  monthEndExceptionReportSchema,
  taxCodeDeltaBriefResultSchema,
  commerceReconciliationResultSchema,
  bankRecDiffResultSchema,
  receiptChaseResultSchema,
]);

export type TaskExtractedData = z.infer<typeof taskExtractedDataSchema>;

export const taskResultSchema = z.object({
  taskType: taskTypeSchema,
  summary: z.string(),
  extractedData: taskExtractedDataSchema,
  followUpActions: z.array(z.string()).optional(),
  completedAt: z.number(),
  totalSteps: z.number(),
  totalExecutionTimeMs: z.number(),
});

export type TaskResult = z.infer<typeof taskResultSchema>;

const schemaByTaskType = {
  month_end_exception: monthEndExceptionReportSchema,
  tax_code_delta: taxCodeDeltaBriefResultSchema,
  commerce_reconciliation: commerceReconciliationResultSchema,
  bank_rec_diff: bankRecDiffResultSchema,
  receipt_chase: receiptChaseResultSchema,
} as const;

/** Validate done.extractedData for the active task type before task_complete. */
export function parseExtractedData(
  taskType: TaskType,
  data: unknown,
): TaskExtractedData {
  return schemaByTaskType[taskType].parse(data) as TaskExtractedData;
}

export function parseTaskResult(data: unknown): TaskResult {
  return taskResultSchema.parse(data);
}
