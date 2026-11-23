/**
 * The calc-record-edit task text, in a module with **no imports**.
 *
 * ## What this module is, and is not
 *
 * It renders the task sentence **for the screenshot baseline** — the arm whose
 * agent is given a sentence to read. It is deliberately import-free because
 * `src/baseline/c1-trial.ts` is guarded by `test/baseline/import-graph.test.ts`
 * and may not reach the task family's fixture code (`node:crypto` via
 * `fixture.ts`). Zero dependencies is a requirement here, not a style choice.
 *
 * **It is not "one text both arms render."** An earlier revision of this header
 * claimed that, and it was wrong: Myco's arm has no task sentence to render. It
 * runs `windowsProgramFor(params)` (`src/integration/trial.ts:643`), a compiled
 * guarded program of `click`/`typeText` steps with pre/postconditions, checked by
 * an independent persisted-state verifier. It never prompts a model with prose.
 *
 * The thing the two arms must share is therefore **the task specification** —
 * `CalcRecordEditParams` plus the intent that ends "and save the file"
 * (`./intent.ts`) — not a sentence. C1's failure was that its task line dropped
 * the save requirement while Myco's program *does* save as an explicit step, so
 * the arms were not measuring the same job.
 *
 * ## Why the text matters
 *
 * - Myco's intent: "…to `newValue`, **and save the file**" — and its program saves.
 * - The baseline's original task line (`c1-trial.ts:46` before this module):
 *   "Set the X cell for record Y to Z." — no save.
 *
 * The baseline's planner also saw "Save and close it" in its system prompt, so the
 * two arms differed in the task line itself. Its refutations were dominated by
 * rows that typed the correct value and never saved. Arm-003 re-runs with this
 * text, so the baseline's stated job matches the job Myco's program executes.
 * See docs/research/experiments/c1-arm-003-design.md.
 */

/** The minimum needed to render the task text. */
export interface TaskTextParams {
  rowKey: string;
  column: string;
  newValue: string | number;
}

/**
 * The canonical task sentence for the screenshot baseline.
 *
 * The baseline is the only arm that reads a sentence: Myco's arm runs a compiled
 * program (`windowsProgramFor`) and is never prompted. What the two arms must
 * share is the **job**, not the prose — see this module's header and
 * `test/baseline/task-parity.test.ts`, which pins that Myco's program saves *and*
 * the baseline is told to.
 */
export function taskText(params: TaskTextParams): string {
  return `Set the cell at record ${params.rowKey}, column ${params.column}, to ${JSON.stringify(params.newValue)}, and save the file.`;
}
