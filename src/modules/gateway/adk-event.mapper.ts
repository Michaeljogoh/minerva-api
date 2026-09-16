/** Minimal ADK-shaped event fields used for Socket.IO mapping. */
export interface AdkEventLike {
  author?: string;
  content?: {
    parts?: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
      };
      functionResponse?: {
        name?: string;
        response?: unknown;
      };
    }>;
  };
}

export type ProtocolOutbound =
  | { name: 'agent_reasoning'; payload: { timestamp: number; thought: string } }
  | {
      name: 'agent_action';
      payload: {
        timestamp: number;
        tool: string;
        args: Record<string, unknown>;
        reasoning: string;
      };
    }
  | {
      name: 'agent_observation';
      payload: {
        timestamp: number;
        tool: string;
        result: unknown;
        success: boolean;
      };
    };

/**
 * Map an ADK Event onto public Socket.IO protocol events (§12).
 * Screenshot / approval / task_complete come from ToolEventBus instead.
 */
export function mapAdkEventToProtocol(
  event: AdkEventLike,
  lastReasoning: { value: string },
): ProtocolOutbound[] {
  const out: ProtocolOutbound[] = [];
  const timestamp = Date.now();
  const parts = event.content?.parts ?? [];

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const responses: Array<{ name: string; response: unknown }> = [];
  let hasThought = false;

  for (const part of parts) {
    if (part.thought && typeof part.text === 'string' && part.text.trim()) {
      hasThought = true;
      const thought = part.text.trim();
      lastReasoning.value = thought;
      out.push({
        name: 'agent_reasoning',
        payload: { timestamp, thought },
      });
    }
    if (part.functionCall?.name) {
      calls.push({
        name: part.functionCall.name,
        args:
          part.functionCall.args && typeof part.functionCall.args === 'object'
            ? part.functionCall.args
            : {},
      });
    }
    if (part.functionResponse?.name) {
      responses.push({
        name: part.functionResponse.name,
        response: part.functionResponse.response,
      });
    }
  }

  // Plain text without tool calls = streamed reasoning / plan-before-act.
  if (calls.length === 0 && responses.length === 0 && !hasThought) {
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    if (text && event.author && event.author !== 'user') {
      lastReasoning.value = text;
      out.push({
        name: 'agent_reasoning',
        payload: { timestamp, thought: text },
      });
    }
  }

  for (const call of calls) {
    out.push({
      name: 'agent_action',
      payload: {
        timestamp,
        tool: call.name,
        args: call.args,
        reasoning: lastReasoning.value,
      },
    });
  }

  for (const resp of responses) {
    let parsed: unknown = resp.response;
    if (typeof resp.response === 'string') {
      try {
        parsed = JSON.parse(resp.response) as unknown;
      } catch {
        parsed = resp.response;
      }
    }
    const success =
      parsed !== null &&
      typeof parsed === 'object' &&
      'success' in parsed
        ? Boolean((parsed as { success: unknown }).success)
        : true;

    out.push({
      name: 'agent_observation',
      payload: {
        timestamp,
        tool: resp.name,
        result: parsed,
        success,
      },
    });
  }

  return out;
}
