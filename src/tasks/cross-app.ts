/**
 * Cross-app task family `xa-pdf-calc-writer` (capability track P, tier 2): the task
 * DEFINITION, shared by the operator (task set, harness) and the gate. The independent
 * grader never imports it; it reads the committed bytes and the intent from the bundle.
 *
 * The task, as an agent receives it:
 *  1. (PDF -> Calc) read a value from the source notice (a PDF) and enter it into the sheet;
 *  2. (PDF -> Calc) read a second value from the notice and enter it into the sheet;
 *  3. (Calc -> Writer) fill in the report document with the two values now in the sheet.
 * The harness saves a snapshot of BOTH task documents after each step (the step's persisted
 * bytes) and after the agent stops (the end state). A step is one or more edits in one app:
 *  - a `calc` edit sets record `rowKey`, column `column` of the sheet to `newValue`;
 *  - a `writer` edit fills the report line `<rowKey> <column>:` with `newValue`, and must
 *    report a value an earlier calc step entered (the data flows PDF -> Calc -> Writer).
 *
 * Documents (formats the gate can read; see docs/gate/cross-app.md):
 *  - the sheet: CSV, the format the gate's Calc families already read (`calc-document.ts`);
 *    a real headless Calc loads and stores it in place without rewriting other cells;
 *  - the report: plain UTF-8 text, what Writer's "Text (encoded)" filter saves;
 *  - the source notice: a PDF the agent reads. Nobody parses it to decide: the gate and the
 *    grader only check its bytes against the digest the task registered (a sealed fixture).
 *
 * Everything here is deterministic: same seed, same bytes.
 */
import { createHash } from "node:crypto";
import { generateFixture, hash32 } from "./fixture.ts";
import { generateParameterSets, locateInFixture } from "./intent.ts";

export const CROSS_APP_FAMILY = "cross-app-steps";

/** One edit: a sheet cell (`calc`) or a report field (`writer`), named by record and column. */
export interface CrossAppEdit {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

export interface CrossAppStep {
  readonly app: "calc" | "writer";
  readonly edits: readonly CrossAppEdit[];
}

/** The operator's spec: what "done" means, step by step. The agent never sees or sends it. */
export interface CrossAppSpec {
  /** The pristine sheet is `generateFixture(fixtureSeed)` (CSV). */
  readonly fixtureSeed: string;
  /** The sealed source notice the guest is given: a file in the run's evidence, and its digest. */
  readonly source: { readonly file: string; readonly sha256: string };
  /** First line of the report template. */
  readonly reportTitle: string;
  readonly steps: readonly CrossAppStep[];
}

/** Evidence layout of one trial (relative to the run's evidence location). */
export const SHEET_FILE = "sheet.csv";
export const REPORT_FILE = "report.txt";
export const SOURCE_FILE = "source.pdf";
export const END_DIR = "end";
export const stepDir = (step: number) => `step-${step}`;
/** The gate's primary state file for this family (the end-state sheet). */
export const CROSS_APP_STATE_FILE = `${END_DIR}/${SHEET_FILE}`;

/** Every persisted file the gate reads for `stepCount` steps: each step's snapshot, then the end. */
export function crossAppEvidenceFiles(stepCount: number): string[] {
  const dirs = [...Array.from({ length: stepCount }, (_, i) => stepDir(i + 1)), END_DIR];
  return dirs.flatMap((dir) => [`${dir}/${SHEET_FILE}`, `${dir}/${REPORT_FILE}`]);
}

/** The label of a report field: `<rowKey> <column>`. */
export const fieldLabel = (edit: Pick<CrossAppEdit, "rowKey" | "column">) =>
  `${edit.rowKey} ${edit.column}`;

/** Every writer edit of the spec, in step order: the report's fields. */
export function reportFields(spec: Pick<CrossAppSpec, "steps">): CrossAppEdit[] {
  return spec.steps.filter((s) => s.app === "writer").flatMap((s) => [...s.edits]);
}

/** Number of lines before the first field line in the report template. */
export const REPORT_HEADER_LINES = 4;

/**
 * The report as the guest is given it (`filled` = none) or as it must read after the writer
 * edits in `filled` (labels -> values). LF line ends, one trailing LF, no BOM.
 */
export function reportText(
  spec: Pick<CrossAppSpec, "steps" | "reportTitle" | "source">,
  filled: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = [
    spec.reportTitle,
    `Source: ${spec.source.file}`,
    `Sheet: ${SHEET_FILE}`,
    "",
    ...reportFields(spec).map((edit) => {
      const label = fieldLabel(edit);
      const value = filled.get(label);
      return value === undefined ? `${label}:` : `${label}: ${value}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/** Calc edits and writer edits of steps 1..k (the expected state at checkpoint k). */
export function editsThrough(
  spec: Pick<CrossAppSpec, "steps">,
  k: number,
): { calc: CrossAppEdit[]; writer: CrossAppEdit[] } {
  const done = spec.steps.slice(0, k);
  return {
    calc: done.filter((s) => s.app === "calc").flatMap((s) => [...s.edits]),
    writer: done.filter((s) => s.app === "writer").flatMap((s) => [...s.edits]),
  };
}

/** The report expected at checkpoint k. */
export function reportAt(spec: CrossAppSpec, k: number): string {
  const { writer } = editsThrough(spec, k);
  return reportText(spec, new Map(writer.map((e) => [fieldLabel(e), e.newValue])));
}

/** The sheet (CSV) expected at checkpoint k: the pristine fixture with the calc edits applied. */
export function sheetAt(spec: Pick<CrossAppSpec, "fixtureSeed" | "steps">, k: number): string {
  const fixture = generateFixture(spec.fixtureSeed);
  const rows = fixture.rows.map((row) => [...row]);
  for (const edit of editsThrough(spec, k).calc) {
    const found = locateInFixture(spec.fixtureSeed, edit.rowKey, edit.column);
    if ("error" in found) throw new Error(`edit does not target the fixture: ${found.error}`);
    const row = rows[found.location.dataRowIndex];
    if (row) row[found.location.colIndex] = edit.newValue;
  }
  return `${[fixture.header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The source notice (PDF)
// ---------------------------------------------------------------------------

/** The lines the notice states, one per calc edit, in step order. */
export function sourceLines(spec: Pick<CrossAppSpec, "steps">): string[] {
  const calc = spec.steps.filter((s) => s.app === "calc").flatMap((s) => [...s.edits]);
  return [
    "Correction notice",
    "Apply these corrections to the staff sheet:",
    ...calc.map((e) => `Record ${e.rowKey}, column ${e.column}: ${e.newValue}`),
  ];
}

/** A PDF string literal: backslash, parentheses escaped; ASCII printable only. */
function pdfString(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("notice text must be printable ASCII");
  return `(${text.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

/**
 * A minimal, valid, deterministic PDF 1.4: one page, Helvetica, one text line per entry,
 * an uncompressed content stream and an exact cross-reference table. No dates or ids, so
 * the same lines always give the same bytes (and the same sealed digest).
 */
export function noticePdf(lines: readonly string[]): string {
  const content = [
    "BT",
    "/F1 12 Tf",
    "16 TL",
    "72 760 Td",
    ...lines.map((line, i) => `${i === 0 ? "" : "T* "}${pdfString(line)} Tj`),
    "ET",
    "",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// Generating a task from a seed
// ---------------------------------------------------------------------------

/**
 * The family's three-step task for a seed: two calc edits on distinct records (each value
 * from the notice), then one writer step reporting both. Values come from the M1 generator
 * (`generateParameterSets`), so they are safe from Calc's input rewriting.
 */
export function crossAppSpecFor(seed: string): CrossAppSpec {
  const fixture = generateFixture(seed);
  const picked: CrossAppEdit[] = [];
  // Start at a seed-dependent offset so tasks cover every typed column, not just the first two.
  const sets = generateParameterSets([seed]);
  const offset = hash32(`cross-app:${seed}`) % sets.length;
  for (const p of [...sets.slice(offset), ...sets.slice(0, offset)]) {
    const found = locateInFixture(seed, p.rowKey, p.column);
    if ("error" in found) continue;
    const pristine = fixture.rows[found.location.dataRowIndex]?.[found.location.colIndex];
    if (pristine === p.newValue) continue;
    if (picked.some((e) => e.rowKey === p.rowKey || e.column === p.column)) continue;
    picked.push({ rowKey: p.rowKey, column: p.column, newValue: p.newValue });
    if (picked.length === 2) break;
  }
  const [a, b] = picked;
  if (a === undefined || b === undefined) throw new Error(`seed ${seed} yields no two edits`);
  const steps: CrossAppStep[] = [
    { app: "calc", edits: [a] },
    { app: "calc", edits: [b] },
    { app: "writer", edits: [a, b] },
  ];
  const pdf = noticePdf(sourceLines({ steps }));
  return {
    fixtureSeed: seed,
    source: { file: SOURCE_FILE, sha256: sha256Hex(pdf) },
    reportTitle: "Correction report",
    steps,
  };
}

/** The exact instruction an agent receives (values are NOT in it: they are in the notice). */
export function crossAppInstruction(spec: CrossAppSpec): string {
  const lines = [
    `You have three documents: the correction notice ${spec.source.file} (PDF), the staff sheet ${SHEET_FILE} (open it in LibreOffice Calc) and the report ${REPORT_FILE} (open it in LibreOffice Writer).`,
    "Do the steps in order. After each step, save the document you changed in its current format and stop; you will be asked for the next step.",
  ];
  spec.steps.forEach((step, i) => {
    const what = step.edits.map((e) => `record ${e.rowKey}, column ${e.column}`).join(" and ");
    lines.push(
      step.app === "calc"
        ? `Step ${i + 1} (Calc): enter the notice's value for ${what} into the sheet, and save.`
        : `Step ${i + 1} (Writer): in the report, complete the line for ${what} with the value now in the sheet (after the colon and one space), and save.`,
    );
  });
  lines.push("Change nothing else in any document.");
  return `${lines.join("\n")}\n`;
}
