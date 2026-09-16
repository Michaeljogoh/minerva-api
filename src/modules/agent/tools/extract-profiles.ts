import { z } from 'zod';

export const taskExtractProfileSchema = z.enum([
  'bank_rows',
  'exception_table',
  'receipt_items',
  'irs_findings',
]);

export type TaskExtractProfile = z.infer<typeof taskExtractProfileSchema>;

export const schemaHintSchema = z.enum(['table', 'list', 'text', 'custom']);

export type SchemaHint = z.infer<typeof schemaHintSchema>;

const exceptionTableExtractSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().optional(),
      description: z.string(),
      amountUsd: z.number().optional(),
      date: z.string().optional(),
      source: z.string().optional(),
      proposedCategory: z.string().optional(),
      taxSensitive: z.boolean().optional(),
    }),
  ),
});

const bankRowsExtractSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string().optional(),
      description: z.string(),
      amountUsd: z.number(),
      date: z.string(),
      side: z.enum(['bank', 'books', 'matched']).optional(),
      status: z.string().optional(),
    }),
  ),
});

const receiptItemsExtractSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().optional(),
      vendor: z.string().optional(),
      amountUsd: z.number().optional(),
      date: z.string().optional(),
      source: z.string().optional(),
      proposedCategory: z.string().optional(),
    }),
  ),
});

const irsFindingsExtractSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string(),
      date: z.string().optional(),
      sourceUrl: z.string().optional(),
      summary: z.string(),
    }),
  ),
});

const genericTableSchema = z.object({
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())),
});

const genericListSchema = z.object({
  items: z.array(z.string()),
});

const genericTextSchema = z.object({
  text: z.string(),
});

const customExtractSchema = z.record(z.string(), z.unknown());

const profileSchemas = {
  exception_table: exceptionTableExtractSchema,
  bank_rows: bankRowsExtractSchema,
  receipt_items: receiptItemsExtractSchema,
  irs_findings: irsFindingsExtractSchema,
} as const satisfies Record<TaskExtractProfile, z.ZodType>;

const hintSchemas = {
  table: genericTableSchema,
  list: genericListSchema,
  text: genericTextSchema,
  custom: customExtractSchema,
} as const satisfies Record<SchemaHint, z.ZodType>;

/** Resolve the Zod schema passed to stagehand.extract for a tool call. */
export function resolveExtractSchema(opts: {
  taskExtractProfile?: TaskExtractProfile;
  schemaHint: SchemaHint;
}): z.ZodType {
  if (opts.taskExtractProfile) {
    return profileSchemas[opts.taskExtractProfile];
  }
  return hintSchemas[opts.schemaHint];
}
