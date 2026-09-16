import { EvalRunner } from './eval.runner';
import { CI_EVAL_CASE_IDS, EVAL_CASES } from './cases';
import { e7GatedMutationTrace } from './fixtures/traces';

describe('EvalRunner (§14)', () => {
  const runner = new EvalRunner();

  it('lists E1–E11', () => {
    expect(runner.listCases()).toHaveLength(11);
    expect(EVAL_CASES.map((c) => c.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8',
      'E9',
      'E10',
      'E11',
    ]);
  });

  it('passes all fixture cases offline', () => {
    const suite = runner.runSuite();
    expect(suite.passed).toBe(true);
    expect(suite.summary.failed).toBe(0);
    expect(suite.summary.total).toBe(11);
  });

  it('passes CI subset (E1 + E3 + stop/pause)', () => {
    const suite = runner.runCiSubset();
    expect(suite.passed).toBe(true);
    expect(suite.results.map((r) => r.caseId)).toEqual([...CI_EVAL_CASE_IDS]);
  });

  it('scores E1 metrics with ask_human and tax flags', () => {
    const result = runner.runCase('E1');
    expect(result.passed).toBe(true);
    expect(result.metrics.askHumanCount).toBeGreaterThanOrEqual(1);
    expect(result.metrics.actionCount).toBeGreaterThan(0);
  });

  it('fails books mutation when ask_human missing', () => {
    const bad = {
      ...e7GatedMutationTrace,
      events: e7GatedMutationTrace.events.filter(
        (e) => e.type !== 'human_approval_required' && e.type !== 'approve_action',
      ),
    };
    const result = runner.runCase('E7', bad);
    expect(result.passed).toBe(false);
    expect(
      result.assertions.some(
        (a) => a.name === 'books_mutations_gated' && !a.passed,
      ),
    ).toBe(true);
  });

  it('reports task success by type for T1–T4', () => {
    const suite = runner.runSuite(['E1', 'E2', 'E3', 'E4']);
    expect(suite.summary.taskSuccessByType.month_end_exception?.passed).toBe(1);
    expect(suite.summary.taskSuccessByType.tax_code_delta?.passed).toBe(1);
    expect(suite.summary.taskSuccessByType.bank_rec_diff?.passed).toBe(1);
    expect(suite.summary.taskSuccessByType.receipt_chase?.passed).toBe(1);
  });
});
