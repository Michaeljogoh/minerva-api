import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Page as StagehandPage, Stagehand } from '@browserbasehq/stagehand';
import { ApprovalService } from '../approval/approval.service';
import {
  BROWSER_DEFERRED_CLOSE_MS,
  STAGEHAND_ACTION_TIMEOUT_MS,
  STAGEHAND_DOM_SETTLE_MS,
  STAGEHAND_POST_NAV_QUIET_MS,
} from '@common/constants/session-lifecycle.constants';
import { BrowserSessionManager } from '@modules/browser/browser-session.manager';
import { ComposioService } from '@modules/composio/composio.service';
import { ScreenshotStore } from '@modules/browser/screenshot.store';
import {
  parseExtractedData,
  taskTypeSchema,
  type TaskResult,
  type TaskType,
} from '@common/schemas/task-result.schemas';
import { RateLimitService } from '@modules/security/rate-limit.service';
import { UrlAllowlistService } from '@modules/security/url-allowlist.service';
import { looksSensitiveAction } from '@modules/security/sensitive-action';
import {
  SCREENSHOT_SLOW_MS,
  SCREENSHOT_THROTTLE_MS,
  isBrowserCrashError,
} from '../recovery/error-recovery';
import {
  defaultToolShouldRetry,
  runBrowserTool,
  runWithToolRetry,
  type BrowserToolRunnerCtx,
} from './browser-tool.runner';
import {
  resolveExtractSchema,
  schemaHintSchema,
  taskExtractProfileSchema,
} from './extract-profiles';
import { ToolEventBus } from './tool-event.bus';
import { fail, truncateContent, type ToolResult } from './tool-helpers';
import { ToolSessionContext } from './tool-session.context';
import type { AgentTool } from '../orchestrator/agent-tool';
import { RagService } from '@modules/rag/rag.service';
import { SessionService } from '@modules/persistence/session.service';

@Injectable()
export class StagehandToolsService {
  private readonly lastScreenshotEmitAt = new Map<string, number>();
  private readonly screenshotSlow = new Set<string>();
  private readonly screenshotStep = new Map<string, number>();

  constructor(
    private readonly browsers: BrowserSessionManager,
    private readonly screenshots: ScreenshotStore,
    private readonly allowlist: UrlAllowlistService,
    private readonly rateLimit: RateLimitService,
    private readonly toolCtx: ToolSessionContext,
    private readonly events: ToolEventBus,
    private readonly approvals: ApprovalService,
    private readonly composio: ComposioService,
    private readonly rag: RagService,
    private readonly sessions: SessionService,
  ) {}

  createTools(): AgentTool[] {
    return [
      this.navigateTool(),
      this.actTool(),
      this.observeTool(),
      this.extractTool(),
      this.screenshotTool(),
      this.askHumanTool(),
      this.requestLoginTool(),
      this.requestAppConnectionTool(),
      this.composioExecuteTool(),
      this.doneTool(),
      this.retrieveEvidenceTool(),
    ];
  }

  private defineTool<S extends z.ZodTypeAny>(opts: {
    name: string;
    description: string;
    parameters: S;
    execute: (args: z.infer<S>) => Promise<ToolResult>;
  }): AgentTool {
    return {
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      execute: async (args) => opts.execute(opts.parameters.parse(args)),
    };
  }

  private runnerCtx(): BrowserToolRunnerCtx {
    return {
      requireClientId: () => this.toolCtx.requireClientId(),
      assertPageAllowed: () => this.assertCurrentPageAllowed(),
      assertCanPerformAction: (clientId) =>
        this.rateLimit.assertCanPerformAction(clientId),
      captureAfterAction: (clientId, opts) =>
        this.captureAfterAction(clientId, opts),
      reconnect: (clientId) => this.browsers.reconnect(clientId),
      toolFail: (clientId, observation, error) =>
        this.toolFail(clientId, observation, error),
    };
  }

  private async page(): Promise<StagehandPage> {
    return this.browsers.getStagehandPage(this.toolCtx.requireClientId());
  }

  private async stagehand(): Promise<Stagehand> {
    return this.browsers.getStagehand(this.toolCtx.requireClientId());
  }

  private async assertCurrentPageAllowed(): Promise<void> {
    const page = await this.page();
    await this.allowlist.assertUrlAllowed(await page.url());
  }

  private async captureAfterAction(
    clientId: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const force = opts?.force === true;
    const screenshotOnly = this.toolCtx.isScreenshotOnly();
    // Live Steel stream is the primary view — skip JPEG capture unless we are
    // in screenshot-only mode or the caller forced a snapshot.
    if (!force && !screenshotOnly) {
      return;
    }
    const now = Date.now();
    const lastEmit = this.lastScreenshotEmitAt.get(clientId) ?? 0;

    if (
      !force &&
      this.screenshotSlow.has(clientId) &&
      now - lastEmit < SCREENSHOT_THROTTLE_MS
    ) {
      return;
    }

    try {
      const page = await this.browsers.getStagehandPage(clientId);
      const started = Date.now();
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 60,
        fullPage: false,
      });
      this.saveAndEmitScreenshot(clientId, Buffer.from(buffer), started);
    } catch {
      // Never fail the tool solely because post-action capture failed.
    }
  }

  /** Save JPEG, mark slow captures, emit on ToolEventBus. Returns screenshot id. */
  private saveAndEmitScreenshot(
    clientId: string,
    buffer: Buffer,
    startedAt: number,
    meta?: { tool?: string; caption?: string },
  ): string {
    if (Date.now() - startedAt >= SCREENSHOT_SLOW_MS) {
      this.screenshotSlow.add(clientId);
    }
    const id = this.screenshots.save(clientId, buffer);
    const url = this.screenshots.getDataUrl(id);
    if (url) {
      const step = (this.screenshotStep.get(clientId) ?? 0) + 1;
      this.screenshotStep.set(clientId, step);
      const timestamp = Date.now();
      const entry = {
        step,
        tool: meta?.tool,
        caption: meta?.caption,
        imageUrl: url,
        timestamp,
      };
      this.events.emit('screenshot', {
        clientId,
        url,
        ...entry,
      });
      const recordId = this.browsers.getBrowserSession(clientId)?.recordId;
      this.sessions.queueScreenshot(recordId, entry);
      this.lastScreenshotEmitAt.set(clientId, Date.now());
    }
    return id;
  }

  private toolFail(
    clientId: string,
    observation: string,
    error: unknown,
  ): ToolResult {
    if (isBrowserCrashError(error)) {
      this.events.emit('browser_crash', {
        clientId,
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
    }
    return fail(observation, error);
  }

  private navigateTool() {
    const parameters = z.object({
      url: z.string().describe('Full URL to navigate to'),
      reason: z.string().describe('Why this navigation is necessary'),
    });

    return this.defineTool({
      name: 'navigate',
      description: 'Navigate the browser to a public http/https URL.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        await this.allowlist.assertUrlAllowed(args.url);
        return runBrowserTool(this.runnerCtx(), {
          failObservation: `Navigate failed for ${args.url}. Try an alternate public URL or ask_human.`,
          requireAllowlistedPage: false,
          action: async () => {
            await runWithToolRetry(async () => {
              const page = await this.page();
              await page.goto(args.url, {
                waitUntil: 'domcontentloaded',
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
              await settleStagehandPage(page);
              await this.assertCurrentPageAllowed();
            });
            const page = await this.page();
            const title = await page.title();
            const url = await page.url();
            await this.assertCurrentPageAllowed();
            return {
              success: true,
              title,
              url,
              observation: `Navigated to ${url} (title: ${title}). Reason: ${args.reason}`,
            };
          },
        });
      },
    });
  }

  private actTool() {
    const parameters = z.object({
      instruction: z
        .string()
        .describe(
          'Natural-language action: click a button/link, type into a field, scroll, select an option, etc.',
        ),
      reason: z.string().describe('Why this action is needed'),
    });

    return this.defineTool({
      name: 'act',
      description:
        'Perform a browser interaction via natural language (clicks, typing, scrolling, selections).',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        // Rate limit is enforced once inside runBrowserTool (not here).
        if (looksSensitiveAction(args.instruction)) {
          if (!this.toolCtx.hasHumanApproval()) {
            return {
              success: false,
              observation:
                'Sensitive action blocked — call ask_human and wait for approval before act.',
              error: 'Sensitive action blocked',
            };
          }
          this.toolCtx.consumeHumanApproval();
        }

        return runBrowserTool(this.runnerCtx(), {
          failObservation: `Act failed for "${args.instruction}". Try observe to inspect the page, screenshot, or ask_human.`,
          action: async () => {
            const page = await this.page();
            const result = await runWithToolRetry(async () => {
              // Stagehand act already waits for DOM/network quiet — skip our
              // extra settle so clicks feel snappy.
              const sh = await this.stagehand();
              return sh.act(args.instruction, {
                page,
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
            });
            await this.assertCurrentPageAllowed();
            const actionDesc = result.data.actionDescription || args.instruction;
            return {
              success: result.data.success,
              observation: result.data.success
                ? `Act succeeded: ${actionDesc}. Reason: ${args.reason}`
                : `Act failed: ${result.data.message}. Try observe, screenshot, or ask_human.`,
              error: result.data.success ? undefined : result.data.message,
            };
          },
        });
      },
    });
  }

  private observeTool() {
    const parameters = z.object({
      instruction: z
        .string()
        .optional()
        .describe(
          'What to look for on the page; omit for a general interactive-element inventory',
        ),
      reason: z.string().describe('Why observation is needed'),
    });

    return this.defineTool({
      name: 'observe',
      description:
        'Discover actionable elements on the page before act (buttons, links, inputs, etc.).',
      parameters,
      execute: async (args): Promise<ToolResult> =>
        runBrowserTool(this.runnerCtx(), {
          failObservation:
            'Observe failed. Try screenshot or navigate to refresh the page.',
          captureOnSuccess: false,
          action: async () => {
            const page = await this.page();
            const instruction =
              args.instruction?.trim() ||
              'List all interactive elements visible on the page';
            const result = await runWithToolRetry(async () => {
              await settleStagehandPage(page);
              const sh = await this.stagehand();
              return sh.observe(instruction, {
                page,
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
            });
            const elements = result.data.map((el) => ({
              description: el.description,
              selector: el.selector,
              method: el.method,
            }));
            return {
              success: true,
              elements,
              observation: `Observed ${elements.length} candidate element(s). ${args.reason}. ${JSON.stringify(elements).slice(0, 2000)}`,
            };
          },
        }),
    });
  }

  private extractTool() {
    const parameters = z.object({
      instruction: z.string().describe('Specific extraction instructions'),
      schemaHint: schemaHintSchema.describe(
        'Shape of data to extract when taskExtractProfile is omitted',
      ),
      reason: z.string().describe('Why extraction is needed'),
      taskExtractProfile: taskExtractProfileSchema
        .optional()
        .describe(
          'Task-specific extract schema: exception_table, bank_rows, commerce_rows, receipt_items, irs_findings',
        ),
    });

    return this.defineTool({
      name: 'extract',
      description:
        'Extract structured content from the page using Stagehand + Zod schema.',
      parameters,
      execute: async (args): Promise<ToolResult> =>
        runBrowserTool(this.runnerCtx(), {
          failObservation: 'Extract failed',
          captureOnSuccess: false,
          action: async () => {
            const schema = resolveExtractSchema({
              taskExtractProfile: args.taskExtractProfile,
              schemaHint: args.schemaHint,
            });
            const page = await this.page();
            const result = await runWithToolRetry(async () => {
              await settleStagehandPage(page);
              const sh = await this.stagehand();
              return sh.extract(args.instruction, schema as never, {
                page,
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
            });
            const content = truncateContent(JSON.stringify(result.data));
            const label = args.taskExtractProfile ?? args.schemaHint;
            const taskType = this.toolCtx.getTaskType();
            if (taskType === 'tax_code_delta' && content) {
              const session = this.browsers.getBrowserSession(
                this.toolCtx.requireClientId(),
              );
              if (session?.sessionId) {
                void this.rag.indexSessionText(session.sessionId, content, {
                  source: 'extract',
                });
              }
            }
            return {
              success: true,
              data: result.data,
              content,
              observation: `Extracted ${label} (${content.length} chars). ${args.instruction}. Reason: ${args.reason}`,
            };
          },
        }),
    });
  }

  private retrieveEvidenceTool() {
    const parameters = z.object({
      query: z.string().describe('Question to retrieve supporting evidence for'),
      reason: z.string().describe('Why this evidence is needed'),
    });

    return this.defineTool({
      name: 'retrieve_evidence',
      description:
        'Retrieve indexed tax research passages for tax_code_delta tasks (requires Pinecone).',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        const taskType = this.toolCtx.getTaskType();
        if (taskType && taskType !== 'tax_code_delta') {
          return {
            success: false,
            passages: [],
            observation:
              'retrieve_evidence is only for tax_code_delta tasks. Continue without RAG.',
            error: 'wrong_task_type',
          };
        }
        if (!this.rag.isEnabled()) {
          return {
            success: true,
            passages: [],
            observation:
              'RAG is disabled (PINECONE_API_KEY / PINECONE_INDEX not set). Continue with on-page extracts.',
          };
        }
        const clientId = this.toolCtx.requireClientId();
        const session = this.browsers.getBrowserSession(clientId);
        if (!session?.sessionId) {
          return {
            success: false,
            observation: 'No browser session for evidence retrieval',
            error: 'no_session',
          };
        }
        const passages = await this.rag.retrieve(session.sessionId, args.query);
        return {
          success: true,
          passages,
          observation: `Retrieved ${passages.length} passage(s). ${args.reason}`,
        };
      },
    });
  }

  private screenshotTool() {
    const parameters = z.object({
      reason: z.string().describe('Why screenshot is needed'),
      fullPage: z.boolean().optional(),
    });

    return this.defineTool({
      name: 'screenshot',
      description: 'Capture a JPEG screenshot of the current page.',
      parameters,
      execute: async (args): Promise<ToolResult> =>
        runBrowserTool(this.runnerCtx(), {
          failObservation: 'Screenshot failed',
          captureOnSuccess: false,
          action: async () => {
            const clientId = this.toolCtx.requireClientId();
            const page = await this.page();
            const started = Date.now();
            const buffer = await page.screenshot({
              type: 'jpeg',
              quality: 60,
              fullPage: args.fullPage ?? false,
            });
            const screenshotId = this.saveAndEmitScreenshot(
              clientId,
              Buffer.from(buffer),
              started,
              { tool: 'screenshot', caption: args.reason },
            );
            return {
              success: true,
              screenshotId,
              observation: `Screenshot captured (${screenshotId}). Reason: ${args.reason}`,
            };
          },
        }),
    });
  }

  private askHumanTool() {
    const parameters = z.object({
      question: z.string().describe('Question or request for the human'),
      context: z.string().describe('Why approval is needed'),
      required: z
        .boolean()
        .describe('Whether input is mandatory to proceed'),
    });

    return this.defineTool({
      name: 'ask_human',
      description:
        'Pause for human approval on sensitive actions (submit, categorize, post, clear, etc.).',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          const clientId = this.toolCtx.requireClientId();
          const session = this.browsers.getBrowserSession(clientId);
          const result = await this.approvals.requestApproval({
            clientId,
            sessionId: session?.sessionId ?? clientId,
            question: args.question,
            context: args.context,
            kind: 'approval',
          });
          if (result.approved) {
            this.toolCtx.grantHumanApproval();
          }
          return {
            success: result.approved,
            humanResponse: result.humanResponse,
            observation: result.observation,
            required: args.required,
          };
        } catch (error) {
          return fail('ask_human failed', error);
        }
      },
    });
  }

  private requestLoginTool() {
    const parameters = z.object({
      siteName: z.string().describe('Human-readable site name, e.g. Shopify Admin'),
      loginUrl: z
        .string()
        .optional()
        .describe('Login page URL to open in the live browser'),
      reason: z.string().describe('Why login is required to continue'),
    });

    return this.defineTool({
      name: 'request_login',
      description:
        'Hand the live browser to the user so they can sign in, complete MFA, or CAPTCHA. Resume after they confirm.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          const clientId = this.toolCtx.requireClientId();
          if (args.loginUrl?.trim()) {
            await this.allowlist.assertUrlAllowed(args.loginUrl);
            const page = await this.page();
            await page.goto(args.loginUrl, {
              waitUntil: 'domcontentloaded',
              timeout: STAGEHAND_ACTION_TIMEOUT_MS,
            });
            await settleStagehandPage(page);
            await this.assertCurrentPageAllowed();
            await this.captureAfterAction(clientId, { force: true });
          }

          const session = this.browsers.getBrowserSession(clientId);
          const result = await this.approvals.requestApproval({
            clientId,
            sessionId: session?.sessionId ?? clientId,
            kind: 'login',
            appName: args.siteName,
            question: `Please sign in to ${args.siteName} in the live browser on the left.`,
            context: `${args.reason} Use the live browser to complete login or MFA, then confirm here. Do not share passwords in chat.`,
          });
          return {
            success: result.approved,
            humanResponse: result.humanResponse,
            observation: result.approved
              ? `User confirmed login to ${args.siteName}. Continue the task.`
              : result.observation,
          };
        } catch (error) {
          return fail('request_login failed', error);
        }
      },
    });
  }

  private requestAppConnectionTool() {
    const parameters = z.object({
      app: z
        .string()
        .describe('App to connect: shopify, stripe, gmail, googledrive, slack'),
      reason: z.string().describe('Why this app connection is needed'),
    });

    return this.defineTool({
      name: 'request_app_connection',
      description:
        'Ask the user to securely connect an app via Composio (OAuth) or fall back to live-browser login.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          const clientId = this.toolCtx.requireClientId();
          const access = await this.composio.requestAccess(args.app);
          const session = this.browsers.getBrowserSession(clientId);

          if (access.mode === 'composio') {
            const result = await this.approvals.requestApproval({
              clientId,
              sessionId: session?.sessionId ?? clientId,
              kind: 'connect',
              appName: access.toolkit,
              connectUrl: access.connectUrl,
              question: `Connect ${access.toolkit} securely to continue.`,
              context: `${args.reason} Open the secure Composio link, finish OAuth, then confirm. Tokens stay with Composio — never paste secrets here.`,
            });
            return {
              success: result.approved,
              humanResponse: result.humanResponse,
              observation: result.approved
                ? `User connected ${access.toolkit} via Composio.`
                : result.observation,
            };
          }

          if (access.loginUrl) {
            await this.allowlist.assertUrlAllowed(access.loginUrl);
            const page = await this.page();
            await page.goto(access.loginUrl, {
              waitUntil: 'domcontentloaded',
              timeout: STAGEHAND_ACTION_TIMEOUT_MS,
            });
            await settleStagehandPage(page);
            await this.assertCurrentPageAllowed();
            await this.captureAfterAction(clientId, { force: true });
          }

          const result = await this.approvals.requestApproval({
            clientId,
            sessionId: session?.sessionId ?? clientId,
            kind: 'login',
            appName: access.toolkit,
            question: `Please sign in to ${access.toolkit} in the live browser.`,
            context: `${args.reason} ${access.reason} Complete login or MFA on the left, then confirm here.`,
          });
          return {
            success: result.approved,
            humanResponse: result.humanResponse,
            observation: result.approved
              ? `User signed into ${access.toolkit} in the live browser.`
              : result.observation,
          };
        } catch (error) {
          return fail('request_app_connection failed', error);
        }
      },
    });
  }

  private composioExecuteTool() {
    const parameters = z.object({
      app: z
        .string()
        .describe('Connected app: shopify, stripe, gmail, googledrive, slack'),
      action: z
        .string()
        .describe('Composio tool slug, e.g. STRIPE_LIST_PAYOUTS'),
      argumentsJson: z
        .string()
        .optional()
        .describe('JSON object of action arguments'),
      reason: z.string().describe('Why this app action is needed'),
    });

    return this.defineTool({
      name: 'composio_execute',
      description:
        'Run a read/write action on a Composio-connected app. Sensitive writes still require ask_human first.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          if (looksSensitiveAction(`${args.action} ${args.reason}`)) {
            if (!this.toolCtx.hasHumanApproval()) {
              return {
                success: false,
                observation:
                  'Sensitive Composio action blocked — call ask_human first.',
                error: 'Sensitive action blocked',
              };
            }
            this.toolCtx.consumeHumanApproval();
          }

          const connected = await this.composio.isConnected(args.app);
          if (!connected) {
            return {
              success: false,
              observation: `${args.app} is not connected. Call request_app_connection first.`,
              error: 'App not connected',
            };
          }

          const result = await this.composio.executeAction({
            toolkit: args.app,
            action: args.action,
            argumentsJson: args.argumentsJson,
          });
          return {
            success: result.ok,
            data: result.data,
            observation: `${result.observation} Reason: ${args.reason}`,
            error: result.ok ? undefined : String(result.observation),
          };
        } catch (error) {
          return fail('composio_execute failed', error);
        }
      },
    });
  }

  private doneTool() {
    const parameters = z.object({
      summary: z.string().describe('Clear summary of accomplishments'),
      extractedData: z
        .string()
        .describe('JSON string of structured data for the active task'),
      followUpActions: z
        .string()
        .optional()
        .describe('Suggested next steps'),
      taskType: taskTypeSchema
        .optional()
        .describe('Task type schema to validate extractedData'),
    });

    return this.defineTool({
      name: 'done',
      description:
        'Mark the task complete with a Zod-validated structured result.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        const clientId = this.toolCtx.requireClientId();
        try {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(args.extractedData);
          } catch {
            return {
              success: false,
              observation: 'extractedData is not valid JSON',
              error: 'JSON parse error',
            };
          }

          const taskType: TaskType =
            args.taskType ??
            this.toolCtx.getTaskType() ??
            'month_end_exception';

          const extractedData = parseExtractedData(taskType, parsedJson);
          this.toolCtx.setTaskType(taskType);

          const followUpActions = args.followUpActions
            ? args.followUpActions
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          const data: TaskResult = {
            taskType,
            summary: args.summary,
            extractedData,
            followUpActions,
            completedAt: Date.now(),
            totalSteps: this.rateLimit.getActionCount(clientId),
            totalExecutionTimeMs: this.toolCtx.getElapsedMs(),
          };

          this.events.emit('task_complete', {
            clientId,
            timestamp: Date.now(),
            summary: args.summary,
            data,
          });

          this.browsers.scheduleDeferredClose(clientId, BROWSER_DEFERRED_CLOSE_MS, {
            status: 'complete',
          });

          return {
            success: true,
            observation: `Task complete. Summary: ${args.summary}`,
            data,
          };
        } catch (error) {
          return fail(
            'done validation failed — fix extractedData to match task schema',
            error,
          );
        }
      },
    });
  }
}

/**
 * Light post-navigation settle so Stagehand's a11y snapshot does not race
 * transient iframes. Keep this short — it runs on the critical path.
 */
async function settleStagehandPage(
  page: StagehandPage,
  timeoutMs = STAGEHAND_DOM_SETTLE_MS,
): Promise<void> {
  const loadBudget = Math.min(timeoutMs, 2_000);
  try {
    await page.waitForLoadState('load', loadBudget);
  } catch {
    // Already loaded, or analytics keep the network busy — continue.
  }
  const quietMs = Math.min(STAGEHAND_POST_NAV_QUIET_MS, timeoutMs);
  if (quietMs > 0) {
    await page.waitForTimeout(quietMs);
  }
}
