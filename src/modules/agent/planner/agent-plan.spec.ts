import { formatPlanForExecutor, type AgentPlan } from './agent-plan';

describe('formatPlanForExecutor', () => {
  it('orders steps and includes goal', () => {
    const plan: AgentPlan = {
      inferredTaskType: 'month_end_exception',
      steps: [
        { order: 2, action: 'Open bank feed', rationale: 'Find exceptions' },
        { order: 1, action: 'Navigate to books', rationale: 'Start in QB' },
      ],
      notes: 'Ask before categorize',
    };

    const text = formatPlanForExecutor('Sweep month-end exceptions', plan);

    expect(text).toContain('Sweep month-end exceptions');
    expect(text).toContain('Inferred task type: month_end_exception');
    expect(text).toContain('1. Navigate to books');
    expect(text).toContain('2. Open bank feed');
    expect(text).toContain('Ask before categorize');
  });
});
