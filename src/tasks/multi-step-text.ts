/**
 * The multi-step task instruction (capability track K; `docs/recovery/recovery.md`), in a
 * module with **no imports**, like `./task-text.ts`, so any arm's harness can render it
 * without reaching fixture or gate code.
 *
 * ## What it must state, and why
 *
 * `docs/gate/api.md` (Corrections, "What a correction can and cannot reveal") lets a
 * `calc-multi-step` correction reveal a target's record, column, the value the agent was
 * told to write, and the step number, because the instruction already gave the agent those.
 * That is a requirement on this renderer: every step's line states its number, record,
 * column and value. `test/tasks/multi-step-text.test.ts` pins it against the gate's own
 * correction targets.
 *
 * It states nothing else about the document: no fixture value, no cell address, no seed.
 * The input type has no field for any of them. The value is JSON-quoted so a value with
 * spaces, commas or quotes reads unambiguously, and the save requirement is explicit (the
 * single-edit text's lesson: a task line without "save" measured a different job).
 */

export const MULTI_STEP_TEXT_VERSION = "multi-step-text/1";

/** The fewest and most steps the renderer accepts (`calc-multi-step` takes 2-10). */
export const MULTI_STEP_TEXT_MIN = 2;
export const MULTI_STEP_TEXT_MAX = 10;

/** One step as the instruction names it. */
export interface MultiStepTextStep {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

/**
 * A record key or column name must be one printable line of 1-64 characters, without a
 * double quote or a comma, so it cannot add a step or blur where a name ends.
 */
function isName(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
    if (ch === '"' || ch === ",") return false;
  }
  return true;
}

/**
 * The canonical multi-step instruction. Throws on a step list it cannot state
 * unambiguously: outside 2-10 steps; a record or column that is empty, over 64 characters,
 * or holds a control character, a line separator, a double quote or a comma; a value that
 * is not a string or holds a Unicode line separator; or two steps naming the same record
 * and column.
 */
export function multiStepTaskText(steps: readonly MultiStepTextStep[]): string {
  if (
    !Array.isArray(steps) ||
    steps.length < MULTI_STEP_TEXT_MIN ||
    steps.length > MULTI_STEP_TEXT_MAX
  )
    throw new Error(
      `a multi-step instruction needs ${MULTI_STEP_TEXT_MIN}-${MULTI_STEP_TEXT_MAX} steps`,
    );
  const seen = new Set<string>();
  const lines = steps.map((step, index) => {
    const n = index + 1;
    if (!isName(step?.rowKey))
      throw new Error(`step ${n}: the record key cannot be stated on one line`);
    if (!isName(step.column))
      throw new Error(`step ${n}: the column name cannot be stated on one line`);
    // JSON.stringify escapes control characters but not the Unicode line separators.
    if (typeof step.newValue !== "string" || /[\u2028\u2029]/.test(step.newValue))
      throw new Error(`step ${n}: the value must be a string without a line separator`);
    const cell = JSON.stringify([step.rowKey, step.column]);
    if (seen.has(cell)) throw new Error(`step ${n}: names the same record and column again`);
    seen.add(cell);
    return `Step ${n}: set the cell at record ${step.rowKey}, column ${step.column}, to ${JSON.stringify(step.newValue)}.`;
  });
  return [
    `Make these ${steps.length} edits to the open spreadsheet, in order. Change no other cell.`,
    ...lines,
    "Save the file after the last step.",
  ].join("\n");
}
