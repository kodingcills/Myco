/**
 * Oracle mutation self-test runner (M2-09 / R5).
 *
 * For every case: the correct document must verify (the control), and every seeded
 * corruption is run. The bar, per oracle: for each class it CLAIMS, at least one corruption
 * was run and every one of them was caught (status other than `verified`), and every
 * control verified. Unclaimed classes are run and reported but never counted toward the
 * bar; a report that shows an unclaimed class verifying is how a gap is made visible.
 */
import type { VerdictStatus } from "../core/verify.ts";
import {
  CORRUPTION_CLASSES,
  type CorruptionClass,
  EXPECTED_STATUS,
  type OracleUnderTest,
  type OracleVerdict,
  type SelfTestCase,
} from "./types.ts";

export interface SelfTestRow {
  readonly oracle: string;
  readonly caseId: string;
  /** `control` for the correct document, else the corruption class. */
  readonly cls: CorruptionClass | "control";
  readonly claimed: boolean;
  readonly status: VerdictStatus | "harness-fault";
  readonly code: string;
  /** Control: verified. Corruption: anything but verified. */
  readonly ok: boolean;
  /** Corruption: the status equals the class's expected status (diagnostic only). */
  readonly expectedStatus: boolean;
}

export interface ClassSummary {
  readonly claimed: boolean;
  readonly runs: number;
  readonly caught: number;
  readonly expectedStatus: number;
}

export interface OracleReport {
  readonly oracle: string;
  readonly version: string;
  readonly claims: readonly CorruptionClass[];
  readonly cases: number;
  readonly controlsVerified: number;
  readonly perClass: Readonly<Record<CorruptionClass, ClassSummary>>;
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

function safeVerify<I>(
  oracle: OracleUnderTest<I>,
  doc: SelfTestCase<I>["correct"],
  intent: I,
): OracleVerdict | null {
  try {
    return oracle.verify(doc, intent);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function runSelfTest<I>(
  oracle: OracleUnderTest<I>,
  cases: readonly SelfTestCase<I>[],
): { rows: SelfTestRow[]; report: OracleReport } {
  const rows: SelfTestRow[] = [];
  for (const c of cases) {
    const control = safeVerify(oracle, c.correct, c.intent);
    rows.push({
      oracle: oracle.name,
      caseId: c.id,
      cls: "control",
      claimed: true,
      status: control?.status ?? "harness-fault",
      code: control?.code ?? "threw",
      ok: control?.status === "verified",
      expectedStatus: control?.status === "verified",
    });
    for (const { cls, doc } of c.corruptions) {
      // A corruption that did not change the document tests nothing. Never run the oracle on
      // it: record a harness fault, which fails the bar whether or not the class is claimed.
      if (sameBytes(doc.bytes, c.correct.bytes)) {
        rows.push({
          oracle: oracle.name,
          caseId: c.id,
          cls,
          claimed: oracle.claims.has(cls),
          status: "harness-fault",
          code: "corruption-equals-control",
          ok: false,
          expectedStatus: false,
        });
        continue;
      }
      const v = safeVerify(oracle, doc, c.intent);
      rows.push({
        oracle: oracle.name,
        caseId: c.id,
        cls,
        claimed: oracle.claims.has(cls),
        status: v?.status ?? "harness-fault",
        code: v?.code ?? "threw",
        // A throw is not a catch: the oracle contract is "never throw".
        ok: v !== null && v.status !== "verified",
        expectedStatus: v !== null && v.status === EXPECTED_STATUS[cls],
      });
    }
  }

  const perClass = Object.fromEntries(
    CORRUPTION_CLASSES.map((cls) => {
      const of = rows.filter((r) => r.cls === cls);
      return [
        cls,
        {
          claimed: oracle.claims.has(cls),
          runs: of.length,
          caught: of.filter((r) => r.ok).length,
          expectedStatus: of.filter((r) => r.expectedStatus).length,
        },
      ];
    }),
  ) as Record<CorruptionClass, ClassSummary>;

  const reasons: string[] = [];
  const controls = rows.filter((r) => r.cls === "control");
  const controlsVerified = controls.filter((r) => r.ok).length;
  if (cases.length === 0) reasons.push("no cases");
  if (controlsVerified !== controls.length) {
    reasons.push(
      `${controls.length - controlsVerified} of ${controls.length} correct documents did not verify`,
    );
  }
  for (const cls of CORRUPTION_CLASSES) {
    const degenerate = rows.filter(
      (r) => r.cls === cls && r.code === "corruption-equals-control",
    ).length;
    if (degenerate > 0) {
      reasons.push(
        `${cls}: ${degenerate} corruption(s) are byte-identical to the correct document`,
      );
    }
  }
  for (const cls of CORRUPTION_CLASSES) {
    const s = perClass[cls];
    if (!s.claimed) continue;
    if (s.runs === 0) reasons.push(`claims ${cls} but no ${cls} corruption was run`);
    else if (s.caught !== s.runs)
      reasons.push(`${cls}: ${s.runs - s.caught} of ${s.runs} corruptions verified`);
  }
  return {
    rows,
    report: {
      oracle: oracle.name,
      version: oracle.version,
      claims: CORRUPTION_CLASSES.filter((c) => oracle.claims.has(c)),
      cases: cases.length,
      controlsVerified,
      perClass,
      pass: reasons.length === 0,
      reasons,
    },
  };
}
