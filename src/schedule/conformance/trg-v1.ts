/**
 * Track S: `trg-v1`, the conformance corpus for S's property bar
 * (docs/product/capability-spec-2.md §1.1 and §2 S).
 *
 * The corpus is pure data, built deterministically: each trigger kind (cron, inbox, manual,
 * webhook) crossed with the pipeline cases spec-2 §2 S lists, plus kind-specific cases (webhook
 * signatures and secret, inbox symlinks and dotfiles, cron missed slots) and service-start
 * cases that do not depend on a trigger kind (zero policies, unknown config key, key-shaped
 * string, corrupt claims or cursor, a held state-dir lock). Each case states the outcome a
 * conformance run must observe. Nothing here runs the scheduler: the conformance runner
 * (follow-up) drives `src/schedule` with the scripted executor and writes one result per case,
 * and `analysis.ts` compares the results with these expectations.
 *
 * Expectations follow the merged behaviour documented in docs/schedule/README.md (#536). The
 * case with S-live (VM lock held) is deferred to the version that ships S-live; it is listed in
 * `TRG_V1_DEFERRED` and is not a case here.
 *
 * Changing anything in this file changes the manifest SHA-256 and so the pre-registration hash:
 * after the first conformance run, a change is a new corpus version (capability-spec §3.3).
 */

import type { RunStatus } from "../scheduler.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

export const TRG_VERSION = "trg-v1" as const;
export const TRG_CASE_SCHEMA = "myco.schedule.conformance-case/1" as const;
export const TRG_MANIFEST_SCHEMA = "myco.schedule.conformance-manifest/1" as const;

export type TriggerKind = "cron" | "inbox" | "manual" | "webhook";
export type CaseKind = TriggerKind | "service";

/** The S bar items (spec-2 §2 S, "Pre-registered bar") a case exercises. Item 6 is the mutation table. */
export type BarItem = 1 | 2 | 3 | 4 | 5;

/** How a service start that must fail is classified by the runner (codes only). */
export type StartupRefusal =
  | "NO_POLICY"
  | "CONFIG_INVALID"
  | "CLAIMS_CORRUPT"
  | "CURSOR_CORRUPT"
  | "LOCK_HELD"
  | "NON_LOOPBACK";

export interface ExpectedRow {
  readonly status: RunStatus;
  /** Scheduler codes in the row, in order (never the gate's reason codes). */
  readonly codes: readonly string[];
  readonly accepted: boolean;
}

export interface ExpectedResponse {
  readonly status: number;
  readonly code: string;
}

export interface Expected {
  readonly startup: "ok" | "refused";
  readonly startupRefusal: StartupRefusal | null;
  /** Executor invocations over the whole case. */
  readonly executorCalls: number;
  /** Rows written to the MAC-chained ledger, compared as a multiset (order is not fixed). */
  readonly ledgerRows: readonly ExpectedRow[];
  /** The row the scheduler reported for a run whose ledger write failed; else empty. */
  readonly unwrittenRows: readonly ExpectedRow[];
  /** Webhook HTTP responses in request order; empty for other kinds. */
  readonly responses: readonly ExpectedResponse[];
  readonly notifications: number;
}

export interface TrgCase {
  readonly schema: typeof TRG_CASE_SCHEMA;
  readonly id: string;
  readonly kind: CaseKind;
  readonly scenario: string;
  /** What the runner sets up, in words; the runner's own tests bind it to code. */
  readonly setup: string;
  readonly bar: readonly BarItem[];
  readonly inScope: boolean;
  /** Why an out-of-scope case is out of scope; its expected outcome is still checked. */
  readonly outOfScopeReason: string | null;
  readonly expected: Expected;
}

const KINDS: readonly TriggerKind[] = ["cron", "inbox", "manual", "webhook"];

const row = (status: RunStatus, codes: readonly string[] = [], accepted = false): ExpectedRow => ({
  status,
  codes,
  accepted,
});
const VERIFIED = row("verified", [], true);
const r = (status: number, code: string): ExpectedResponse => ({ status, code });
const ACCEPTED = r(202, "ACCEPTED");

interface Outcome {
  readonly executorCalls: number;
  readonly ledgerRows: readonly ExpectedRow[];
  readonly unwrittenRows?: readonly ExpectedRow[];
  readonly responses?: readonly ExpectedResponse[];
  readonly notifications: number;
  readonly startupRefusal?: StartupRefusal;
}

interface Scenario {
  readonly scenario: string;
  readonly kinds: readonly CaseKind[];
  readonly setup: string;
  readonly bar: readonly BarItem[];
  readonly outOfScopeReason?: string;
  readonly expect: (kind: CaseKind) => Outcome;
}

/** A one-row outcome after an admitted trigger (webhook answers 202). */
const single = (k: CaseKind, rw: ExpectedRow, executorCalls: number, notifications: number) => ({
  executorCalls,
  ledgerRows: [rw],
  responses: k === "webhook" ? [ACCEPTED] : [],
  notifications,
});

const queuedKind = (k: CaseKind) => k === "inbox" || k === "manual";

const SCENARIOS: readonly Scenario[] = [
  {
    scenario: "verified",
    kinds: KINDS,
    setup: "one trigger; the scripted agent completes the task; the gate decides verified",
    bar: [1, 4],
    expect: (k) => single(k, VERIFIED, 1, 0),
  },
  {
    scenario: "refuted",
    kinds: KINDS,
    setup: "one trigger; the scripted agent leaves the task undone; the gate decides refuted",
    bar: [1, 4],
    expect: (k) => single(k, row("refuted"), 1, 1),
  },
  {
    scenario: "policy-denies",
    kinds: KINDS,
    setup: "a second policy denies with code CONFORMANCE_DENY",
    bar: [1, 2],
    expect: (k) => single(k, row("denied", ["POLICY_DENIED", "CONFORMANCE_DENY"]), 0, 1),
  },
  {
    scenario: "policy-throws",
    kinds: KINDS,
    setup: "a second policy throws",
    bar: [1, 2],
    expect: (k) => single(k, row("denied", ["POLICY_ERROR"]), 0, 1),
  },
  {
    scenario: "policy-malformed",
    kinds: KINDS,
    setup: "a second policy returns { allow: 'yes' }",
    bar: [1, 2],
    expect: (k) => single(k, row("denied", ["POLICY_INVALID"]), 0, 1),
  },
  {
    scenario: "paused-then-resume",
    kinds: KINDS,
    setup:
      "pause; one trigger (cron: one slot) while paused; resume; webhook re-sends the same delivery; tick",
    bar: [3],
    expect: (k) => {
      if (k === "cron")
        // A paused cron slot is recorded in one quiet summary row and never caught up.
        return { executorCalls: 0, ledgerRows: [row("skipped", ["PAUSED"])], notifications: 0 };
      if (k === "webhook")
        // 423, not claimed; the sender's retry after resume runs.
        return {
          executorCalls: 1,
          ledgerRows: [row("skipped", ["PAUSED"]), VERIFIED],
          responses: [r(423, "PAUSED"), ACCEPTED],
          notifications: 0,
        };
      // Inbox files and manual requests stay queued while paused, then run once.
      return { executorCalls: 1, ledgerRows: [VERIFIED], notifications: 0 };
    },
  },
  {
    scenario: "killed-mid-run",
    kinds: KINDS,
    setup: "one trigger; the executor blocks until aborted; kill while it runs",
    bar: [1, 3],
    expect: (k) => single(k, row("killed", ["KILLED"]), 1, 1),
  },
  {
    scenario: "duplicate",
    kinds: KINDS,
    setup:
      "the same trigger twice (cron: the same slot key submitted twice; inbox: the same file on two scans; manual: the same request key; webhook: the same signed delivery)",
    bar: [3],
    expect: (k) => {
      // A re-scanned inbox file is skipped before submission: no second row.
      if (k === "inbox") return { executorCalls: 1, ledgerRows: [VERIFIED], notifications: 0 };
      return {
        executorCalls: 1,
        ledgerRows: [VERIFIED, row("skipped", ["DUPLICATE"])],
        responses: k === "webhook" ? [ACCEPTED, r(409, "DUPLICATE")] : [],
        notifications: 0,
      };
    },
  },
  {
    scenario: "restart-between-claim-and-run",
    kinds: KINDS,
    setup:
      "the claim is written; the scheduler is discarded before the executor starts; a new scheduler on the same state dir receives the same trigger",
    bar: [3],
    expect: (k) => {
      if (k === "inbox") return { executorCalls: 0, ledgerRows: [], notifications: 0 };
      return {
        executorCalls: 0,
        ledgerRows: [row("skipped", ["DUPLICATE"])],
        responses: k === "webhook" ? [r(409, "DUPLICATE")] : [],
        notifications: 0,
      };
    },
  },
  {
    scenario: "runs-per-day",
    kinds: KINDS,
    setup: "budget runsPerDay 1; two distinct triggers in the same UTC day",
    bar: [1, 3],
    expect: (k) => ({
      executorCalls: 1,
      ledgerRows: [VERIFIED, row("skipped", ["BUDGET_RUNS_PER_DAY"])],
      responses: k === "webhook" ? [ACCEPTED, r(429, "BUDGET_RUNS_PER_DAY")] : [],
      notifications: 1,
    }),
  },
  {
    scenario: "concurrency",
    kinds: KINDS,
    setup:
      "budget concurrency 1; the first run blocks; a second distinct trigger arrives; then the first run is released",
    bar: [1, 3],
    expect: (k) =>
      queuedKind(k)
        ? // Queued, not refused: the second run waits for the slot.
          { executorCalls: 2, ledgerRows: [VERIFIED, VERIFIED], notifications: 0 }
        : {
            executorCalls: 1,
            ledgerRows: [VERIFIED, row("skipped", ["BUDGET_CONCURRENCY"])],
            responses: k === "webhook" ? [ACCEPTED, r(429, "BUDGET_CONCURRENCY")] : [],
            notifications: 1,
          },
  },
  {
    scenario: "wall-time",
    kinds: KINDS,
    setup: "budget wallTimeS 1; the executor runs past it and stops on the abort signal",
    bar: [1, 4],
    expect: (k) => single(k, row("timeout", ["BUDGET_WALL_TIME"]), 1, 1),
  },
  {
    scenario: "executor-throws",
    kinds: KINDS,
    setup: "the executor throws",
    bar: [4],
    expect: (k) => single(k, row("error", ["EXECUTOR_ERROR"]), 1, 1),
  },
  {
    scenario: "executor-malformed",
    kinds: KINDS,
    setup: "the executor returns { outcome: 'done' }",
    bar: [4],
    expect: (k) => single(k, row("error", ["EXECUTOR_INVALID_OUTPUT"]), 1, 1),
  },
  {
    scenario: "result-run-mismatch",
    kinds: KINDS,
    setup: "the executor returns a verified gate result for another run id",
    bar: [1, 4],
    expect: (k) => single(k, row("uncertain", ["RESULT_RUN_MISMATCH"]), 1, 1),
  },
  {
    scenario: "result-inconsistent",
    kinds: KINDS,
    setup: "the executor returns verdict verified with accepted false",
    bar: [4],
    expect: (k) => single(k, row("uncertain", ["RESULT_INCONSISTENT"]), 1, 1),
  },
  {
    scenario: "launch-audit-refused",
    kinds: KINDS,
    setup: "the executor returns a launch-audit refusal",
    bar: [4],
    expect: (k) => single(k, row("refused", ["LAUNCH_AUDIT_REFUSED"]), 1, 1),
  },
  {
    scenario: "ledger-write-fails",
    kinds: KINDS,
    setup: "the ledger file becomes unwritable after admission",
    bar: [1, 4],
    outOfScopeReason:
      "storage failure after the run: no chained row can be written, so bar item 1's row cannot hold; the run is reported error/LEDGER_FAILED and notified, never verified",
    expect: (k) => ({
      executorCalls: 1,
      ledgerRows: [],
      unwrittenRows: [row("error", ["LEDGER_FAILED"])],
      responses: k === "webhook" ? [ACCEPTED] : [],
      notifications: 1,
    }),
  },
  {
    scenario: "source-not-enabled",
    kinds: ["manual", "webhook"],
    setup: "the schedule does not enable this source; one trigger",
    bar: [4],
    expect: (k) => ({
      executorCalls: 0,
      ledgerRows: [row("skipped", ["SOURCE_NOT_ENABLED"])],
      responses: k === "webhook" ? [r(403, "SOURCE_NOT_ENABLED")] : [],
      notifications: 1,
    }),
  },
  {
    scenario: "payload-marker",
    kinds: ["inbox", "webhook"],
    setup:
      "the inbox file's contents (or the webhook body) carry a planted marker; the run must never see it",
    bar: [1, 5],
    expect: (k) => single(k, VERIFIED, 1, 0),
  },
  {
    scenario: "bad-signature",
    kinds: ["webhook"],
    setup: "a delivery signed with the wrong secret",
    bar: [4],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [],
      responses: [r(401, "BAD_SIGNATURE")],
      notifications: 0,
    }),
  },
  {
    scenario: "missing-signature",
    kinds: ["webhook"],
    setup: "a delivery with no x-myco-signature header",
    bar: [4],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [],
      responses: [r(401, "BAD_SIGNATURE")],
      notifications: 0,
    }),
  },
  {
    scenario: "signature-replayed-new-delivery",
    kinds: ["webhook"],
    setup: "a valid delivery, then its signature replayed under a new delivery id",
    bar: [3, 4],
    expect: () => ({
      executorCalls: 1,
      ledgerRows: [VERIFIED],
      responses: [ACCEPTED, r(401, "BAD_SIGNATURE")],
      notifications: 0,
    }),
  },
  {
    scenario: "signature-wrong-schedule",
    kinds: ["webhook"],
    setup: "a signature computed for schedule A sent to schedule B",
    bar: [4],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [],
      responses: [r(401, "BAD_SIGNATURE")],
      notifications: 0,
    }),
  },
  {
    scenario: "secret-unreadable",
    kinds: ["webhook"],
    setup: "the webhook secrets file is removed after start",
    bar: [4, 5],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [],
      responses: [r(503, "SECRET_UNAVAILABLE")],
      notifications: 0,
    }),
  },
  {
    scenario: "non-loopback-bind",
    kinds: ["webhook"],
    setup: "the webhook server is asked to bind 0.0.0.0",
    bar: [4],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [],
      notifications: 0,
      startupRefusal: "NON_LOOPBACK",
    }),
  },
  {
    scenario: "symlink-entry",
    kinds: ["inbox"],
    setup: "the inbox holds only a symlink to a file outside it",
    bar: [4],
    expect: () => ({ executorCalls: 0, ledgerRows: [], notifications: 0 }),
  },
  {
    scenario: "dotfile-entry",
    kinds: ["inbox"],
    setup: "the inbox holds only a dotfile",
    bar: [4],
    expect: () => ({ executorCalls: 0, ledgerRows: [], notifications: 0 }),
  },
  {
    scenario: "missed-skip",
    kinds: ["cron"],
    setup: 'missed "skip"; the service is down across 3 slots; one tick after',
    bar: [3],
    expect: () => ({
      executorCalls: 0,
      ledgerRows: [row("skipped", ["MISSED"])],
      notifications: 1,
    }),
  },
  {
    scenario: "missed-run-latest",
    kinds: ["cron"],
    setup: 'missed "run-latest"; the service is down across 3 slots; one tick after',
    bar: [3],
    expect: () => ({
      executorCalls: 1,
      ledgerRows: [VERIFIED, row("skipped", ["MISSED"])],
      notifications: 1,
    }),
  },
  ...(
    [
      ["zero-policies", "the scheduler is started with no policies", "NO_POLICY", [2]],
      ["unknown-config-key", "the schedule file has an unknown key", "CONFIG_INVALID", [4]],
      [
        "secret-in-config",
        "a schedule file string holds a key-shaped planted marker",
        "CONFIG_INVALID",
        [4, 5],
      ],
      ["corrupt-claims", "claims.jsonl has a line that does not parse", "CLAIMS_CORRUPT", [3, 4]],
      ["corrupt-cursor", "cursor.json is malformed", "CURSOR_CORRUPT", [3, 4]],
      ["state-dir-locked", "a second service starts on a locked state dir", "LOCK_HELD", [3]],
    ] as const
  ).map(
    ([scenario, setup, refusal, bar]): Scenario => ({
      scenario,
      kinds: ["service"],
      setup,
      bar,
      expect: () => ({
        executorCalls: 0,
        ledgerRows: [],
        notifications: 0,
        startupRefusal: refusal,
      }),
    }),
  ),
];

/** Cases a later corpus version adds; recorded so their absence here is stated, not hidden. */
export const TRG_V1_DEFERRED: readonly { readonly scenario: string; readonly reason: string }[] = [
  {
    scenario: "vm-lock-held",
    reason:
      "S-live (the live VM executor's VM-lock and critical-path check) is not built (TO FILE on #536); the case enters the corpus version that ships S-live",
  },
];

/** Build trg-v1. Deterministic: scenario order, then kind order. */
export function buildTrgV1(): TrgCase[] {
  const out: TrgCase[] = [];
  for (const s of SCENARIOS) {
    for (const kind of s.kinds) {
      const p = s.expect(kind);
      out.push({
        schema: TRG_CASE_SCHEMA,
        id: `${TRG_VERSION}-${kind}-${s.scenario}`,
        kind,
        scenario: s.scenario,
        setup: s.setup,
        bar: s.bar,
        inScope: s.outOfScopeReason === undefined,
        outOfScopeReason: s.outOfScopeReason ?? null,
        expected: {
          startup: p.startupRefusal ? "refused" : "ok",
          startupRefusal: p.startupRefusal ?? null,
          executorCalls: p.executorCalls,
          ledgerRows: p.ledgerRows,
          unwrittenRows: p.unwrittenRows ?? [],
          responses: p.responses ?? [],
          notifications: p.notifications,
        },
      });
    }
  }
  return out;
}

/** The committed cases file: one canonical JSON case per line. */
export function casesJsonl(cases: readonly TrgCase[]): string {
  return cases.map((c) => `${canonicalJson(c)}\n`).join("");
}

export interface TrgManifest {
  readonly schema: typeof TRG_MANIFEST_SCHEMA;
  readonly corpusVersion: typeof TRG_VERSION;
  readonly counts: {
    readonly total: number;
    readonly inScope: number;
    readonly outOfScope: number;
    readonly perKind: Readonly<Record<CaseKind, number>>;
  };
  readonly deferred: typeof TRG_V1_DEFERRED;
  readonly files: { readonly "cases.jsonl": string };
}

export function buildTrgManifest(cases: readonly TrgCase[]): TrgManifest {
  const perKind: Record<CaseKind, number> = {
    cron: 0,
    inbox: 0,
    manual: 0,
    webhook: 0,
    service: 0,
  };
  for (const c of cases) perKind[c.kind] += 1;
  const inScope = cases.filter((c) => c.inScope).length;
  return {
    schema: TRG_MANIFEST_SCHEMA,
    corpusVersion: TRG_VERSION,
    counts: { total: cases.length, inScope, outOfScope: cases.length - inScope, perKind },
    deferred: TRG_V1_DEFERRED,
    files: { "cases.jsonl": sha256Hex(casesJsonl(cases)) },
  };
}

/** The manifest SHA-256 the pre-registration records: over the manifest's canonical JSON. */
export function manifestSha256(manifest: TrgManifest): string {
  return sha256Hex(canonicalJson(manifest));
}
