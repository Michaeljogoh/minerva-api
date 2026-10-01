import type { z } from 'zod';

export interface ModelChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatWithToolsParams {
  model?: string;
  system: string;
  messages: ModelChatMessage[];
  tools: ModelToolDefinition[];
  abortSignal?: AbortSignal;
}

export interface ChatWithToolsResult {
  message: ModelChatMessage;
}

export interface CompleteJsonParams<T extends z.ZodTypeAny> {
  model?: string;
  system: string;
  user: string;
  schema: T;
  abortSignal?: AbortSignal;
}

export interface ModelProvider {
  chatWithTools(params: ChatWithToolsParams): Promise<ChatWithToolsResult>;
  completeJson<T extends z.ZodTypeAny>(
    params: CompleteJsonParams<T>,
  ): Promise<z.infer<T>>;
}

export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');
