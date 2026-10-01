import { Injectable } from '@nestjs/common';
import type { ApprovalRequest } from '@common/types/reasoning-step.types';
import { APPROVAL_TTL_MS } from '@common/constants/session-lifecycle.constants';
import { ToolEventBus } from '../tools/tool-event.bus';

interface PendingApproval {
  clientId: string;
  request: ApprovalRequest;
  resolve: (value: {
    approved: boolean;
    humanResponse?: string;
  }) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalKind = 'approval' | 'login' | 'connect';

@Injectable()
export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly events: ToolEventBus) {}

  /**
   * Store pending approval, emit human_approval_required, await approve_action or timeout.
   */
  async requestApproval(params: {
    clientId: string;
    sessionId: string;
    question: string;
    context: string;
    kind?: ApprovalKind;
    connectUrl?: string;
    appName?: string;
  }): Promise<{ approved: boolean; humanResponse?: string; observation: string }> {
    const approvalId = `${params.sessionId}-${Date.now()}`;
    const now = Date.now();
    const request: ApprovalRequest = {
      approvalId,
      question: params.question,
      context: params.context,
      timestamp: now,
      timeoutAt: now + APPROVAL_TTL_MS,
    };

    const result = await new Promise<{
      approved: boolean;
      humanResponse?: string;
    }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve({ approved: false, humanResponse: 'Approval timed out after 5 minutes' });
      }, APPROVAL_TTL_MS);

      this.pending.set(approvalId, {
        clientId: params.clientId,
        request,
        resolve,
        timer,
      });
      this.events.emit('human_approval_required', {
        clientId: params.clientId,
        approvalId,
        question: params.question,
        context: params.context,
        kind: params.kind ?? 'approval',
        connectUrl: params.connectUrl,
        appName: params.appName,
      });
    });

    return {
      ...result,
      observation: result.approved
        ? `Human approved: ${result.humanResponse ?? 'ok'}`
        : `Human rejected or timed out: ${result.humanResponse ?? 'no response'}`,
    };
  }

  resolveApproval(
    clientId: string,
    approvalId: string,
    approved: boolean,
    answer?: string,
  ): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.clientId !== clientId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    pending.resolve({ approved, humanResponse: answer });
    return true;
  }

  /** Reject all pending approvals when a client disconnects or is halted. */
  rejectAllForClient(clientId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.clientId !== clientId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(approvalId);
      pending.resolve({
        approved: false,
        humanResponse: 'Client disconnected',
      });
    }
  }

  getPending(approvalId: string): ApprovalRequest | undefined {
    return this.pending.get(approvalId)?.request;
  }
}
