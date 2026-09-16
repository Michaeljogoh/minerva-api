import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { TaskResult } from '@common/schemas/task-result.schemas';

export type ToolEventMap = {
  screenshot: { clientId: string; url: string; timestamp: number };
  human_approval_required: {
    clientId: string;
    approvalId: string;
    question: string;
    context: string;
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
