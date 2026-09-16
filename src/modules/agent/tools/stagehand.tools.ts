import { Injectable } from '@nestjs/common';
import { FunctionTool, LongRunningFunctionTool } from '@google/adk';
import { z } from 'zod';
import type { Page as StagehandPage, Stagehand } from '@browserbasehq/stagehand';
import { ApprovalService } from '../approval/approval.service';
import { BROWSER_DEFERRED_CLOSE_MS, STAGEHAND_ACTION_TIMEOUT_MS } from '@common/constants/session-lifecycle.constants';
import { BrowserbaseManager } from '@modules/browser/browserbase.manager';
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

@Injectable()
export class StagehandToolsService {
  private readonly lastScreenshotEmitAt = new Map<string, number>();
  private readonly screenshotSlow = new Set<string>();

  constructor(
    private readonly browsers: BrowserbaseManager,
    private readonly screenshots: ScreenshotStore,
    private readonly allowlist: UrlAllowlistService,
    private readonly rateLimit: RateLimitService,
    private readonly toolCtx: ToolSessionContext,
    private readonly events: ToolEventBus,
    private readonly approvals: ApprovalService,
  ) {}

  createTools(): Array<FunctionTool | LongRunningFunctionTool> {
    return [
      this.navigateTool(),
      this.actTool(),
      this.observeTool(),
      this.extractTool(),
      this.screenshotTool(),
      this.askHumanTool(),
      this.doneTool(),
    ];
  }

  private runnerCtx(): BrowserToolRunnerCtx {
    return {
      requireClientId: () => this.toolCtx.requireClientId(),
      assertPageAllowed: () => this.assertCurrentPageAllowed(),
      assertCanPerformAction: (clientId) =>
        this.rateLimit.assertCanPerformAction(clientId),
      captureAfterAction: (clientId, opts) =>
        this.captureAfterAction(clientId, opts),
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
    this.allowlist.assertUrlAllowed(await page.url());
  }

  private async captureAfterAction(
    clientId: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const force = opts?.force === true;
    const screenshotOnly = this.toolCtx.isScreenshotOnly();
    const now = Date.now();
    const lastEmit = this.lastScreenshotEmitAt.get(clientId) ?? 0;

    if (
      !force &&
      !screenshotOnly &&
      this.screenshotSlow.has(clientId) &&
      now - lastEmit < SCREENSHOT_THROTTLE_MS
    ) {
      return;
    }

    try {
      const started = Date.now();
      const page = await this.browsers.getStagehandPage(clientId);
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 60,
        fullPage: false,
      });
      if (Date.now() - started >= SCREENSHOT_SLOW_MS) {
        this.screenshotSlow.add(clientId);
      }
      const id = this.screenshots.save(clientId, Buffer.from(buffer));
      const url = this.screenshots.getDataUrl(id);
      if (url) {
        this.events.emit('screenshot', {
          clientId,
          url,
          timestamp: Date.now(),
        });
        this.lastScreenshotEmitAt.set(clientId, Date.now());
      }
    } catch {
      // Never fail the tool solely because post-action capture failed.
    }
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

    return new FunctionTool({
      name: 'navigate',
      description: 'Navigate the browser to a URL (must be allowlisted).',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        this.allowlist.assertUrlAllowed(args.url);
        return runBrowserTool(this.runnerCtx(), {
          failObservation: `Navigate failed for ${args.url}. Try an alternate allowlisted URL or ask_human.`,
          requireAllowlistedPage: false,
          action: async () => {
            await runWithToolRetry(async () => {
              const page = await this.page();
              await page.goto(args.url, {
                waitUntil: 'domcontentloaded',
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
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

    return new FunctionTool({
      name: 'act',
      description:
        'Perform a browser interaction via natural language (clicks, typing, scrolling, selections).',
      parameters,
      execute: async (args): Promise<ToolResult> => {
        const clientId = this.toolCtx.requireClientId();
        this.rateLimit.assertCanPerformAction(clientId);
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

    return new FunctionTool({
      name: 'observe',
      description:
        'Discover actionable elements on the page before act (buttons, links, inputs, etc.).',
      parameters,
      execute: async (args): Promise<ToolResult> =>
        runBrowserTool(this.runnerCtx(), {
          failObservation:
            'Observe failed. Try screenshot or navigate to refresh the page.',
          action: async () => {
            const page = await this.page();
            const instruction =
              args.instruction?.trim() ||
              'List all interactive elements visible on the page';
            const result = await runWithToolRetry(async () => {
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
              observation: `Observed ${elements.length} candidate element(s). ${args.reason}. ${JSON.stringify(elements).slice(0, 4000)}`,
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
          'Task-specific extract schema: exception_table, bank_rows, receipt_items, irs_findings',
        ),
    });

    return new FunctionTool({
      name: 'extract',
      description:
        'Extract structured content from the page using Stagehand + Zod schema.',
      parameters,
      execute: async (args): Promise<ToolResult> =>
        runBrowserTool(this.runnerCtx(), {
          failObservation: 'Extract failed',
          action: async () => {
            const schema = resolveExtractSchema({
              taskExtractProfile: args.taskExtractProfile,
              schemaHint: args.schemaHint,
            });
            const page = await this.page();
            const result = await runWithToolRetry(async () => {
              const sh = await this.stagehand();
              return sh.extract(args.instruction, schema as never, {
                page,
                timeout: STAGEHAND_ACTION_TIMEOUT_MS,
              });
            });
            const content = truncateContent(JSON.stringify(result.data));
            const label = args.taskExtractProfile ?? args.schemaHint;
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

  private screenshotTool() {
    const parameters = z.object({
      reason: z.string().describe('Why screenshot is needed'),
      fullPage: z.boolean().optional(),
    });

    return new FunctionTool({
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
            if (Date.now() - started >= SCREENSHOT_SLOW_MS) {
              this.screenshotSlow.add(clientId);
            }
            const screenshotId = this.screenshots.save(
              clientId,
              Buffer.from(buffer),
            );
            const url = this.screenshots.getDataUrl(screenshotId) ?? '';
            this.events.emit('screenshot', {
              clientId,
              url,
              timestamp: Date.now(),
            });
            this.lastScreenshotEmitAt.set(clientId, Date.now());
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

    return new LongRunningFunctionTool({
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

    return new FunctionTool({
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
