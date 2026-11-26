/**
 * Agent-safe corrections (TIF-265 follow-up, M2 scope add B: the self-correcting loop).
 *
 * On a refuted or uncertain verdict the gate may hand the agent a short, typed correction
 * it can act on ("cell C3 holds 4224; the task asked for 4242"), so the agent fixes its
 * document in the app and the harness re-checks within the EXISTING retry budget
 * (`multistep.ts`: one retry from the last verified checkpoint). This is a new, explicitly
 * scoped channel. It does not loosen the codes-only rule anywhere else: `reasons` and
 * `reasonCodes` are byte-for-byte what they are with corrections off.
 *
 * What a correction may reveal (and nothing else):
 *  - what the task instruction already gave the agent: the target's record, column and the
 *    value it was told to write (`src/tasks/task-text.ts` states all three), and the step
 *    number of a multi-step task;
 *  - what the agent can observe in its own saved document: the A1 address of a target cell,
 *    what that cell now holds, whether the saved document is the one it was given, and the
 *    addresses of non-target cells its save changed.
 *
 * What it never reveals: a value of any cell the task does not name (neither the pristine
 * fixture's nor the agent's), the pristine value of a target cell (`target_unchanged` has
 * no value field), the fixture, its digest, the oracle's spec beyond the instruction's
 * fields, oracle text, file paths, vault or receipt details.
 *
 * Collateral addresses: an address says "your save changed this cell", not what belongs
 * there. The agent can see the cell in the app; the address is already in the agent-facing
 * DOCUMENT_COLLATERAL reason (TIF-270 round 2), so the correction adds no new information;
 * and without the pristine value an address cannot be turned into a passing document except
 * by undoing the change in the app (or the harness's checkpoint restore). So addresses are
 * safe; values are not, and are never included.
 *
 * Trust: corrections are built here, by the gate, from its own comparison of the persisted
 * bytes with the expected document, never from oracle output. They are emitted only when
 * that comparison agrees with the oracle's detail codes (a disagreement yields none), and
 * every correction passes `sealCorrections`, which rebuilds each one field by field from
 * the operator's spec (closed schema; any unknown kind or field drops all of them).
 *
 * Opt-in per family (`GateConfig.corrections`), off by default: R1 evidence runs leave it
 * off unless the lead rules otherwise, and R1 arm rows record whether it was on
 * (`schemas/benchmark-ledger.ts`, `gate.corrections`).
 *
 * Independence: gate code. Nothing here is imported by `src/benchmark/grade/`.
 */
import {
  CORRECTION_CELL_LIMIT,
  CORRECTION_VALUE_LIMIT,
  type Correction,
  type GateVerdict,
  type ReasonCode,
} from "./api.ts";
import {
  type CellEdit,
  diffDocument,
  fixtureCells,
  parseDocument,
  pristineCells,
  targetRef,
} from "./calc-document.ts";
import type { GateTask } from "./gate.ts";

/** Operator-only: which task families get corrections. Absent or empty: none. */
export interface CorrectionPolicy {
  readonly families: readonly string[];
}

/** One target the instruction names: where it is and what the agent was told to write. */
export interface CorrectionTarget {
  readonly step?: number;
  readonly cell: string;
  readonly record: string;
  readonly column: string;
  readonly expected: string;
}

interface CorrectableFamily {
  /** The family version whose decision rule this module mirrors. */
  readonly version: string;
  targets(spec: unknown): CorrectionTarget[];
  /** The document the agent was given, as cells. */
  pristine(spec: unknown, fixture: Uint8Array | undefined): Map<string, string>;
}

interface RecordEditSpec extends CellEdit {
  readonly fixtureSeed: string;
  readonly fixtureSha256?: string;
}

interface MultiStepSpec {
  readonly fixtureSeed: string;
  readonly steps: readonly CellEdit[];
}

const CORRECTABLE: ReadonlyMap<string, CorrectableFamily> = new Map<string, CorrectableFamily>([
  [
    "calc-record-edit",
    {
      version: "2",
      targets(spec) {
        const { fixtureSeed, rowKey, column, newValue } = spec as RecordEditSpec;
        return [
          {
            cell: targetRef(fixtureSeed, { rowKey, column, newValue }),
            record: rowKey,
            column,
            expected: newValue,
          },
        ];
      },
      pristine(spec, fixture) {
        const { fixtureSeed, fixtureSha256 } = spec as RecordEditSpec;
        if (fixtureSha256 === undefined) return pristineCells(fixtureSeed);
        // The gate digest-checked these bytes against the spec before the oracle ran.
        if (fixture === undefined) throw new Error("sealed fixture not supplied");
        return fixtureCells(fixture);
      },
    },
  ],
  [
    "calc-multi-step",
    {
      version: "1",
      targets(spec) {
        const { fixtureSeed, steps } = spec as MultiStepSpec;
        return steps.map((step, index) => ({
          step: index + 1,
          cell: targetRef(fixtureSeed, step),
          record: step.rowKey,
          column: step.column,
          expected: step.newValue,
        }));
      },
      pristine(spec) {
        return pristineCells((spec as MultiStepSpec).fixtureSeed);
      },
    },
  ],
]);

/** Families that can be given corrections. */
export const CORRECTABLE_FAMILIES: readonly string[] = [...CORRECTABLE.keys()];

/**
 * Validate the operator's policy and say whether corrections are on for `task`. Throws
 * (so a misconfigured gate never starts) when the policy names a family this module cannot
 * correct, or when the task's family is named but its version or persisted format is not
 * the one this module mirrors: a correction must come from the same rule the oracle used.
 */
export function correctionsEnabled(policy: CorrectionPolicy | undefined, task: GateTask): boolean {
  if (policy === undefined) return false;
  const { families } = policy;
  if (!Array.isArray(families) || !families.every((f) => typeof f === "string"))
    throw new Error("invalid gate corrections: families must be an array of family ids");
  for (const family of families) {
    if (!CORRECTABLE.has(family))
      throw new Error(
        `invalid gate corrections: family ${JSON.stringify(family)} has no correction support (supported: ${CORRECTABLE_FAMILIES.join(", ")})`,
      );
  }
  if (!families.includes(task.family.id)) return false;
  const supported = CORRECTABLE.get(task.family.id) as CorrectableFamily;
  if (task.family.version !== supported.version)
    throw new Error(
      `invalid gate corrections: ${task.family.id}@${task.family.version} is not the version corrections mirror (${supported.version})`,
    );
  const format = (task.spec as { persistedFormat?: unknown }).persistedFormat;
  if (format !== undefined && format !== "csv")
    throw new Error(
      `invalid gate corrections: task ${task.id} persists ${String(format)}; corrections read CSV only`,
    );
  return true;
}

/** The targets the instruction of `task` names. `task` must be correctable. */
export function correctionTargets(task: GateTask): CorrectionTarget[] {
  const family = CORRECTABLE.get(task.family.id);
  if (!family) throw new Error(`no correction support for ${task.family.id}`);
  return family.targets(task.spec);
}

/** The one correction for persisted state that was not found after the agent stopped. */
export function missingStateCorrections(): Correction[] {
  return [{ kind: "document_not_saved", evidence: "no_saved_file" }];
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code) => b.includes(code));
}

/**
 * The gate's own comparison of the saved document with the expected one, as corrections.
 * Throws when it cannot build them or when its comparison disagrees with the oracle's
 * detail codes (`oracleCodes`); the gate then attaches none.
 */
export function documentCorrections(
  task: GateTask,
  bytes: Uint8Array,
  fixture: Uint8Array | undefined,
  oracleCodes: readonly ReasonCode[],
): Correction[] {
  const family = CORRECTABLE.get(task.family.id);
  if (!family) throw new Error(`no correction support for ${task.family.id}`);
  if (ZIP_MAGIC.every((byte, index) => bytes[index] === byte))
    throw new Error("saved bytes are a zip, not CSV");
  const { cells } = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const targets = family.targets(task.spec);
  const pristine = family.pristine(task.spec, fixture);
  const { collateral } = diffDocument(cells, pristine, new Set(targets.map((t) => t.cell)));
  const missed = targets.filter((t) => cells[t.cell] !== t.expected);

  const own: ReasonCode[] = [];
  if (missed.length > 0) own.push("TARGET_MISMATCH");
  if (collateral.length > 0) own.push("DOCUMENT_COLLATERAL");
  const detail = oracleCodes.filter((c) => c === "TARGET_MISMATCH" || c === "DOCUMENT_COLLATERAL");
  if (own.length === 0 || !sameCodes(own, detail))
    throw new Error("the gate's comparison disagrees with the oracle's detail codes");

  if (diffDocument(cells, pristine, new Set()).collateral.length === 0)
    return [{ kind: "document_not_saved", evidence: "saved_file_unchanged" }];

  const out: Correction[] = [];
  for (const target of missed) {
    const value = Object.hasOwn(cells, target.cell) ? (cells[target.cell] as string) : null;
    const fields = {
      ...(target.step === undefined ? {} : { step: target.step }),
      cell: target.cell,
      record: target.record,
      column: target.column,
      expected: target.expected,
    };
    if (value === pristine.get(target.cell) || (value === null && !pristine.has(target.cell))) {
      out.push({ kind: "target_unchanged", ...fields });
      continue;
    }
    const chars = value === null ? [] : Array.from(value);
    const truncated = chars.length > CORRECTION_VALUE_LIMIT;
    out.push({
      kind: "target_value_mismatch",
      ...fields,
      observed: value === null ? null : chars.slice(0, CORRECTION_VALUE_LIMIT).join(""),
      ...(truncated ? { observedTruncated: true as const } : {}),
    });
  }
  if (collateral.length > 0) {
    out.push({
      kind: "collateral_change",
      cells: collateral.slice(0, CORRECTION_CELL_LIMIT),
      more: Math.max(0, collateral.length - CORRECTION_CELL_LIMIT),
    });
  }
  return out;
}

/**
 * Whether candidate corrections may go out with a result: only on a non-accepted result
 * whose explaining code is ORACLE_FAIL (document corrections) or STATE_MISSING (the one
 * `no_saved_file` correction), and never next to AUDIT_FAILED. Every other path (input
 * rejections, ASSIGNMENT_MISMATCH, unreadable or corrupt state, fixture problems, oracle
 * errors, ORACLE_UNCERTAIN) carries none.
 */
export function correctionsAdmissible(
  verdict: GateVerdict,
  accepted: boolean,
  codes: readonly ReasonCode[],
  corrections: readonly Correction[],
): boolean {
  if (accepted || verdict === "verified" || codes.includes("AUDIT_FAILED")) return false;
  const missingFile = corrections.some(
    (c) => c.kind === "document_not_saved" && c.evidence === "no_saved_file",
  );
  if (verdict === "refuted" && codes[0] === "ORACLE_FAIL") return !missingFile;
  if (verdict === "uncertain" && codes[0] === "STATE_MISSING")
    return corrections.length === 1 && missingFile;
  return false;
}

const A1 = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const FIELDS: Readonly<Record<Correction["kind"], readonly string[]>> = {
  target_value_mismatch: [
    "kind",
    "step",
    "cell",
    "record",
    "column",
    "expected",
    "observed",
    "observedTruncated",
  ],
  target_unchanged: ["kind", "step", "cell", "record", "column", "expected"],
  document_not_saved: ["kind", "evidence"],
  collateral_change: ["kind", "cells", "more"],
};

/** Rebuild one correction from the closed schema and the spec's targets, or undefined. */
function sealOne(raw: unknown, targets: readonly CorrectionTarget[]): Correction | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) return undefined;
  const allowed = FIELDS[kind as Correction["kind"]];
  if (Object.keys(c).some((key) => !allowed.includes(key))) return undefined;
  switch (kind) {
    case "target_value_mismatch":
    case "target_unchanged": {
      // Every instruction-derived field must be exactly one target's; it is then copied from
      // the operator's spec, never from the candidate.
      const target = targets.find(
        (t) =>
          t.cell === c.cell &&
          t.record === c.record &&
          t.column === c.column &&
          t.expected === c.expected &&
          t.step === c.step,
      );
      if (!target) return undefined;
      const fields = {
        ...(target.step === undefined ? {} : { step: target.step }),
        cell: target.cell,
        record: target.record,
        column: target.column,
        expected: target.expected,
      };
      if (kind === "target_unchanged") return { kind, ...fields };
      const { observed, observedTruncated } = c;
      if (observed !== null && typeof observed !== "string") return undefined;
      if (typeof observed === "string" && Array.from(observed).length > CORRECTION_VALUE_LIMIT)
        return undefined;
      if (observed === target.expected) return undefined;
      if (observedTruncated !== undefined && observedTruncated !== true) return undefined;
      return {
        kind,
        ...fields,
        observed,
        ...(observedTruncated === true ? { observedTruncated: true as const } : {}),
      };
    }
    case "document_not_saved": {
      const { evidence } = c;
      if (evidence !== "no_saved_file" && evidence !== "saved_file_unchanged") return undefined;
      return { kind, evidence };
    }
    case "collateral_change": {
      const { cells, more } = c;
      if (!Array.isArray(cells) || cells.length === 0 || cells.length > CORRECTION_CELL_LIMIT)
        return undefined;
      const targetCells = new Set(targets.map((t) => t.cell));
      if (!cells.every((ref) => typeof ref === "string" && A1.test(ref) && !targetCells.has(ref)))
        return undefined;
      if (new Set(cells).size !== cells.length) return undefined;
      if (typeof more !== "number" || !Number.isInteger(more) || more < 0) return undefined;
      return { kind, cells: [...(cells as string[])], more };
    }
    default:
      return undefined;
  }
}

/**
 * The last gate before a correction reaches the agent: every candidate is rebuilt from the
 * closed schema and the operator's targets. If any candidate is malformed, names a cell or
 * value the instruction did not give, or carries an extra field, NO corrections are
 * returned (fail closed: a wrong correction is worse than none).
 */
export function sealCorrections(
  raw: readonly unknown[],
  targets: readonly CorrectionTarget[],
): Correction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > targets.length + 2) return undefined;
  const out: Correction[] = [];
  for (const candidate of raw) {
    const sealed = sealOne(candidate, targets);
    if (!sealed) return undefined;
    out.push(sealed);
  }
  return out;
}
