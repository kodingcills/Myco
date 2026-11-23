/**
 * The calc-record-edit task text, in a module with **no imports**.
 *
 * This file exists because of an architectural constraint, and the constraint is
 * the point. `src/baseline/c1-trial.ts` is guarded by
 * `test/baseline/import-graph.test.ts`: it may not reach the task family's
 * fixture code, which pulls in `node:crypto`. The instruction text must be shared
 * between Myco's arm and the screenshot baseline — a baseline told a different
 * task is not a baseline — so it has to live somewhere both can import without
 * crossing that boundary.
 *
 * Zero dependencies is therefore a requirement, not a style choice. Do not add an
 * import here.
 *
 * **Why this text matters.** The two arms were originally told different things:
 *
 * - Myco's intent (`src/tasks/intent.ts`): "…to `newValue`, **and save the file**."
 * - The baseline's task line (`c1-trial.ts:46` before this module): "Set the X
 *   cell for record Y to Z." — no save.
 *
 * The baseline's planner also saw "Save and close it" in its system prompt, so the
 * two arms differed in the task line itself. Twelve of the arm's refutations were
 * rows that typed the correct value and never saved: a task-completion difference
 * induced by the instruction, not a grounding failure. Arm-003 re-runs with this
 * text on both sides.
 * See docs/research/experiments/c1-arm-003-design.md.
 */

/** The minimum needed to render the task text. */
export interface TaskTextParams {
  rowKey: string;
  column: string;
  newValue: string | number;
}

/**
 * The canonical task sentence. **Both arms must render their task line from
 * this function**, so instruction parity is checkable by diffing two recorded
 * fields rather than by reading source.
 */
export function taskText(params: TaskTextParams): string {
  return `Set the cell at record ${params.rowKey}, column ${params.column}, to ${JSON.stringify(params.newValue)}, and save the file.`;
}
