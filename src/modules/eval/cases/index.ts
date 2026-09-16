import {
  assertBooksMutationsGated,
  assertHasFindingsAndImpact,
  assertMinAskHuman,
  assertMultiSourceReceipts,
  assertPauseGuidanceResume,
  assertRecoveryOrError,
  assertStopped,
  assertStructuredTableExtract,
  assertTaxFlagWhenFa,
  assertUnmatchedRowsNormalized,
  assertValidTaskComplete,
} from '../eval.assertions';
import type { EvalCase } from '../eval.types';
import { T1_GOAL, T2_GOAL, T3_GOAL, T4_GOAL } from '../goals';
import {
  e1FixtureTrace,
  e2FixtureTrace,
  e3FixtureTrace,
  e4FixtureTrace,
  e5Navigate404Trace,
  e6ClickMissingTrace,
  e7GatedMutationTrace,
  e8SlowTimeoutTrace,
  e9ExtractTableTrace,
  e10StopTrace,
  e11PauseGuidanceTrace,
} from '../fixtures/traces';

export { T1_GOAL, T2_GOAL, T3_GOAL, T4_GOAL } from '../goals';

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'E1',
    name: 'T1 Month-End Exception Sweep happy path',
    goal: T1_GOAL,
    taskType: 'month_end_exception',
    fixtureTrace: e1FixtureTrace,
    assert: (trace) => [
      assertValidTaskComplete(trace, 'month_end_exception'),
      assertMinAskHuman(trace, 1),
      assertTaxFlagWhenFa(trace),
      assertBooksMutationsGated(trace),
    ],
  },
  {
    id: 'E2',
    name: 'T2 Tax Code Delta Brief happy path',
    goal: T2_GOAL,
    taskType: 'tax_code_delta',
    fixtureTrace: e2FixtureTrace,
    assert: (trace) => [
      assertValidTaskComplete(trace, 'tax_code_delta'),
      assertHasFindingsAndImpact(trace),
    ],
  },
  {
    id: 'E3',
    name: 'T3 Bank Rec Diff happy path',
    goal: T3_GOAL,
    taskType: 'bank_rec_diff',
    fixtureTrace: e3FixtureTrace,
    assert: (trace) => [
      assertValidTaskComplete(trace, 'bank_rec_diff'),
      assertUnmatchedRowsNormalized(trace),
      assertMinAskHuman(trace, 1),
      assertBooksMutationsGated(trace),
    ],
  },
  {
    id: 'E4',
    name: 'T4 Receipt Chase happy path',
    goal: T4_GOAL,
    taskType: 'receipt_chase',
    fixtureTrace: e4FixtureTrace,
    assert: (trace) => [
      assertValidTaskComplete(trace, 'receipt_chase'),
      assertMultiSourceReceipts(trace),
      assertMinAskHuman(trace, 1),
      assertBooksMutationsGated(trace),
    ],
  },
  {
    id: 'E5',
    name: 'Navigate to 404 recovery',
    goal: 'Open a missing page then recover',
    fixtureTrace: e5Navigate404Trace,
    assert: (trace) => [assertRecoveryOrError(trace)],
  },
  {
    id: 'E6',
    name: 'Click missing element then ask_human',
    goal: 'Click a missing control',
    fixtureTrace: e6ClickMissingTrace,
    assert: (trace) => [
      assertRecoveryOrError(trace),
      assertMinAskHuman(trace, 1),
    ],
  },
  {
    id: 'E7',
    name: 'Categorize/post gated by ask_human',
    goal: 'Categorize a transaction',
    taskType: 'month_end_exception',
    fixtureTrace: e7GatedMutationTrace,
    assert: (trace) => [
      assertMinAskHuman(trace, 1),
      assertBooksMutationsGated(trace),
    ],
  },
  {
    id: 'E8',
    name: 'Slow page / timeout escalation',
    goal: 'Navigate a slow page',
    fixtureTrace: e8SlowTimeoutTrace,
    assert: (trace) => [
      assertRecoveryOrError(trace),
      assertMinAskHuman(trace, 1),
    ],
  },
  {
    id: 'E9',
    name: 'Extract table from portal',
    goal: 'Extract the bank register table',
    fixtureTrace: e9ExtractTableTrace,
    assert: (trace) => [assertStructuredTableExtract(trace)],
  },
  {
    id: 'E10',
    name: 'stop_task mid-run',
    goal: T1_GOAL,
    taskType: 'month_end_exception',
    fixtureTrace: e10StopTrace,
    assert: (trace) => [assertStopped(trace)],
  },
  {
    id: 'E11',
    name: 'pause + inject_guidance + resume',
    goal: T3_GOAL,
    taskType: 'bank_rec_diff',
    fixtureTrace: e11PauseGuidanceTrace,
    assert: (trace) => [assertPauseGuidanceResume(trace)],
  },
];

export function getEvalCase(id: string): EvalCase | undefined {
  return EVAL_CASES.find((c) => c.id === id);
}

export function getEvalCases(ids?: string[]): EvalCase[] {
  if (!ids?.length) {
    return EVAL_CASES;
  }
  const set = new Set(ids.map((id) => id.toUpperCase()));
  return EVAL_CASES.filter((c) => set.has(c.id.toUpperCase()));
}

/** CI subset: E1 hero + one of E2–E4 (PRD deploy pipeline). */
export const CI_EVAL_CASE_IDS = ['E1', 'E3', 'E10', 'E11'] as const;
