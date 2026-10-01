import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { BROWSER_AGENT_NAME } from '@common/constants/agent.constants';
import {
  MODEL_PROVIDER,
  type ModelChatMessage,
  type ModelProvider,
} from '@modules/model/model-provider';
import type { AgentTool } from './agent-tool';
import {
  functionCallEvent,
  functionResponseEvent,
  reasoningEvent,
  type AgentEventLike,
} from './agent-event';

export const AGENT_MAX_TOOL_STEPS = 80;

export interface ToolCallingRunParams {
  system: string;
  userMessage: string;
  tools: AgentTool[];
  author?: string;
  abortSignal?: AbortSignal;
  beforeTool?: () => void | Promise<void>;
  injectGuidance?: () => string | null;
}

@Injectable()
export class ToolCallingOrchestrator {
  private readonly logger = new Logger(ToolCallingOrchestrator.name);

  constructor(
    @Inject(MODEL_PROVIDER) private readonly model: ModelProvider,
  ) {}

  async *run(params: ToolCallingRunParams): AsyncGenerator<
    AgentEventLike,
    void,
    undefined
  > {
    const author = params.author ?? BROWSER_AGENT_NAME;
    const toolByName = new Map(params.tools.map((t) => [t.name, t]));
    const openAiTools = params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    }));

    const messages: ModelChatMessage[] = [
      { role: 'user', content: params.userMessage },
    ];

    for (let step = 0; step < AGENT_MAX_TOOL_STEPS; step++) {
      if (params.abortSignal?.aborted) {
        return;
      }

      const guidance = params.injectGuidance?.();
      if (guidance?.trim()) {
        messages.push({
          role: 'user',
          content: `Human guidance (follow on the next steps):\n${guidance.trim()}`,
        });
      }

      const result = await this.model.chatWithTools({
        system: params.system,
        messages,
        tools: openAiTools,
        abortSignal: params.abortSignal,
      });

      const assistant = result.message;
      messages.push(assistant);

      if (assistant.content?.trim()) {
        yield reasoningEvent(author, assistant.content.trim());
      }

      const toolCalls = assistant.toolCalls ?? [];
      if (toolCalls.length === 0) {
        this.logger.warn(`Agent step ${step + 1} ended without tool calls`);
        return;
      }

      let terminalDone = false;

      for (const call of toolCalls) {
        if (params.abortSignal?.aborted) {
          return;
        }

        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }

        yield functionCallEvent(author, call.name, args);

        await params.beforeTool?.();

        const tool = toolByName.get(call.name);
        let responsePayload: unknown;
        if (!tool) {
          responsePayload = {
            success: false,
            observation: `Unknown tool: ${call.name}`,
            error: 'unknown_tool',
          };
        } else {
          try {
            responsePayload = await tool.execute(args);
          } catch (err) {
            responsePayload = {
              success: false,
              observation: err instanceof Error ? err.message : String(err),
              error: 'tool_execute_error',
            };
          }
        }

        const responseText =
          typeof responsePayload === 'string'
            ? responsePayload
            : JSON.stringify(responsePayload);

        yield functionResponseEvent(author, call.name, responsePayload);

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: responseText,
        });

        if (call.name === 'done') {
          const ok =
            responsePayload !== null &&
            typeof responsePayload === 'object' &&
            'success' in responsePayload &&
            Boolean((responsePayload as { success: unknown }).success);
          if (ok) {
            terminalDone = true;
          }
        }
      }

      if (terminalDone) {
        return;
      }
    }

    this.logger.warn(`Agent hit max tool steps (${AGENT_MAX_TOOL_STEPS})`);
  }
}
