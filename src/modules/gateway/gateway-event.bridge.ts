import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ToolEventBus } from '@modules/agent/tools/tool-event.bus';
import { BrowserSessionManager } from '@modules/browser/browser-session.manager';
import type { TaskResult } from '@common/schemas/task-result.schemas';
import {
  stepFromApproval,
  stepFromScreenshot,
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
    private readonly browsers: BrowserSessionManager,
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
    this.toolEvents.on('live_view', this.onLiveView);
    this.toolEvents.on('connection_ready', this.onConnectionReady);
  }

  onModuleDestroy(): void {
    this.toolEvents.off('screenshot', this.onScreenshot);
    this.toolEvents.off('human_approval_required', this.onApprovalRequired);
    this.toolEvents.off('task_complete', this.onTaskComplete);
    this.toolEvents.off('browser_crash', this.onBrowserCrash);
    this.toolEvents.off('live_view', this.onLiveView);
    this.toolEvents.off('connection_ready', this.onConnectionReady);
  }

  private recordIdFor(clientId: string): string | undefined {
    return this.browsers.getBrowserSession(clientId)?.recordId;
  }

  private readonly onScreenshot = (payload: {
    clientId: string;
    url: string;
    timestamp: number;
    step: number;
    tool?: string;
    caption?: string;
    imageUrl: string;
  }) => {
    this.sessions.queueStep(
      this.recordIdFor(payload.clientId),
      stepFromScreenshot(payload),
    );
    this.host?.emitToClient(payload.clientId, 'screenshot', {
      url: payload.url,
      timestamp: payload.timestamp,
    });
    this.host?.emitToClient(payload.clientId, 'step_update', {
      step: payload.step,
      tool: payload.tool,
      caption: payload.caption,
      imageUrl: payload.imageUrl,
      timestamp: payload.timestamp,
    });
  };

  private readonly onApprovalRequired = (payload: {
    clientId: string;
    approvalId: string;
    question: string;
    context: string;
    kind?: 'approval' | 'login' | 'connect' | 'connect_input';
    connectUrl?: string;
    appName?: string;
    inputLabel?: string;
    inputPlaceholder?: string;
  }) => {
    this.sessions.queueStep(
      this.recordIdFor(payload.clientId),
      stepFromApproval({
        timestamp: Date.now(),
        question: payload.question,
      }),
    );
    this.host?.emitToClient(payload.clientId, 'human_approval_required', {
      approvalId: payload.approvalId,
      question: payload.question,
      context: payload.context,
      kind: payload.kind ?? 'approval',
      connectUrl: payload.connectUrl,
      appName: payload.appName,
      inputLabel: payload.inputLabel,
      inputPlaceholder: payload.inputPlaceholder,
    });
  };

  private readonly onConnectionReady = (payload: {
    clientId: string;
    toolkit: string;
  }) => {
    this.host?.emitToClient(payload.clientId, 'connection_ready', {
      toolkit: payload.toolkit,
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
      const result = payload.data as TaskResult;
      void this.sessions.persistResult(recordId, result, result.taskType);
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

  private readonly onLiveView = (payload: {
    clientId: string;
    liveUrl: string;
    sessionId: string;
  }) => {
    this.host?.emitToClient(payload.clientId, 'live_view', {
      liveUrl: payload.liveUrl,
      sessionId: payload.sessionId,
    });
  };
}
