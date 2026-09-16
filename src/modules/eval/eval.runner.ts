import { Injectable, Logger } from '@nestjs/common';
import { computeTraceMetrics } from './eval.assertions';
import {
  CI_EVAL_CASE_IDS,
  EVAL_CASES,
  getEvalCase,
  getEvalCases,
} from './cases';
import type {
  EvalCase,
  EvalCaseResult,
  EvalSuiteResult,
  EvalTrace,
} from './eval.types';
import type { TaskType } from '@common/schemas/task-result.schemas';

/**
 * Offline / fixture eval runner (§14).
 * Scores recorded protocol traces against case assertions (CI-safe).
 * Live Browserbase+Gemini runs can feed the same {@link EvalTrace} shape later.
 */
@Injectable()
export class EvalRunner {
  private readonly logger = new Logger(EvalRunner.name);

  listCases(): EvalCase[] {
    return EVAL_CASES;
  }

  getCase(id: string): EvalCase | undefined {
    return getEvalCase(id);
  }

  /** Score a single case against a trace (defaults to fixture). */
  runCase(caseId: string, trace?: EvalTrace): EvalCaseResult {
    const evalCase = getEvalCase(caseId);
    if (!evalCase) {
      return {
        caseId,
        passed: false,
        assertions: [
          {
            name: 'case_exists',
            passed: false,
            detail: `Unknown case ${caseId}`,
          },
        ],
        metrics: {
          askHumanCount: 0,
          actionCount: 0,
          firstAttemptSuccessRate: 0,
          humanInterventionRate: 0,
        },
      };
    }
    return this.score(evalCase, trace ?? evalCase.fixtureTrace);
  }

  /** Run selected cases (default: all). */
  runSuite(caseIds?: string[]): EvalSuiteResult {
    const cases = getEvalCases(caseIds);
    const results = cases.map((c) => this.score(c, c.fixtureTrace));
    return this.summarize(results);
  }

  /** PRD CI subset: E1 + stop/pause control cases. */
  runCiSubset(): EvalSuiteResult {
    return this.runSuite([...CI_EVAL_CASE_IDS]);
  }

  score(evalCase: EvalCase, trace: EvalTrace): EvalCaseResult {
    const assertions = evalCase.assert(trace);
    const passed = assertions.every((a) => a.passed);
    const metrics = computeTraceMetrics(trace);
    if (!passed) {
      const failed = assertions.filter((a) => !a.passed);
      this.logger.warn(
        `${evalCase.id} failed: ${failed.map((f) => f.name).join(', ')}`,
      );
    }
    return {
      caseId: evalCase.id,
      passed,
      assertions,
      metrics,
    };
  }

  private summarize(results: EvalCaseResult[]): EvalSuiteResult {
    const taskSuccessByType: Partial<
      Record<TaskType, { passed: number; total: number }>
    > = {};

    for (const result of results) {
      const evalCase = getEvalCase(result.caseId);
      const taskType = evalCase?.taskType;
      if (!taskType) {
        continue;
      }
      const bucket = taskSuccessByType[taskType] ?? { passed: 0, total: 0 };
      bucket.total += 1;
      if (result.passed) {
        bucket.passed += 1;
      }
      taskSuccessByType[taskType] = bucket;
    }

    const passed = results.filter((r) => r.passed).length;
    return {
      passed: results.every((r) => r.passed),
      results,
      summary: {
        total: results.length,
        passed,
        failed: results.length - passed,
        taskSuccessByType,
      },
    };
  }
}
