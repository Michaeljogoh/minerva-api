/** ADK-compatible event shape for {@link mapAdkEventToProtocol}. */
export interface AgentEventLike {
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

export function reasoningEvent(
  author: string,
  text: string,
  thought = false,
): AgentEventLike {
  return {
    author,
    content: {
      parts: [{ text, thought }],
    },
  };
}

export function functionCallEvent(
  author: string,
  name: string,
  args: Record<string, unknown>,
): AgentEventLike {
  return {
    author,
    content: {
      parts: [{ functionCall: { name, args } }],
    },
  };
}

export function functionResponseEvent(
  author: string,
  name: string,
  response: unknown,
): AgentEventLike {
  return {
    author,
    content: {
      parts: [{ functionResponse: { name, response } }],
    },
  };
}
