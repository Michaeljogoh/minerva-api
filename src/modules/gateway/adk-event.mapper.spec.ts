import {
  mapAdkEventToProtocol,
  type AdkEventLike,
} from './adk-event.mapper';

describe('mapAdkEventToProtocol', () => {
  it('maps plain agent text to agent_reasoning', () => {
    const lastReasoning = { value: '' };
    const event: AdkEventLike = {
      author: 'browser-automation-agent',
      content: { parts: [{ text: 'I will open the bank feed' }] },
    };

    const mapped = mapAdkEventToProtocol(event, lastReasoning);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.name).toBe('agent_reasoning');
    expect(mapped[0]?.payload).toMatchObject({
      thought: 'I will open the bank feed',
    });
    expect(lastReasoning.value).toBe('I will open the bank feed');
  });

  it('maps function call to agent_action with prior reasoning', () => {
    const lastReasoning = { value: 'Click next' };
    const event: AdkEventLike = {
      author: 'browser-automation-agent',
      content: {
        parts: [
          {
            functionCall: {
              name: 'act',
              args: { instruction: 'Click the Next button' },
            },
          },
        ],
      },
    };

    const mapped = mapAdkEventToProtocol(event, lastReasoning);
    expect(mapped).toEqual([
      {
        name: 'agent_action',
        payload: {
          timestamp: expect.any(Number),
          tool: 'act',
          args: { instruction: 'Click the Next button' },
          reasoning: 'Click next',
        },
      },
    ]);
  });

  it('maps function response success flag', () => {
    const lastReasoning = { value: '' };
    const event: AdkEventLike = {
      author: 'user',
      content: {
        parts: [
          {
            functionResponse: {
              name: 'navigate',
              response: { success: false, error: 'blocked' },
            },
          },
        ],
      },
    };

    const mapped = mapAdkEventToProtocol(event, lastReasoning);
    expect(mapped[0]?.name).toBe('agent_observation');
    expect(mapped[0]?.payload).toMatchObject({
      tool: 'navigate',
      success: false,
    });
  });
});
