import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { TaskResult } from '@common/schemas/task-result.schemas';

export type ToolEventMap = {
  screenshot: {
    clientId: string;
    url: string;
    timestamp: number;
    step: number;
    tool?: string;
    caption?: string;
    imageUrl: string;
  };
  human_approval_required: {
    clientId: string;
    approvalId: string;
    question: string;
    context: string;
    kind?: 'approval' | 'login' | 'connect' | 'connect_input';
    connectUrl?: string;
    appName?: string;
    inputLabel?: string;
    inputPlaceholder?: string;
  };
  connection_ready: {
    clientId: string;
    toolkit: string;
  };
  task_complete: {
    clientId: string;
    timestamp: number;
    summary: string;
    data: TaskResult;
  };
  browser_crash: {
    clientId: string;
    reason: string;
    timestamp: number;
  };
  live_view: {
    clientId: string;
    liveUrl: string;
    sessionId: string;
  };
};

type EventKey = keyof ToolEventMap;

/**
 * Bridge from tools → gateway Socket.IO emits (wired in §12).
 */
@Injectable()
export class ToolEventBus {
  private readonly emitter = new EventEmitter();

  emit<K extends EventKey>(event: K, payload: ToolEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends EventKey>(
    event: K,
    handler: (payload: ToolEventMap[K]) => void,
  ): void {
    this.emitter.on(event, handler);
  }

  off<K extends EventKey>(
    event: K,
    handler: (payload: ToolEventMap[K]) => void,
  ): void {
    this.emitter.off(event, handler);
  }
}
