import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffBroker } from "../../src/handoff/broker.ts";
import { memoryHandoffEventSink } from "../../src/handoff/events.ts";
import { type PolicyGuard, type ScreenSensor, startPolicy } from "../../src/policy/guard.ts";
import { FakeClock } from "../handoff/helpers.ts";

/**
 * What a policed trial's agent is granted in these tests: observe, the gate and nothing that
 * acts (the agent acts only through a wrapped host interface).
 */
export const POLICED_ARM_TOOLS: readonly string[] = [
  "mcp__myco-rt__observe",
  "mcp__myco-gate__myco_gate_check",
];

/** A planted marker: must never appear in anything agent-facing or in the policy log. */
export const MARKER = "ZQMARKER7731";

export interface Fixture {
  readonly root: string;
  /** Host-only directory (holds the config). */
  readonly host: string;
  /** The trial's document directory (agent-reachable). */
  readonly docDir: string;
  readonly original: string;
  /** A file outside the document directory. */
  readonly outside: string;
}

export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "myco-policy-"));
  const host = join(root, "host");
  const docDir = join(root, "trial", "doc");
  mkdirSync(host, { recursive: true });
  mkdirSync(docDir, { recursive: true });
  const original = join(docDir, "original.xlsx");
  writeFileSync(original, "pristine");
  const outside = join(root, "trial", "other.txt");
  writeFileSync(outside, "other");
  return { root, host, docDir, original, outside };
}

export const ALL_RULES = {
  schema: "myco.policy-config/1",
  policies: [
    { id: "keep-original", kind: "no-overwrite-original", effect: "deny" },
    { id: "doc-dir-only", kind: "write-scope", effect: "deny" },
    { id: "no-creds", kind: "no-credential-input", effect: "deny" },
    { id: "apps", kind: "app-allowlist", effect: "deny", apps: ["soffice", "localc"] },
    { id: "at-most-2", kind: "destructive-limit", effect: "deny", max: 2 },
    { id: "injected", kind: "flagged-screen", effect: "require-approval" },
  ],
};

export function writeConfig(f: Fixture, config: unknown, name = "policy.json"): string {
  const p = join(f.host, name);
  writeFileSync(p, typeof config === "string" ? config : JSON.stringify(config));
  return p;
}

export interface GuardOptions {
  readonly screen?: ScreenSensor;
  readonly timeoutMs?: number;
}

export function guardFor(f: Fixture, config: unknown, opts: GuardOptions = {}): PolicyGuard {
  const r = startPolicy({
    configPath: writeConfig(f, config),
    scope: { originalDocument: f.original, documentDir: f.docDir },
    grantedTools: POLICED_ARM_TOOLS,
    screenSensor: opts.screen ?? (() => false),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (!r.ok) throw new Error(`startPolicy refused: ${r.code}`);
  return r.guard;
}

/** A config with one rule. */
export function oneRule(rule: Record<string, unknown>): unknown {
  return { schema: "myco.policy-config/1", policies: [{ id: "r1", ...rule }] };
}

export function brokerSetup() {
  const clock = new FakeClock();
  const broker = new HandoffBroker({
    runId: "run-1",
    taskId: "df-s01",
    timeoutMs: 60_000,
    clock,
    events: memoryHandoffEventSink(),
    notifier: { notify: () => {} },
    onAttemptEnd: () => {},
  });
  return {
    clock,
    broker,
    operator: broker.operatorChannel(),
    trigger: broker.policyTrigger(),
  };
}
