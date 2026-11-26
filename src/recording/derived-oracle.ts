/**
 * Track R: the derived oracle. An interpreter for a closed set of assertion types over the
 * persisted CSV document, the R5 self-test that must pass before it may verify anything,
 * and the gate family that runs it.
 *
 * Trust: a derived oracle was compiled from a demonstration, not written and reviewed by
 * hand, so it is labelled `derived` (lower trust than a built-in oracle) in every result
 * and report, and its results are never R1 evidence (`replay.ts` pins `r1Evidence: false`;
 * a derived task set is unknown to `src/benchmark/taskset-binding.ts`, which refuses it).
 *
 * No code from the recording or the agent runs here. `evaluateDerived` is a fixed function
 * of (persisted bytes, bound oracle, sealed fixture bytes). It interprets three assertion
 * types and refuses any other (`checkBoundOracle`), and it uses no `eval`, `Function`,
 * dynamic import or process launch (pinned by test/recording/oracle-sandbox.test.ts).
 *
 * R5 gate on verification: `certifyDerivedOracle` runs the oracle mutation self-test
 * (`src/oracle-selftest/run.ts`) with cases built from the workflow's intended edits on the
 * replay's fixture. Only a passing oracle is recorded as certified, in a process-local set
 * no JSON can write to. The gate family refuses an uncertified oracle twice: at registry
 * build (`checkSpec` returns an error, so the gate never starts) and at decision time
 * (`decide` throws, which the gate turns into `uncertain` ORACLE_ERROR). Fail closed: a
 * derived oracle that did not pass can never produce `verified`.
 */
import { isSafeId } from "../gate/api.ts";
import { type OracleFamily, type OracleOutput, StateCorruptError } from "../gate/families.ts";
import { specDigest } from "../gate/gate.ts";
import { type OracleReport, runSelfTest } from "../oracle-selftest/run.ts";
import type {
  CorruptionClass,
  OracleUnderTest,
  SavedDocument,
  SelfTestCase,
} from "../oracle-selftest/types.ts";
import { applyEdits } from "./compile.ts";
import {
  a1,
  CSV_UNSAFE,
  CsvDocumentError,
  locateKeyed,
  parseCsvRows,
  serializeCsvRows,
  sha256Hex,
} from "./csv.ts";
import {
  type BoundDerivedOracle,
  DERIVED_ASSERTION_TYPES,
  DERIVED_ORACLE_SCHEMA,
  type KeyedEdit,
} from "./types.ts";

export const DERIVED_FAMILY_ID = "derived-workflow";
export const DERIVED_FAMILY_VERSION = "derived/1";
export const DERIVED_TRUST_LABEL =
  "DERIVED oracle (compiled from a demonstration; lower trust than built-in oracles; never R1 evidence)";

export class DerivedOracleSpecError extends Error {
  override readonly name = "DerivedOracleSpecError";
}

const MAX_ASSERTIONS = 64;
const ASSERTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  "header-equals-fixture": ["type"],
  "cell-equals": ["type", "rowKey", "column", "value"],
  "others-equal-fixture": ["type"],
};

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((k) => keys.includes(k));
}

/** Why `value` is not a well-formed bound derived oracle, or undefined. Closed shape, allowlist only. */
export function checkBoundOracle(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "oracle must be an object";
  if (!exactKeys(value, ["schema", "trust", "workflowId", "assertions"]))
    return "oracle has unknown or missing fields";
  const o = value as Record<string, unknown>;
  if (o.schema !== DERIVED_ORACLE_SCHEMA) return `oracle.schema must be ${DERIVED_ORACLE_SCHEMA}`;
  if (o.trust !== "derived") return 'oracle.trust must be "derived"';
  if (typeof o.workflowId !== "string" || !isSafeId(o.workflowId))
    return "oracle.workflowId must be a safe id";
  if (
    !Array.isArray(o.assertions) ||
    o.assertions.length === 0 ||
    o.assertions.length > MAX_ASSERTIONS
  )
    return `oracle.assertions must hold 1-${MAX_ASSERTIONS} assertions`;
  let cells = 0;
  for (const [i, a] of o.assertions.entries()) {
    if (typeof a !== "object" || a === null || Array.isArray(a))
      return `assertion ${i} must be an object`;
    const type = (a as { type?: unknown }).type;
    if (typeof type !== "string" || !(DERIVED_ASSERTION_TYPES as readonly string[]).includes(type))
      return `assertion ${i}: type is not allowlisted`;
    if (!exactKeys(a, ASSERTION_KEYS[type] as readonly string[]))
      return `assertion ${i}: unknown or missing fields`;
    if (type === "cell-equals") {
      cells++;
      for (const f of ["rowKey", "column", "value"] as const) {
        const v = (a as Record<string, unknown>)[f];
        if (typeof v !== "string" || v === "" || CSV_UNSAFE.test(v))
          return `assertion ${i}: ${f} must be a CSV-safe string`;
      }
    }
  }
  if (cells === 0) return "oracle asserts no cell";
  return undefined;
}

export interface DerivedEvaluation {
  readonly status: "verified" | "refuted";
  readonly reasons: readonly string[];
  readonly codes: ReadonlyArray<"TARGET_MISMATCH" | "DOCUMENT_COLLATERAL">;
}

const LISTED = 10;
const list = (refs: readonly string[]) =>
  refs.length > LISTED
    ? `${refs.slice(0, LISTED).join(", ")} and ${refs.length - LISTED} more`
    : refs.join(", ");

/**
 * Evaluate a bound derived oracle on the persisted bytes against the sealed fixture.
 * Throws `DerivedOracleSpecError` for a malformed oracle or one that does not target the
 * fixture (operator error), and `CsvDocumentError` when the persisted bytes cannot be read
 * (could not look). Reasons name cells, never values.
 */
export function evaluateDerived(
  persisted: Uint8Array,
  oracle: BoundDerivedOracle,
  fixture: Uint8Array,
): DerivedEvaluation {
  const problem = checkBoundOracle(oracle);
  if (problem) throw new DerivedOracleSpecError(problem);
  let fx: string[][];
  try {
    fx = parseCsvRows(fixture);
  } catch {
    throw new DerivedOracleSpecError("the sealed fixture is not a readable CSV document");
  }
  const actual = parseCsvRows(persisted);
  const targets = new Map<string, string>();
  for (const a of oracle.assertions) {
    if (a.type !== "cell-equals") continue;
    const at = locateKeyed(fx, a.rowKey, a.column);
    if ("error" in at)
      throw new DerivedOracleSpecError(
        `a cell assertion does not target the fixture (${at.error})`,
      );
    targets.set(a1(at.row, at.col), a.value);
  }
  const cell = (rows: string[][], r: number, c: number) => rows[r]?.[c] ?? "";
  const targetMiss: string[] = [];
  const collateral = new Set<string>();
  for (const a of oracle.assertions) {
    switch (a.type) {
      case "header-equals-fixture": {
        const width = Math.max(fx[0]?.length ?? 0, actual[0]?.length ?? 0);
        for (let c = 0; c < width; c++)
          if (cell(actual, 0, c) !== cell(fx, 0, c)) collateral.add(a1(0, c));
        break;
      }
      case "cell-equals": {
        const at = locateKeyed(fx, a.rowKey, a.column);
        if ("error" in at) throw new DerivedOracleSpecError("unreachable: target vanished");
        if (cell(actual, at.row, at.col) !== a.value) targetMiss.push(a1(at.row, at.col));
        break;
      }
      case "others-equal-fixture": {
        const rows = Math.max(fx.length, actual.length);
        for (let r = 0; r < rows; r++) {
          const width = Math.max(fx[r]?.length ?? 0, actual[r]?.length ?? 0);
          for (let c = 0; c < width; c++) {
            const ref = a1(r, c);
            if (!targets.has(ref) && cell(actual, r, c) !== cell(fx, r, c)) collateral.add(ref);
          }
        }
        break;
      }
      default:
        // Unreachable after checkBoundOracle; fail closed if the allowlist ever drifts.
        throw new DerivedOracleSpecError("assertion type is not allowlisted");
    }
  }
  const codes: ("TARGET_MISMATCH" | "DOCUMENT_COLLATERAL")[] = [];
  const reasons: string[] = [];
  if (targetMiss.length > 0) {
    codes.push("TARGET_MISMATCH");
    reasons.push(
      `TARGET_MISMATCH: derived check: cell(s) ${list(targetMiss)} do not hold the workflow's value`,
    );
  }
  if (collateral.size > 0) {
    codes.push("DOCUMENT_COLLATERAL");
    reasons.push(
      `DOCUMENT_COLLATERAL: derived check: ${collateral.size} other cell(s) differ from the fixture: ${list([...collateral])}`,
    );
  }
  if (codes.length > 0) return { status: "refuted", reasons, codes };
  return { status: "verified", reasons: ["derived check: every assertion holds"], codes: [] };
}

// ---------------------------------------------------------------------------
// R5 self-test and certification
// ---------------------------------------------------------------------------

/** Classes the derived oracle claims. CSV has no container, so partial-save and missing-main-part do not apply. */
export const DERIVED_CLAIMS: ReadonlySet<CorruptionClass> = new Set<CorruptionClass>([
  "edit-missing",
  "wrong-value",
  "wrong-target",
  "collateral",
  "truncated",
  "corrupt-byte",
  "missing-file",
]);

/** The derived oracle as an R5 subject: the same `evaluateDerived` the gate family runs. */
export function derivedOracleUnderTest(
  oracle: BoundDerivedOracle,
  fixture: Uint8Array,
): OracleUnderTest<null> {
  return {
    name: `derived:${oracle.workflowId}`,
    version: DERIVED_FAMILY_VERSION,
    claims: DERIVED_CLAIMS,
    verify(doc) {
      if (doc.bytes === null) return { status: "uncertain", code: "state-missing" };
      try {
        const v = evaluateDerived(doc.bytes, oracle, fixture);
        return { status: v.status, code: v.codes.join("+") || "postcondition-holds" };
      } catch (error) {
        if (error instanceof CsvDocumentError)
          return { status: "uncertain", code: "could-not-look" };
        throw error;
      }
    },
  };
}

const utf8 = (rows: readonly (readonly string[])[]) =>
  new TextEncoder().encode(serializeCsvRows(rows));

/**
 * Seeded corruption cases from the workflow's intended edits on `fixture`: one case per edit,
 * each corruption aimed at that edit, all built from the correct document of the case.
 */
export function derivedSelfTestCases(
  edits: readonly KeyedEdit[],
  fixture: Uint8Array,
): SelfTestCase<null>[] {
  const fx = parseCsvRows(fixture);
  const correctRows = applyEdits(fx, edits);
  const correct = utf8(correctRows);
  const doc = (bytes: Uint8Array | null): SavedDocument => ({ fileName: "doc.csv", bytes });
  const targetRefs = new Set(
    edits.map((e) => {
      const at = locateKeyed(fx, e.rowKey, e.column);
      return "error" in at ? "" : a1(at.row, at.col);
    }),
  );
  const width = fx[0]?.length ?? 0;
  return edits.map((edit, i) => {
    const others = edits.filter((_e, j) => j !== i);
    const at = locateKeyed(fx, edit.rowKey, edit.column);
    if ("error" in at)
      throw new DerivedOracleSpecError(`edit ${i + 1} does not target the fixture`);
    // Wrong target: the value lands in the next data column of the same record instead.
    const neighbourCol = at.col + 1 < width ? at.col + 1 : 1;
    const wrongTarget = applyEdits(fx, others);
    (wrongTarget[at.row] as string[])[neighbourCol === at.col ? 1 : neighbourCol] = edit.value;
    // Collateral: the correct document plus one non-target data cell changed.
    const collateral = correctRows.map((r) => [...r]);
    outer: for (let r = 1; r < collateral.length; r++) {
      for (let c = 1; c < width; c++) {
        if (!targetRefs.has(a1(r, c))) {
          (collateral[r] as string[])[c] = `${collateral[r]?.[c] ?? ""}0`;
          break outer;
        }
      }
    }
    const flipped = correct.slice();
    flipped[Math.floor(flipped.length / 2)] = 0xff;
    return {
      id: `derived-edit-${i + 1}`,
      intent: null,
      correct: doc(correct),
      corruptions: [
        { cls: "edit-missing", doc: doc(utf8(applyEdits(fx, others))) },
        {
          cls: "wrong-value",
          doc: doc(utf8(applyEdits(fx, [...others, { ...edit, value: `${edit.value}0` }]))),
        },
        { cls: "wrong-target", doc: doc(utf8(wrongTarget)) },
        { cls: "collateral", doc: doc(utf8(collateral)) },
        { cls: "truncated", doc: doc(correct.slice(0, Math.floor(correct.length / 2))) },
        { cls: "corrupt-byte", doc: doc(flipped) },
        { cls: "missing-file", doc: doc(null) },
      ],
    };
  });
}

export interface Certification {
  readonly pass: boolean;
  readonly report: OracleReport;
  /** Digest of { oracle, fixtureSha256 }: what the certification covers. */
  readonly digest: string;
  readonly fixtureSha256: string;
}

/** Process-local: only `certifyDerivedOracle` writes it, and only for a passing self-test. */
const certified = new Map<string, OracleReport>();

function certificationDigest(oracle: unknown, fixtureSha256: string): string {
  return specDigest({ oracle, fixtureSha256 });
}

/**
 * Run the R5 oracle mutation self-test on a bound derived oracle with the workflow's
 * intended edits on `fixture`. Records the oracle as certified only when the self-test
 * passes. A harness error (cases that cannot be built) is a failed certification.
 */
export function certifyDerivedOracle(
  oracle: BoundDerivedOracle,
  edits: readonly KeyedEdit[],
  fixture: Uint8Array,
): Certification {
  const fixtureSha256 = sha256Hex(fixture);
  const digest = certificationDigest(oracle, fixtureSha256);
  const subject = derivedOracleUnderTest(oracle, fixture);
  let cases: SelfTestCase<null>[];
  try {
    cases = checkBoundOracle(oracle) === undefined ? derivedSelfTestCases(edits, fixture) : [];
  } catch {
    cases = [];
  }
  const { report } = runSelfTest(subject, cases);
  if (report.pass) certified.set(digest, report);
  return { pass: report.pass, report, digest, fixtureSha256 };
}

export function isCertified(oracle: unknown, fixtureSha256: string): boolean {
  return certified.has(certificationDigest(oracle, fixtureSha256));
}

// ---------------------------------------------------------------------------
// Gate family
// ---------------------------------------------------------------------------

/** The gate spec of a derived task: the bound oracle and the sealed fresh fixture it runs against. */
export interface DerivedTaskSpec {
  readonly oracle: BoundDerivedOracle;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function specProblem(spec: unknown): string | undefined {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec))
    return "spec must be an object";
  if (!exactKeys(spec, ["oracle", "fixtureFile", "fixtureSha256"]))
    return "spec has unknown or missing fields";
  const s = spec as Record<string, unknown>;
  if (typeof s.fixtureFile !== "string" || !isSafeId(s.fixtureFile))
    return "spec.fixtureFile must be a plain file name";
  if (typeof s.fixtureSha256 !== "string" || !SHA256_HEX.test(s.fixtureSha256))
    return "spec.fixtureSha256 must be a lowercase sha256 hex digest";
  const bad = checkBoundOracle(s.oracle);
  if (bad) return `spec.${bad}`;
  return undefined;
}

/**
 * The gate family for derived oracles. Registered by the replay harness in its own family
 * map (`buildRegistry(entries, families)`); the gate's built-in FAMILIES are untouched.
 * It always uses a sealed fixture: the fresh fixture the replay started from, read through
 * the operator's evidence reader and digest-checked by the gate before `decide` runs.
 */
export const derivedWorkflowFamily: OracleFamily = {
  id: DERIVED_FAMILY_ID,
  version: DERIVED_FAMILY_VERSION,
  checkSpec(spec) {
    const problem = specProblem(spec);
    if (problem) return problem;
    const s = spec as DerivedTaskSpec;
    if (!isCertified(s.oracle, s.fixtureSha256)) {
      return "derived oracle has not passed the R5 oracle mutation self-test on this fixture";
    }
    return undefined;
  },
  sealedFixture(spec) {
    const s = spec as DerivedTaskSpec;
    return { file: s.fixtureFile, sha256: s.fixtureSha256 };
  },
  decide(bytes, spec, _ref, inputs): OracleOutput {
    const problem = specProblem(spec);
    if (problem) throw new DerivedOracleSpecError(problem);
    const s = spec as DerivedTaskSpec;
    if (!isCertified(s.oracle, s.fixtureSha256)) {
      throw new DerivedOracleSpecError("derived oracle is not certified by the R5 self-test");
    }
    const fixture = inputs?.fixture;
    if (fixture === undefined || sha256Hex(fixture) !== s.fixtureSha256) {
      throw new DerivedOracleSpecError("the sealed fixture is missing or is not the certified one");
    }
    try {
      const v = evaluateDerived(bytes, s.oracle, fixture);
      return v.status === "verified"
        ? { status: "verified", reasons: [...v.reasons] }
        : { status: "refuted", reasons: [...v.reasons], codes: [...v.codes] };
    } catch (error) {
      if (error instanceof CsvDocumentError) throw new StateCorruptError(error.message);
      throw error;
    }
  },
};
