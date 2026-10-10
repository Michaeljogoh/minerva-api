import { Injectable, Logger } from '@nestjs/common';
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
import { parseShopifyHandle } from '@modules/composio/shopify-domain';
import { ScreenshotStore } from '@modules/browser/screenshot.store';
import {
  parseExtractedData,
  taskOutcomeSchema,
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
import {
  capturePageSnapshot,
  formatPageState,
  type PageElement,
} from './page-state';

@Injectable()
export class StagehandToolsService {
  private readonly lastScreenshotEmitAt = new Map<string, number>();
  private readonly screenshotSlow = new Set<string>();
  private readonly screenshotStep = new Map<string, number>();
  private readonly logger = new Logger(StagehandToolsService.name);
  /** Element IDs from the latest page state, per client (ids are only valid until the page changes). */
  private readonly elementRegistry = new Map<string, Map<string, PageElement['action']>>();
  /** Clients whose page is known-settled; cleared by anything that can change the page. */
  private readonly settledClients = new Set<string>();

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
      this.actOnElementTool(),
      this.fillFormTool(),
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

  /** Snapshot the page (DOM only, no AI), register element ids, return compact text. */
  private async refreshPageState(clientId: string): Promise<string> {
    try {
      const page = await this.browsers.getStagehandPage(clientId);
      const snapshot = await capturePageSnapshot(page);
      this.elementRegistry.set(
        clientId,
        new Map(snapshot.elements.map((e) => [e.id, e.action])),
      );
      return formatPageState(snapshot);
    } catch {
      // Page state is a convenience — never fail the action because of it.
      this.elementRegistry.delete(clientId);
      return '';
    }
  }

  private markPageChanged(clientId: string): void {
    this.settledClients.delete(clientId);
  }

  /** Settle only when the page may have changed since the last settle. */
  private async settleIfNeeded(
    clientId: string,
    page: StagehandPage,
  ): Promise<void> {
    if (this.settledClients.has(clientId)) {
      return;
    }
    await settleStagehandPage(page);
    this.settledClients.add(clientId);
  }

  private logStep(
    tool: string,
    clientId: string,
    timing: { aiMs?: number; browserMs: number },
  ): void {
    this.logger.log(
      `[perf] tool=${tool} client=${clientId} ai=${timing.aiMs ?? 0}ms browser=${timing.browserMs}ms`,
    );
  }

  private async guardSensitive(text: string): Promise<ToolResult | null> {
    if (!looksSensitiveAction(text)) {
      return null;
    }
    if (!this.toolCtx.hasHumanApproval()) {
      return {
        success: false,
        observation:
          'Sensitive action blocked — call ask_human and wait for approval before acting.',
        error: 'Sensitive action blocked',
      };
    }
    this.toolCtx.consumeHumanApproval();
    return null;
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
            const startedAt = Date.now();
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
            const clientId = this.toolCtx.requireClientId();
            this.settledClients.add(clientId);
            const state = await this.refreshPageState(clientId);
            this.logStep('navigate', clientId, { browserMs: Date.now() - startedAt });
            return {
              success: true,
              title,
              url,
              observation: `Navigated to ${url} (title: ${title}). Reason: ${args.reason}${state ? `\n${state}` : ''}`,
            };
          },
        });
      },
    });
  }

  private lookupElement(
    clientId: string,
    id: string,
  ): PageElement['action'] | undefined {
    return this.elementRegistry.get(clientId)?.get(id);
  }

  private unknownElementResult(id: string): ToolResult {
    return {
      success: false,
      observation: `Unknown element id "${id}" — ids only last until the next page state. Use ids from the latest PAGE STATE, or fall back to act.`,
      error: 'unknown_element_id',
    };
  }

  /** Execute a pre-resolved element with no AI call. */
  private async runElementAction(
    action: PageElement['action'],
    value?: string,
  ) {
    const page = await this.page();
    const sh = await this.stagehand();
    const resolved =
      value !== undefined ? { ...action, arguments: [value] } : action;
    return sh.act(resolved, { page, timeout: STAGEHAND_ACTION_TIMEOUT_MS });
  }

  private actOnElementTool() {
    const parameters = z.object({
      id: z.string().describe('Element id from the latest PAGE STATE, e.g. e3'),
      value: z
        .string()
        .optional()
        .describe('Text to type (textboxes) or option to choose (selects)'),
      reason: z.string().describe('Why this action is needed'),
    });

    return this.defineTool({
      name: 'act_on_element',
      description:
        'Click, type into, or select an element by id from the latest PAGE STATE. Runs instantly with no AI call — always prefer this over act.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        const clientId = this.toolCtx.requireClientId();
        const action = this.lookupElement(clientId, args.id);
        if (!action) {
          return this.unknownElementResult(args.id);
        }
        if (action.method === 'fill' && args.value === undefined) {
          return {
            success: false,
            observation: `Element ${args.id} is a text field — pass "value" to type into it.`,
            error: 'missing_value',
          };
        }
        const blocked = await this.guardSensitive(action.description);
        if (blocked) {
          return blocked;
        }

        return runBrowserTool(this.runnerCtx(), {
          failObservation: `act_on_element failed for ${args.id}. Take a screenshot, or fall back to act.`,
          action: async () => {
            const startedAt = Date.now();
            const result = await runWithToolRetry(() =>
              this.runElementAction(action, args.value),
            );
            await this.assertCurrentPageAllowed();
            this.markPageChanged(clientId);
            const stepMs = Date.now() - startedAt;
            const state = await this.refreshPageState(clientId);
            this.logStep('act_on_element', clientId, { browserMs: stepMs });
            return {
              success: result.data.success,
              observation: result.data.success
                ? `Done: ${action.description}. Reason: ${args.reason}${state ? `\n${state}` : ''}`
                : `Failed: ${result.data.message}. Take a screenshot, or fall back to act.${state ? `\n${state}` : ''}`,
              error: result.data.success ? undefined : result.data.message,
            };
          },
        });
      },
    });
  }

  private fillFormTool() {
    const parameters = z.object({
      fields: z
        .array(
          z.object({
            id: z.string().describe('Element id of the field'),
            value: z.string().describe('Text to type or option to select'),
          }),
        )
        .min(1),
      submitId: z
        .string()
        .optional()
        .describe('Element id of the submit button to click after filling'),
      reason: z.string().describe('Why this form is being filled'),
    });

    return this.defineTool({
      name: 'fill_form',
      description:
        'Fill several fields (and optionally click submit) in one step using element ids from the latest PAGE STATE. No AI calls.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        const clientId = this.toolCtx.requireClientId();
        const resolved: Array<{ action: PageElement['action']; value: string }> = [];
        for (const field of args.fields) {
          const action = this.lookupElement(clientId, field.id);
          if (!action) {
            return this.unknownElementResult(field.id);
          }
          resolved.push({ action, value: field.value });
        }
        let submit: PageElement['action'] | undefined;
        if (args.submitId) {
          submit = this.lookupElement(clientId, args.submitId);
          if (!submit) {
            return this.unknownElementResult(args.submitId);
          }
          const blocked = await this.guardSensitive(submit.description);
          if (blocked) {
            return blocked;
          }
        }

        return runBrowserTool(this.runnerCtx(), {
          failObservation:
            'fill_form failed. Take a screenshot, or fall back to act.',
          action: async () => {
            const startedAt = Date.now();
            const filled: string[] = [];
            for (const { action, value } of resolved) {
              const result = await runWithToolRetry(() =>
                this.runElementAction(action, value),
              );
              if (!result.data.success) {
                this.markPageChanged(clientId);
                const state = await this.refreshPageState(clientId);
                return {
                  success: false,
                  observation: `fill_form stopped at ${action.description}: ${result.data.message}.${state ? `\n${state}` : ''}`,
                  error: result.data.message,
                };
              }
              filled.push(action.description);
            }
            if (submit) {
              const result = await runWithToolRetry(() =>
                this.runElementAction(submit),
              );
              if (!result.data.success) {
                this.markPageChanged(clientId);
                const state = await this.refreshPageState(clientId);
                return {
                  success: false,
                  observation: `Filled ${filled.length} field(s) but submit failed: ${result.data.message}.${state ? `\n${state}` : ''}`,
                  error: result.data.message,
                };
              }
            }
            await this.assertCurrentPageAllowed();
            this.markPageChanged(clientId);
            const stepMs = Date.now() - startedAt;
            const state = await this.refreshPageState(clientId);
            this.logStep('fill_form', clientId, { browserMs: stepMs });
            return {
              success: true,
              observation: `Filled ${filled.length} field(s)${submit ? ` and submitted (${submit.description})` : ''}. Reason: ${args.reason}${state ? `\n${state}` : ''}`,
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
        'FALLBACK only: natural-language browser action (uses a second AI call). Prefer act_on_element / fill_form with element IDs from the latest page state; use this for scrolling or when no matching element ID exists.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        // Rate limit is enforced once inside runBrowserTool (not here).
        const blocked = await this.guardSensitive(args.instruction);
        if (blocked) {
          return blocked;
        }

        return runBrowserTool(this.runnerCtx(), {
          failObservation: `Act failed for "${args.instruction}". Take a screenshot to see the page, or ask_human.`,
          action: async () => {
            const page = await this.page();
            const clientId = this.toolCtx.requireClientId();
            const startedAt = Date.now();
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
            this.markPageChanged(clientId);
            const aiMs = Date.now() - startedAt;
            const state = await this.refreshPageState(clientId);
            this.logStep('act', clientId, {
              aiMs,
              browserMs: Date.now() - startedAt - aiMs,
            });
            const actionDesc = result.data.actionDescription || args.instruction;
            return {
              success: result.data.success,
              observation: result.data.success
                ? `Act succeeded: ${actionDesc}. Reason: ${args.reason}${state ? `\n${state}` : ''}`
                : `Act failed: ${result.data.message}. Take a screenshot or ask_human.${state ? `\n${state}` : ''}`,
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
        'Semantic element search (AI call). Elements are returned with ids usable in act_on_element. Normally unnecessary — the latest page state already lists elements.',
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
              await this.settleIfNeeded(this.toolCtx.requireClientId(), page);
              const sh = await this.stagehand();
              return sh.observe(instruction, {
                page,
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
            });
            const clientId = this.toolCtx.requireClientId();
            const registry =
              this.elementRegistry.get(clientId) ??
              new Map<string, PageElement['action']>();
            this.elementRegistry.set(clientId, registry);
            const elements = result.data.map((el, i) => {
              const id = `o${i + 1}`;
              registry.set(id, {
                selector: el.selector,
                description: el.description,
                method: el.method ?? 'click',
                arguments: el.arguments,
              });
              return { id, description: el.description, method: el.method };
            });
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
              await this.settleIfNeeded(this.toolCtx.requireClientId(), page);
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
        .describe(
          'App to connect: shopify, stripe, quickbooks, gmail, googledrive, slack',
        ),
      reason: z.string().describe('Why this app connection is needed'),
    });

    return this.defineTool({
      name: 'request_app_connection',
      description:
        'Ask the user to securely connect an app (OAuth through Composio). Shopify is connected this way only; other apps may fall back to live-browser login.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          const clientId = this.toolCtx.requireClientId();
          const userId = this.toolCtx.requireUserId();
          const toolkit = this.composio.normalizeToolkit(args.app);
          const session = this.browsers.getBrowserSession(clientId);
          const sessionId = session?.sessionId ?? clientId;

          // Connections persist across runs — do not ask the user twice.
          if (await this.composio.isConnected(userId, toolkit)) {
            return {
              success: true,
              observation: `${toolkit} is already connected. Use composio_execute.`,
            };
          }

          if (!this.composio.supportsOAuth(toolkit)) {
            if (!this.composio.loginUrlFor(toolkit)) {
              // OAuth-only app with no auth config: never fall back to a login page.
              return {
                success: false,
                observation: `${toolkit} connections are not set up on this server. Do not open a login page; stop and tell the user ${toolkit} is unavailable.`,
                error: 'Connection not configured',
              };
            }
            return await this.legacyBrowserLogin(
              clientId,
              sessionId,
              userId,
              toolkit,
              args.reason,
            );
          }

          // Shopify needs the store name before Composio can build the link.
          const connectionData: Record<string, string> = {};
          if (toolkit === 'shopify') {
            const stored = await this.composio.getStoredConnection(
              userId,
              toolkit,
            );
            let handle: string | null = stored?.metadata?.subdomain ?? null;
            let prompt = `${args.reason} Enter the name of your store, like acme from acme.myshopify.com.`;
            for (let attempt = 0; !handle && attempt < 3; attempt += 1) {
              const asked = await this.approvals.requestApproval({
                clientId,
                sessionId,
                kind: 'connect_input',
                appName: toolkit,
                question: 'Which Shopify store should I connect?',
                context: prompt,
                inputLabel: 'Store name',
                inputPlaceholder: 'acme or acme.myshopify.com',
              });
              if (!asked.approved) {
                return {
                  success: false,
                  humanResponse: asked.humanResponse,
                  observation: asked.observation,
                };
              }
              handle = parseShopifyHandle(asked.humanResponse ?? '');
              prompt =
                'That does not look like a Shopify store. Use the name from yourstore.myshopify.com (not a custom domain).';
            }
            if (!handle) {
              return {
                success: false,
                observation:
                  'No valid Shopify store name was given. Stop and tell the user to connect Shopify from their connected apps.',
                error: 'Invalid store name',
              };
            }
            connectionData.subdomain = handle;
          }

          const access = await this.composio.requestAccess(
            userId,
            toolkit,
            connectionData,
          );
          if (access.mode !== 'composio') {
            // No manual-login fallback for OAuth apps: report and stop.
            return {
              success: false,
              observation:
                access.mode === 'unavailable'
                  ? `${access.reason} Do not try to log in through the browser; tell the user the connection is unavailable.`
                  : 'Secure connection unavailable.',
              error: 'Connection unavailable',
            };
          }

          const result = await this.approvals.requestApproval({
            clientId,
            sessionId,
            kind: 'connect',
            appName: access.toolkit,
            connectUrl: access.connectUrl,
            question: `Connect ${access.toolkit} securely to continue.`,
            context: `${args.reason} Open the secure link, approve access, then confirm. Tokens stay with Composio — never paste secrets here.`,
          });
          if (!result.approved) {
            return {
              success: false,
              humanResponse: result.humanResponse,
              observation: result.observation,
            };
          }
          // The confirm click is not proof — check Composio for the connection.
          const connected = await this.composio.waitUntilConnected(
            userId,
            access.toolkit,
          );
          if (connected) {
            this.events.emit('connection_ready', {
              clientId,
              toolkit: access.toolkit,
            });
          }
          return {
            success: connected,
            humanResponse: result.humanResponse,
            observation: connected
              ? `User connected ${access.toolkit}.`
              : `User confirmed, but ${access.toolkit} is not connected yet. Call request_app_connection again so they can finish the secure link.`,
            error: connected ? undefined : 'App not connected',
          };
        } catch (error) {
          return fail('request_app_connection failed', error);
        }
      },
    });
  }

  /** Apps without a Composio auth config yet still use the live browser login. */
  private async legacyBrowserLogin(
    clientId: string,
    sessionId: string,
    userId: string,
    toolkit: string,
    reason: string,
  ): Promise<ToolResult> {
    const access = await this.composio.requestAccess(userId, toolkit);
    if (access.mode !== 'browser_login') {
      return {
        success: false,
        observation: `${toolkit} cannot be connected right now.`,
        error: 'Connection unavailable',
      };
    }
    await this.allowlist.assertUrlAllowed(access.loginUrl);
    const page = await this.page();
    await page.goto(access.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: STAGEHAND_ACTION_TIMEOUT_MS,
    });
    await settleStagehandPage(page);
    await this.assertCurrentPageAllowed();
    await this.captureAfterAction(clientId, { force: true });

    const result = await this.approvals.requestApproval({
      clientId,
      sessionId,
      kind: 'login',
      appName: access.toolkit,
      question: `Please sign in to ${access.toolkit} in the live browser.`,
      context: `${reason} ${access.reason} Complete login or MFA on the left, then confirm here.`,
    });
    return {
      success: result.approved,
      humanResponse: result.humanResponse,
      observation: result.approved
        ? `User signed into ${access.toolkit} in the live browser.`
        : result.observation,
    };
  }

  private composioExecuteTool() {
    const parameters = z.object({
      app: z
        .string()
        .describe('Connected app. Currently only shopify is supported.'),
      action: z
        .string()
        .describe('Read-only Composio tool slug, e.g. SHOPIFY_GET_ORDER_LIST'),
      argumentsJson: z
        .string()
        .optional()
        .describe('JSON object of action arguments'),
      reason: z.string().describe('Why this app action is needed'),
    });

    return this.defineTool({
      name: 'composio_execute',
      description:
        'Run a read-only action on a connected app (orders, products, customers). Writes are not available.',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        try {
          const userId = this.toolCtx.requireUserId();
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

          if (!(await this.composio.isConnected(userId, args.app))) {
            return {
              success: false,
              observation: `${args.app} is not connected. Call request_app_connection first.`,
              error: 'App not connected',
            };
          }

          const result = await this.composio.executeAction({
            userId,
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
      summary: z
        .string()
        .describe(
          'Markdown answer for the user: lead with the result, use short bullets or bold for key values. On failure, say what went wrong.',
        ),
      outcome: taskOutcomeSchema
        .optional()
        .describe(
          'success = goal met; partial = some of it done; failed = goal not met',
        ),
      failureReason: z
        .string()
        .optional()
        .describe('One sentence on why, when outcome is partial or failed'),
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
            'quick_answer';

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
            outcome: args.outcome ?? 'success',
            ...(args.failureReason ? { failureReason: args.failureReason } : {}),
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
