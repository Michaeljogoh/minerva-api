import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { z } from 'zod';
import type {
  ChatWithToolsParams,
  ChatWithToolsResult,
  CompleteJsonParams,
  ModelChatMessage,
  ModelProvider,
} from './model-provider';
import { ExternalModelService } from './external-model.service';
import {
  MODEL_RUN_CONFIG,
  type ModelRunConfigSource,
} from './external-model.types';

/**
 * OpenAI Chat Completions client. When the current run carries a user key
 * (OpenAI, or Gemini's OpenAI-compatible endpoint) that key and model are
 * used; otherwise the server's own key and env models.
 */
@Injectable()
export class OpenAiProvider implements ModelProvider {
  private client: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly externalModels: ExternalModelService,
    @Inject(MODEL_RUN_CONFIG) private readonly runConfig: ModelRunConfigSource,
  ) {}

  private getClient(): OpenAI {
    const external = this.runConfig.getExternalModel();
    if (external) {
      return this.externalModels.clientFor(external);
    }
    if (!this.client) {
      const apiKey = this.config.get<string>('openai.apiKey') ?? '';
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required');
      }
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  agentModel(override?: string): string {
    const external = this.runConfig.getExternalModel();
    if (external) {
      return external.model;
    }
    if (override?.trim()) {
      return override.trim();
    }
    const model = this.config.get<string>('openai.model')?.trim() ?? '';
    if (!model) {
      throw new Error('OPENAI_MODEL is required');
    }
    return model;
  }

  /** Chat Completions `reasoning_effort`; model-dependent when env is unset. */
  reasoningEffort(model: string): OpenAI.ReasoningEffort | undefined {
    const external = this.runConfig.getExternalModel();
    if (external?.provider === 'gemini') {
      return undefined;
    }
    const configured = external
      ? undefined
      : this.config.get<string>('openai.reasoningEffort')?.trim();
    if (configured) {
      return parseReasoningEffort(configured);
    }
    const id = model.trim().toLowerCase();
    if (id.includes('luna')) {
      return 'none';
    }
    if (id.includes('mini')) {
      return 'minimal';
    }
    return undefined;
  }

  plannerModel(override?: string): string {
    const external = this.runConfig.getExternalModel();
    if (external) {
      return external.model;
    }
    if (override?.trim()) {
      return override.trim();
    }
    const model =
      this.config.get<string>('openai.plannerModel')?.trim() ||
      this.config.get<string>('openai.model')?.trim() ||
      '';
    if (!model) {
      throw new Error('OPENAI_PLANNER_MODEL or OPENAI_MODEL is required');
    }
    return model;
  }

  chatWithTools(params: ChatWithToolsParams): Promise<ChatWithToolsResult> {
    return this.withRunErrors(() => this.requestChatWithTools(params));
  }

  completeJson<T extends z.ZodTypeAny>(
    params: CompleteJsonParams<T>,
  ): Promise<z.infer<T>> {
    return this.withRunErrors(() => this.requestCompleteJson(params));
  }

  private async requestChatWithTools(
    params: ChatWithToolsParams,
  ): Promise<ChatWithToolsResult> {
    const client = this.getClient();
    const model = this.agentModel(params.model);

    const reasoningEffort = this.reasoningEffort(model);
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: params.system },
          ...params.messages.map(toOpenAiMessage),
        ],
        tools: params.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        // Runs end only through the `done` tool, so a text-only reply would stall the loop.
        ...(params.tools.length > 0
          ? { tool_choice: 'required' as const }
          : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      { signal: params.abortSignal },
    );

    const choice = response.choices[0]?.message;
    if (!choice) {
      throw new Error('OpenAI returned no message choice');
    }

    const toolCalls = choice.tool_calls?.map((tc) => {
      if (tc.type !== 'function') {
        throw new Error('Unsupported tool call type');
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments ?? '{}',
      };
    });

    return {
      message: {
        role: 'assistant',
        content: choice.content ?? undefined,
        toolCalls,
      },
    };
  }

  private async requestCompleteJson<T extends z.ZodTypeAny>(
    params: CompleteJsonParams<T>,
  ): Promise<z.infer<T>> {
    const client = this.getClient();
    const model = this.plannerModel(params.model);
    const jsonSchema = z.toJSONSchema(params.schema);

    const reasoningEffort = this.reasoningEffort(model);
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'plan',
            strict: true,
            schema: jsonSchema as Record<string, unknown>,
          },
        },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      { signal: params.abortSignal },
    );

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Planner returned empty JSON');
    }
    const parsed: unknown = JSON.parse(text);
    return params.schema.parse(parsed);
  }

  private async withRunErrors<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      const external = this.runConfig.getExternalModel();
      throw external ? this.externalModels.toRunError(err, external) : err;
    }
  }
}

const REASONING_EFFORT_VALUES: OpenAI.ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function parseReasoningEffort(
  value: string,
): OpenAI.ReasoningEffort | undefined {
  if (REASONING_EFFORT_VALUES.includes(value as OpenAI.ReasoningEffort)) {
    return value as OpenAI.ReasoningEffort;
  }
  return undefined;
}

function toOpenAiMessage(
  msg: ModelChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId ?? '',
      content: msg.content ?? '',
    };
  }
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return {
    role: msg.role,
    content: msg.content ?? '',
  };
}
