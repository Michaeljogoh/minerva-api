import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { ReasoningStep } from '@common/types/reasoning-step.types';
import { TaskControlService } from '@modules/agent/task/task-control.service';
import { ApprovalService } from '@modules/agent/approval/approval.service';
import { BrowserSessionManager } from '@modules/browser/browser-session.manager';
import { taskTypeSchema } from '@common/schemas/task-result.schemas';
import {
  stepFromAgentAction,
  stepFromAgentObservation,
  stepFromAgentReasoning,
  stepFromError,
} from '@modules/persistence/session-step.mapper';
import { SessionService } from '@modules/persistence/session.service';
import { RateLimitService } from '@modules/security/rate-limit.service';
import { GatewayAuthService } from '@modules/security/gateway-auth.service';
import { LIVE_VIEW_CLIENT_REFRESH_MIN_MS } from '@common/constants/session-lifecycle.constants';
import type { ProtocolOutbound } from './adk-event.mapper';
import { GatewayEventBridge } from './gateway-event.bridge';
import { TaskRunCoordinator } from './task-run.coordinator';

const startTaskSchema = z.object({
  goal: z.string().min(1),
  taskType: taskTypeSchema.optional(),
  usePlanner: z.boolean().optional(),
});

const approveActionSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  answer: z.string().optional(),
});

const injectGuidanceSchema = z.object({
  message: z.string().min(1),
});

/** CORS is applied at bootstrap via CorsIoAdapter (ConfigService frontendUrl). */
@WebSocketGateway()
export class AgentGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  private readonly logger = new Logger(AgentGateway.name);

  @WebSocketServer()
  server!: Server;

  private readonly running = new Set<string>();
  private readonly clientIps = new Map<string, string>();
  private readonly lastReasoning = new Map<string, { value: string }>();
  private readonly lastLiveViewRefreshAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly browsers: BrowserSessionManager,
    private readonly taskControl: TaskControlService,
    private readonly approvals: ApprovalService,
    private readonly rateLimit: RateLimitService,
    private readonly gatewayAuth: GatewayAuthService,
    private readonly taskRuns: TaskRunCoordinator,
    private readonly eventBridge: GatewayEventBridge,
    private readonly sessions: SessionService,
  ) {}

  afterInit(): void {
    this.eventBridge.attach({
      emitToClient: (clientId, event, payload) =>
        this.emitToClient(clientId, event, payload),
      isRunning: (clientId) => this.running.has(clientId),
      haltClient: (clientId, opts) => this.haltClient(clientId, opts),
    });
  }

  handleConnection(client: Socket): void {
    try {
      this.gatewayAuth.assertAuthorized(
        this.gatewayAuth.tokenFromHandshake(client),
      );
    } catch {
      this.logger.warn(`Rejected unauthorized WebSocket client ${client.id}`);
      client.disconnect(true);
      return;
    }
    const ip = this.clientIp(client);
    this.clientIps.set(client.id, ip);
    this.logger.log(`Client connected ${client.id} ip=${ip}`);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Client disconnected ${client.id}`);
    this.approvals.rejectAllForClient(client.id);
    await this.haltClient(client.id, { emitStopped: false, status: 'stopped' });
    this.clientIps.delete(client.id);
    this.lastLiveViewRefreshAt.delete(client.id);
  }

  @SubscribeMessage('start_task')
  async onStartTask(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const parsed = startTaskSchema.safeParse(body);
    if (!parsed.success) {
      this.emitError(client.id, 'Invalid start_task payload', {
        recoverable: true,
      });
      return;
    }

    if (this.running.has(client.id)) {
      this.emitError(client.id, 'A task is already running', {
        recoverable: true,
      });
      return;
    }

    const ip = this.clientIps.get(client.id) ?? this.clientIp(client);
    try {
      this.rateLimit.assertCanStartSession(ip, client.id);
    } catch (err) {
      this.emitError(
        client.id,
        err instanceof Error ? err.message : String(err),
        { recoverable: false, fatal: true },
      );
      return;
    }

    this.running.add(client.id);
    this.lastReasoning.set(client.id, { value: '' });
    const abortSignal = this.taskControl.beginRun(client.id);

    try {
      const ifRunning = (fn: () => void) => {
        if (this.running.has(client.id)) {
          fn();
        }
      };

      await this.taskRuns.execute({
        clientId: client.id,
        goal: parsed.data.goal,
        taskType: parsed.data.taskType,
        usePlanner: parsed.data.usePlanner,
        abortSignal,
        lastReasoning: this.lastReasoning.get(client.id) ?? { value: '' },
        callbacks: {
          onBrowserReady: ({ liveUrl, sessionId }) => {
            ifRunning(() => client.emit('browser_ready', { liveUrl, sessionId }));
          },
          onScreenshotOnlyNotice: () => {
            ifRunning(() =>
              client.emit('agent_reasoning', {
                timestamp: Date.now(),
                thought:
                  'Live session URL unavailable — running in screenshot-only mode; page state will stream via screenshots after each action.',
              }),
            );
          },
          onAgentReasoning: (thought) => {
            ifRunning(() => {
              const event = { timestamp: Date.now(), thought };
              this.recordClientStep(client.id, stepFromAgentReasoning(event));
              client.emit('agent_reasoning', event);
            });
          },
          onProtocolEvent: (event) => {
            ifRunning(() => {
              this.recordProtocolStep(client.id, event);
              client.emit(event.name, event.payload);
            });
          },
          onError: (message, opts) => {
            ifRunning(() => this.emitError(client.id, message, opts));
          },
        },
      });
    } finally {
      if (this.running.has(client.id)) {
        this.running.delete(client.id);
        this.taskControl.clear(client.id);
        this.rateLimit.releaseSession(ip, client.id);
      }
      await this.taskRuns.releaseBrowserIfIdle(client.id);
      this.lastReasoning.delete(client.id);
    }
  }

  @SubscribeMessage('approve_action')
  onApproveAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): void {
    const parsed = approveActionSchema.safeParse(body);
    if (!parsed.success) {
      this.emitError(client.id, 'Invalid approve_action payload', {
        recoverable: true,
      });
      return;
    }
    const ok = this.approvals.resolveApproval(
      client.id,
      parsed.data.approvalId,
      parsed.data.approved,
      parsed.data.answer,
    );
    if (!ok) {
      this.emitError(
        client.id,
        `Unknown or expired approvalId: ${parsed.data.approvalId}`,
        { recoverable: true },
      );
    }
  }

  @SubscribeMessage('pause_task')
  onPauseTask(@ConnectedSocket() client: Socket): void {
    if (!this.running.has(client.id)) {
      return;
    }
    this.taskControl.pause(client.id);
    client.emit('task_paused', { timestamp: Date.now() });
  }

  @SubscribeMessage('resume_task')
  onResumeTask(@ConnectedSocket() client: Socket): void {
    if (!this.running.has(client.id)) {
      return;
    }
    this.taskControl.resume(client.id);
    client.emit('task_resumed', { timestamp: Date.now() });
  }

  @SubscribeMessage('inject_guidance')
  onInjectGuidance(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): void {
    const parsed = injectGuidanceSchema.safeParse(body);
    if (!parsed.success) {
      this.emitError(client.id, 'Invalid inject_guidance payload', {
        recoverable: true,
      });
      return;
    }
    this.taskControl.queueGuidance(client.id, parsed.data.message);
  }

  @SubscribeMessage('refresh_live_view')
  async onRefreshLiveView(@ConnectedSocket() client: Socket): Promise<void> {
    if (!this.browsers.hasLiveSession(client.id)) {
      return;
    }
    const lastAt = this.lastLiveViewRefreshAt.get(client.id) ?? 0;
    if (Date.now() - lastAt < LIVE_VIEW_CLIENT_REFRESH_MIN_MS) {
      return;
    }
    this.lastLiveViewRefreshAt.set(client.id, Date.now());
    try {
      const liveUrl = await this.browsers.getLiveSessionUrl(client.id);
      const sessionId = this.browsers.getBrowserSession(client.id)?.sessionId;
      if (!sessionId) {
        return;
      }
      client.emit('live_view', { liveUrl, sessionId });
    } catch (err) {
      this.logger.warn(
        `Live view refresh failed for ${client.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  @SubscribeMessage('stop_task')
  async onStopTask(@ConnectedSocket() client: Socket): Promise<void> {
    await this.haltClient(client.id, { emitStopped: true, status: 'stopped' });
  }

  private async haltClient(
    clientId: string,
    opts: { emitStopped: boolean; status: 'stopped' | 'error' },
  ): Promise<void> {
    const wasRunning = this.running.has(clientId);
    this.approvals.rejectAllForClient(clientId);
    this.taskControl.stop(clientId);
    if (opts.emitStopped) {
      this.emitToClient(clientId, 'task_stopped', { timestamp: Date.now() });
    }
    await this.browsers.closeBrowserSession(clientId, { status: opts.status });
    this.lastLiveViewRefreshAt.delete(clientId);
    if (wasRunning) {
      const ip = this.clientIps.get(clientId) ?? 'unknown';
      this.rateLimit.releaseSession(ip, clientId);
      this.running.delete(clientId);
      this.taskControl.clear(clientId);
      this.lastReasoning.delete(clientId);
    }
  }

  private emitToClient(
    clientId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server.to(clientId).emit(event, payload);
  }

  private emitError(
    clientId: string,
    error: string,
    opts?: { recoverable?: boolean; fatal?: boolean },
  ): void {
    const payload = {
      timestamp: Date.now(),
      error,
      recoverable: opts?.recoverable,
      fatal: opts?.fatal,
    };
    this.recordClientStep(clientId, stepFromError(payload));
    this.emitToClient(clientId, 'agent_error', payload);
  }

  private recordClientStep(
    clientId: string,
    step: Omit<ReasoningStep, 'id'>,
  ): void {
    this.sessions.queueStep(
      this.browsers.getBrowserSession(clientId)?.recordId,
      step,
    );
  }

  private recordProtocolStep(
    clientId: string,
    event: ProtocolOutbound,
  ): void {
    switch (event.name) {
      case 'agent_reasoning':
        this.recordClientStep(clientId, stepFromAgentReasoning(event.payload));
        break;
      case 'agent_action':
        this.recordClientStep(clientId, stepFromAgentAction(event.payload));
        break;
      case 'agent_observation':
        this.recordClientStep(
          clientId,
          stepFromAgentObservation(event.payload),
        );
        break;
    }
  }

  private clientIp(client: Socket): string {
    const trustProxy =
      this.config.get<boolean>('security.trustProxy') ?? false;
    if (trustProxy) {
      const forwarded = client.handshake.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0]?.trim() || client.handshake.address;
      }
    }
    return client.handshake.address;
  }
}
