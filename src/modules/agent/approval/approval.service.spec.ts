import { ApprovalService } from './approval.service';
import { ToolEventBus } from '../tools/tool-event.bus';

describe('ApprovalService', () => {
  const events = new ToolEventBus();
  const service = new ApprovalService(events);

  afterEach(() => {
    service.rejectAllForClient('client-a');
    service.rejectAllForClient('client-b');
  });

  it('resolves approval only for owning client', async () => {
    let approvalId = '';
    events.on('human_approval_required', (payload) => {
      approvalId = payload.approvalId;
    });

    const pending = service.requestApproval({
      clientId: 'client-a',
      sessionId: 'sess-1',
      question: 'Proceed?',
      context: 'test',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(approvalId).toMatch(/^sess-1-/);

    expect(
      service.resolveApproval('client-b', approvalId, true, 'no'),
    ).toBe(false);
    expect(
      service.resolveApproval('client-a', approvalId, true, 'yes'),
    ).toBe(true);

    const result = await pending;
    expect(result.approved).toBe(true);
    expect(result.humanResponse).toBe('yes');
  });

  it('rejects pending approvals when client disconnects', async () => {
    const pending = service.requestApproval({
      clientId: 'client-a',
      sessionId: 'sess-2',
      question: 'Proceed?',
      context: 'test',
    });

    await new Promise((r) => setTimeout(r, 0));
    service.rejectAllForClient('client-a');
    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.humanResponse).toBe('Client disconnected');
  });
});
