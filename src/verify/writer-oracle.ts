/**
 * Host-only Writer oracle (TIF-99 / M2-08).
 *
 * Same contract as the Calc oracle (`src/core/verify.ts`, `calcRecordEditVerifier`,
 * `UnoVerifier`): a three-valued `Verdict` over the persisted file and the intent.
 *   - `verified`: the postcondition holds in the saved file;
 *   - `refuted`:  the saved file was read in full and the postcondition provably fails;
 *   - `uncertain`: the oracle could not look (file missing, unreadable, corrupt or
 *     partially saved; ground truth not computable; or the target is ambiguous in an
 *     otherwise readable file). `uncertain` is never collapsed into either verdict,
 *     and uncertain reasons start with "could not look:", as Calc's do.
 *
 * Each verdict also carries a machine-readable `code` so a gate, a ledger or the R5
 * mutation report can count outcomes without parsing prose. The read-failure codes are
 * the Calc reader's `PersistedStateReadError` causes (`missing`/`unreadable`/`corrupt`).
 *
 * Verdict integrity (M2 plan R4): expected values come only from `groundTruth()` over
 * the intent params (fixtureSeed + params, host-side). The oracle takes the saved file
 * and the intent; it has no parameter for an agent claim, a screenshot or trace, and it
 * never derives an expectation from the file it is judging.
 */

import { PersistedStateReadError } from "../core/filepersist.ts";
import type { TaskIntent, Verdict, VerdictStatus } from "../core/verify.ts";
import {
  groundTruth,
  normalizeWriterParams,
  WRITER_TASK_ID,
  type WriterGroundTruth,
} from "../tasks/writer-doc-edit.ts";
import {
  documentParagraphs,
  documentTables,
  readWriterDocument,
  type WriterDocument,
} from "./writer-reader.ts";

export const WRITER_ORACLE_VERSION = 1;

export type WriterReasonCode =
  | "postcondition-holds"
  | "value-mismatch"
  | "target-absent"
  | "ambiguous-target"
  | "merged-cell"
  | "style-unresolved"
  | "read-missing"
  | "read-unreadable"
  | "read-corrupt"
  | "ground-truth-invalid";

/** Every code maps to exactly one status; only `postcondition-holds` is `verified`. */
export const WRITER_REASON_STATUS: Readonly<Record<WriterReasonCode, VerdictStatus>> = {
  "postcondition-holds": "verified",
  "value-mismatch": "refuted",
  "target-absent": "refuted",
  "ambiguous-target": "uncertain",
  "merged-cell": "uncertain",
  "style-unresolved": "uncertain",
  "read-missing": "uncertain",
  "read-unreadable": "uncertain",
  "read-corrupt": "uncertain",
  "ground-truth-invalid": "uncertain",
};

export interface WriterVerdict extends Verdict {
  readonly code: WriterReasonCode;
}

function verdict(code: WriterReasonCode, reason: string): WriterVerdict {
  const status = WRITER_REASON_STATUS[code];
  return { status, code, reasons: [status === "uncertain" ? `could not look: ${reason}` : reason] };
}

const show = (value: unknown): string => JSON.stringify(value);

/** Checks one postcondition against an already-parsed document. Pure. */
export function checkPostcondition(doc: WriterDocument, gt: WriterGroundTruth): WriterVerdict {
  const where = `${doc.filePath} (${doc.format})`;
  const paragraphs = documentParagraphs(doc);
  switch (gt.kind) {
    case "paragraph-text": {
      const p = paragraphs[gt.paragraph];
      if (p === undefined) {
        return verdict(
          "target-absent",
          `${where} has ${paragraphs.length} paragraphs; paragraph ${gt.paragraph + 1} is gone`,
        );
      }
      return p.text === gt.expected
        ? verdict(
            "postcondition-holds",
            `paragraph ${gt.paragraph + 1} persisted as ${show(p.text)} in ${where}`,
          )
        : verdict(
            "value-mismatch",
            `paragraph ${gt.paragraph + 1} expected ${show(gt.expected)} but ${where} has ${show(p.text)}`,
          );
    }
    case "heading-level": {
      const matches = paragraphs.filter((p) => p.text === gt.text);
      if (matches.length === 0)
        return verdict("target-absent", `no paragraph with text ${show(gt.text)} in ${where}`);
      if (matches.length > 1) {
        return verdict(
          "ambiguous-target",
          `${matches.length} paragraphs with text ${show(gt.text)} in ${where}`,
        );
      }
      const p = matches[0]!;
      if (!p.levelKnown) {
        return verdict(
          "style-unresolved",
          `the outline level of ${show(gt.text)} depends on a style ${where} does not define`,
        );
      }
      return p.headingLevel === gt.expected
        ? verdict(
            "postcondition-holds",
            `${show(gt.text)} is a level-${gt.expected} heading in ${where}`,
          )
        : verdict(
            "value-mismatch",
            `${show(gt.text)} expected heading level ${gt.expected} but ${where} has ${p.headingLevel === null ? "body text" : `level ${p.headingLevel}`}`,
          );
    }
    case "table-cell": {
      const table = documentTables(doc)[gt.table];
      if (table === undefined)
        return verdict("target-absent", `${where} has no table ${gt.table + 1}`);
      // A merged cell anywhere makes Writer's A1-style names shift: refuse to guess.
      if (table.rows.some((row) => row.some((c) => c.complex))) {
        return verdict(
          "merged-cell",
          `table ${gt.table + 1} in ${where} has merged or nested cells`,
        );
      }
      const cell = table.rows[gt.row]?.[gt.col];
      if (cell === undefined)
        return verdict("target-absent", `table ${gt.table + 1} in ${where} has no cell ${gt.cell}`);
      return cell.text === gt.expected
        ? verdict(
            "postcondition-holds",
            `cell ${gt.cell} of table ${gt.table + 1} persisted as ${show(cell.text)} in ${where}`,
          )
        : verdict(
            "value-mismatch",
            `cell ${gt.cell} of table ${gt.table + 1} expected ${show(gt.expected)} but ${where} has ${show(cell.text)}`,
          );
    }
    case "paragraph-style": {
      const p = paragraphs[gt.paragraph];
      if (p === undefined) {
        return verdict(
          "target-absent",
          `${where} has ${paragraphs.length} paragraphs; paragraph ${gt.paragraph + 1} is gone`,
        );
      }
      if (!p.styleResolved) {
        return verdict(
          "style-unresolved",
          `paragraph ${gt.paragraph + 1} names a style ${where} does not define`,
        );
      }
      return p.styleName === gt.expected
        ? verdict(
            "postcondition-holds",
            `paragraph ${gt.paragraph + 1} uses style ${show(gt.expected)} in ${where}`,
          )
        : verdict(
            "value-mismatch",
            `paragraph ${gt.paragraph + 1} expected style ${show(gt.expected)} but ${where} has ${show(p.styleName)}`,
          );
    }
  }
}

/** Host-side ground truth for an intent, or the `uncertain` verdict explaining why not. */
export function writerGroundTruthFor(intent: TaskIntent): WriterGroundTruth | WriterVerdict {
  if (intent.taskId !== WRITER_TASK_ID) {
    return verdict(
      "ground-truth-invalid",
      `intent is for task ${show(intent.taskId)}, not ${WRITER_TASK_ID}`,
    );
  }
  try {
    return groundTruth(normalizeWriterParams(intent.params));
  } catch (error) {
    return verdict(
      "ground-truth-invalid",
      `ground truth not computable from intent params — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const READ_CODES = {
  missing: "read-missing",
  unreadable: "read-unreadable",
  corrupt: "read-corrupt",
} as const satisfies Record<PersistedStateReadError["cause"], WriterReasonCode>;

/** Verifies a parsed document against an intent. */
export function verifyWriterDocument(doc: WriterDocument, intent: TaskIntent): WriterVerdict {
  const gt = writerGroundTruthFor(intent);
  return "status" in gt ? gt : checkPostcondition(doc, gt);
}

/**
 * The oracle entry point: reads the saved file at `filePath` and verifies the intent.
 * Never throws for a bad file; every read failure is an `uncertain` verdict.
 */
export function verifyWriterFile(filePath: string, intent: TaskIntent): WriterVerdict {
  const gt = writerGroundTruthFor(intent);
  if ("status" in gt) return gt;
  let doc: WriterDocument;
  try {
    doc = readWriterDocument(filePath);
  } catch (error) {
    if (error instanceof PersistedStateReadError)
      return verdict(READ_CODES[error.cause], error.message);
    return verdict(
      "read-unreadable",
      `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return checkPostcondition(doc, gt);
}
