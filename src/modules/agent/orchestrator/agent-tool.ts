import type { z, ZodTypeAny } from 'zod';

export interface AgentTool<T extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  parameters: T;
  execute: (args: z.infer<T>) => Promise<unknown>;
}
