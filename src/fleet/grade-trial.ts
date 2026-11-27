/**
 * Linux desktop fleet: the independent grade of one trial, from the bytes its gate read.
 *
 * After a desktop's trial is decided, its vault holds the persisted document captured after
 * the agent stopped (`<vault run dir>/captured/persisted/<stateFile>`) and the capture
 * manifest (`capture.json`) with that file's sha256. This module reads both without
 * blocking or following a final symlink (`readRegularNoBlock`), refuses bytes that do not
 * hash to the manifest's entry, and hands the bytes to the independent grader
 * (`src/benchmark/grade/grade.ts`) with the pristine fixture and the intent. So the grader
 * grades exactly the bytes the gate decided on, and nothing the gate computed.
 *
 * Independence: this module imports the grader and the non-blocking read only. It imports
 * nothing from `src/gate/`, `src/parallel/` or `src/tasks/`, and it never sees the claim or
 * the gate's verdict (`test/fleet/import-boundary.test.ts`). The fixture bytes and the
 * intent are handed in by the caller, as the R1 runner hands them to the grader.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type ColumnType, grade } from "../benchmark/grade/grade.ts";
import { readRegularNoBlock } from "../integrity/nonblocking-read.ts";

/** Largest capture manifest the fleet reads. */
export const MANIFEST_LIMIT_BYTES = 1024 * 1024;
/** Largest persisted document the fleet reads (the pool's capture cap). */
export const DOCUMENT_LIMIT_BYTES = 16 * 1024 * 1024;

export type GradeBindingCode =
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_MALFORMED"
  | "NOT_IN_MANIFEST"
  | "DOCUMENT_UNREADABLE"
  | "DOCUMENT_HASH_MISMATCH";

export interface TrialGradeInput {
  /** The trial's vault run dir (the dir holding `capture.json`). */
  readonly vaultRunDir: string;
  /** Workspace-relative state file the task saves (e.g. `sheet.csv`). */
  readonly stateFile: string;
  readonly fixtureCsv: Uint8Array;
  readonly fixtureSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
}

export interface TrialGrade {
  readonly status: "pass" | "fail" | "ungradable";
  /** Null when the grader graded the captured bytes; a code when it could not be bound. */
  readonly binding: GradeBindingCode | null;
  readonly persistedSha256: string | null;
  readonly graderVersion: string | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function unbound(binding: GradeBindingCode): TrialGrade {
  return { status: "ungradable", binding, persistedSha256: null, graderVersion: null };
}

export function gradeTrial(input: TrialGradeInput): TrialGrade {
  const manifest = readRegularNoBlock(join(input.vaultRunDir, "capture.json"), {
    maxBytes: MANIFEST_LIMIT_BYTES,
  });
  if (!manifest.ok) return unbound("MANIFEST_UNREADABLE");
  let files: unknown;
  try {
    files = (JSON.parse(manifest.bytes.toString("utf8")) as { files?: unknown }).files;
  } catch {
    return unbound("MANIFEST_MALFORMED");
  }
  if (typeof files !== "object" || files === null) return unbound("MANIFEST_MALFORMED");
  const rel = `captured/persisted/${input.stateFile}`;
  const want = (files as Record<string, unknown>)[rel];
  if (typeof want !== "string") return unbound("NOT_IN_MANIFEST");
  const doc = readRegularNoBlock(join(input.vaultRunDir, rel), { maxBytes: DOCUMENT_LIMIT_BYTES });
  if (!doc.ok) return unbound("DOCUMENT_UNREADABLE");
  if (sha256(doc.bytes) !== want) return unbound("DOCUMENT_HASH_MISMATCH");
  const g = grade({
    fixtureCsv: input.fixtureCsv,
    fixtureSha256: input.fixtureSha256,
    persisted: { format: "csv", bytes: doc.bytes },
    intent: input.intent,
    columnTypes: input.columnTypes,
  });
  return {
    status: g.status,
    binding: null,
    persistedSha256: g.persistedSha256,
    graderVersion: g.graderVersion,
  };
}
