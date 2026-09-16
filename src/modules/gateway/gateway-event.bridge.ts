import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ToolEventBus } from '@modules/agent/tools/tool-event.bus';
import { BrowserbaseManager } from '@modules/browser/browserbase.manager';
import {
  stepFromApproval,
  stepFromScreenshot,
  taskResultFromCompletePayload,
} from '@modules/persistence/session-step.mapper';
import { SessionService } from '@modules/persistence/session.service';

export type ClientEmitter = (
  clientId: string,
  event: string,
  payload: unknown,
) => void;

export interface GatewayEventBridgeHost {
  emitToClient: ClientEmitter;
  isRunning: (clientId: string) => boolean;
  haltClient: (
    clientId: string,
    opts: { emitStopped: boolean; status: 'stopped' | 'error' },
  ) => void | Promise<void>;
}

@Injectable()
export class GatewayEventBridge implements OnModuleInit, OnModuleDestroy {
  private host: GatewayEventBridgeHost | null = null;

  constructor(
    private readonly toolEvents: ToolEventBus,
    private readonly browsers: BrowserbaseManager,
    private readonly sessions: SessionService,
  ) {}

  attach(host: GatewayEventBridgeHost): void {
    this.host = host;
  }

  onModuleInit(): void {
    this.toolEvents.on('screenshot', this.onScreenshot);
    this.toolEvents.on('human_approval_required', this.onApprovalRequired);
    this.toolEvents.on('task_complete', this.onTaskComplete);
    this.toolEvents.on('browser_crash', this.onBrowserCrash);
  }

  onModuleDestroy(): void {
    this.toolEvents.off('screenshot', this.onScreenshot);
    this.toolEvents.off('human_approval_required', this.onApprovalRequired);
    this.toolEvents.off('task_complete', this.onTaskComplete);
    this.toolEvents.off('browser_crash', this.onBrowserCrash);
  }

  private recordIdFor(clientId: string): string | undefined {
    return this.browsers.getBrowserSession(clientId)?.recordId;
  }

  private readonly onScreenshot = (payload: {
    clientId: string;
    url: string;
    timestamp: number;
  }) => {
    const recordId = this.recordIdFor(payload.clientId);
    if (recordId) {
      void this.sessions.appendStep(
        recordId,
        stepFromScreenshot(payload),
      );
    }
    this.host?.emitToClient(payload.clientId, 'screenshot', {
      url: payload.url,
      timestamp: payload.timestamp,
    });
  };

  private readonly onApprovalRequired = (payload: {
    clientId: string;
    approvalId: string;
    question: string;
    context: string;
  }) => {
    const recordId = this.recordIdFor(payload.clientId);
    if (recordId) {
      void this.sessions.appendStep(
        recordId,
        stepFromApproval({
          timestamp: Date.now(),
          question: payload.question,
        }),
      );
    }
    this.host?.emitToClient(payload.clientId, 'human_approval_required', {
      approvalId: payload.approvalId,
      question: payload.question,
      context: payload.context,
    });
  };

  private readonly onTaskComplete = (payload: {
    clientId: string;
    timestamp: number;
    summary: string;
    data: unknown;
  }) => {
    const recordId = this.recordIdFor(payload.clientId);
    if (recordId && payload.data && typeof payload.data === 'object') {
      const result = taskResultFromCompletePayload({
        data: payload.data as never,
      });
      void this.sessions.persistResult(
        recordId,
        result,
        result.taskType,
      );
    }
    this.host?.emitToClient(payload.clientId, 'task_complete', {
      timestamp: payload.timestamp,
      summary: payload.summary,
      data: payload.data,
    });
  };

  private readonly onBrowserCrash = (payload: {
    clientId: string;
    reason: string;
    timestamp: number;
  }) => {
    if (!this.host?.isRunning(payload.clientId)) {
      return;
    }
    this.host.emitToClient(payload.clientId, 'agent_error', {
      timestamp: Date.now(),
      error: `Browser crash: ${payload.reason}`,
      recoverable: false,
      fatal: true,
    });
    void this.host.haltClient(payload.clientId, {
      emitStopped: false,
      status: 'error',
    });
  };
}
