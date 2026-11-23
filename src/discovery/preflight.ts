/**
 * Direction A live preflight (MVD-001).
 *
 * A pure checker over a probe result. It decides whether a live run may start and
 * names every reason it may not. It never starts a VM, never retries, and never
 * treats a missing check as a pass: an unreadable probe is an abort.
 *
 * The probe is injected so the checker is testable offline. The live probe (guest
 * up, app deployed, store/oracle reachable) is the caller's job; this module only
 * enforces the gate.
 */

/** What production callers must collect; the Go/lock fields are decided by people/infra. */
export type ProbeEvidence = Omit<PreflightProbe, "coordinatorGo" | "hostLock">;

export interface PreflightProbe {
  /** The Coordinator's explicit GO for this host window. */
  readonly coordinatorGo: boolean;
  /** The shared host lock is held by this run. */
  readonly hostLock: boolean;
  /** The runtime answers on its control channel. */
  readonly runtimeReachable: boolean;
  /** The guest's GUI session is up and the agent is in it. */
  readonly guestReady: boolean;
  /** The app under test exists at the expected guest path. */
  readonly appPresent: boolean;
  /** The persisted store is readable host-side (the oracle's input). */
  readonly storeReadable: boolean;
  /** The Foundry oracle for this task is present. */
  readonly oraclePresent: boolean;
  /** No stray app processes or leftover run directories from a previous trial. */
  readonly guestClean: boolean;
}

export interface PreflightCheck {
  readonly name: keyof PreflightProbe;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
  readonly abort: readonly string[];
}

const REQUIRED: readonly (keyof PreflightProbe)[] = [
  "coordinatorGo",
  "hostLock",
  "runtimeReachable",
  "guestReady",
  "appPresent",
  "storeReadable",
  "oraclePresent",
  "guestClean",
];

const DETAIL: Record<keyof PreflightProbe, string> = {
  coordinatorGo: "Coordinator GO for this host window",
  hostLock: "shared host lock held by this run",
  runtimeReachable: "runtime control channel answers",
  guestReady: "guest GUI session and agent are up",
  appPresent: "app under test is deployed at the expected path",
  storeReadable: "persisted store is readable host-side",
  oraclePresent: "Foundry oracle for this task is present",
  guestClean: "no stray app processes or leftover run directories",
};

/**
 * The gate a host-side launcher must pass before it collects evidence: without
 * a named Coordinator GO and the shared host lock, no probe is gathered at all.
 * Otherwise a caller could satisfy every field it controls and boot a guest.
 */
export function checkGate(gate: {
  readonly coordinatorGo: boolean;
  readonly hostLock: boolean;
}): PreflightResult {
  const checks: PreflightCheck[] = (["coordinatorGo", "hostLock"] as const).map((name) => ({
    name,
    ok: gate[name] === true,
    detail: DETAIL[name],
  }));
  const abort = checks.filter((check) => !check.ok).map((check) => check.detail);
  return { ok: abort.length === 0, checks, abort };
}

/** The full gate: the human/infra authorisation, then the host-side evidence. */
export function combinedPreflight(
  gate: { readonly coordinatorGo: boolean; readonly hostLock: boolean },
  evidence: ProbeEvidence | null,
): PreflightResult {
  return runPreflight({ ...evidence, ...gate });
}

export function runPreflight(probe: Partial<PreflightProbe> | null | undefined): PreflightResult {
  const checks: PreflightCheck[] = [];
  const abort: string[] = [];
  for (const name of REQUIRED) {
    const value = probe?.[name];
    const ok = value === true;
    checks.push({ name, ok, detail: DETAIL[name] });
    if (!ok) abort.push(DETAIL[name]);
  }
  return { ok: abort.length === 0, checks, abort };
}

export function renderPreflight(result: PreflightResult): string {
  const lines: string[] = [];
  lines.push(result.ok ? "PREFLIGHT: PASS" : "PREFLIGHT: ABORT");
  for (const check of result.checks) {
    lines.push(`${check.ok ? "ok  " : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  if (!result.ok) {
    lines.push("");
    lines.push("Abort reasons:");
    for (const reason of result.abort) lines.push(`- ${reason}`);
  }
  return `${lines.join("\n")}\n`;
}
