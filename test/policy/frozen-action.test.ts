/**
 * Track O, #605 items 2 and 4.
 *
 * Item 2: what runs is what was judged. Each async wrapper copies the action once, when it is
 * called, judges the copy and forwards the copy. The cases below reproduce the round-3 verifier's
 * probe (a held `launch <soffice> --calc` turned into `cp <outside> <original>` while the
 * approval was pending) with a transport that really runs the launch: if a wrapper forwards the
 * caller's object again, the original document is overwritten and the case fails.
 *
 * Item 4: `policedDesktopTransport` returns exactly the six interface methods, never the inner
 * transport's own fields.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionPolicy, PolicyDecision } from "../../src/actions/policy.ts";
import type { ActResult, AppAdapter, ProgramAction, TargetRef } from "../../src/core/adapter.ts";
import {
  frozenAdapterAction,
  frozenDesktopAction,
  type GuardedDesktopAction,
  type GuardedDesktopTransport,
  guardedActionPolicy,
  type LaunchTable,
  NO_APPROVALS,
  policedAppAdapter,
  policedDesktopTransport,
} from "../../src/policy/actuators.ts";
import { flush } from "../handoff/helpers.ts";
import { brokerSetup, type Fixture, fixture, guardFor } from "./helpers.ts";

const BIN = realpathSync(mkdtempSync(join(tmpdir(), "myco-policy-frozen-bin-")));
const SOFFICE = join(BIN, "soffice");
writeFileSync(SOFFICE, "#!/bin/sh\nexit 0\n");
chmodSync(SOFFICE, 0o755);
const CP = realpathSync("/bin/cp");
const LAUNCHES: LaunchTable = { [SOFFICE]: { app: "soffice", argv: [["--calc"]] } };

/** File rules, plus a flagged screen that holds every action for a human's approval. */
const HELD_RULES = {
  schema: "myco.policy-config/1",
  policies: [
    { id: "keep-original", kind: "no-overwrite-original", effect: "deny" },
    { id: "doc-dir-only", kind: "write-scope", effect: "deny" },
    { id: "apps", kind: "app-allowlist", effect: "deny", apps: ["soffice"] },
    { id: "injected", kind: "flagged-screen", effect: "require-approval" },
  ],
};
const FILE_RULES = { ...HELD_RULES, policies: HELD_RULES.policies.slice(0, 3) };

/** A transport that really runs a launch on the host, so a forwarded cp really overwrites. */
function spawningDesktop() {
  const calls: GuardedDesktopAction[] = [];
  const t: GuardedDesktopTransport<string> = {
    create: async () => "s1",
    observe: async () => ({}),
    act: async (_s, a) => {
      calls.push(a);
      if (a.kind === "launch") {
        const r = spawnSync(a.command, [...a.args], { stdio: "ignore", timeout: 10_000 });
        return r.status === 0 ? "delivered_unverified" : "failed";
      }
      return "delivered_unverified";
    },
    readFile: async () => "",
    reset: async () => {},
    destroy: async () => {},
  };
  return { t, calls };
}

function fakeAdapter() {
  const calls: ProgramAction[] = [];
  const adapter: AppAdapter = {
    observe: async () => ({}) as never,
    capabilities: () => ({ ids: [] }),
    act: async (a: ProgramAction): Promise<ActResult> => {
      calls.push(a);
      return { outcome: "delivered_unverified", details: "ok", stateVersionAfter: 1 };
    },
  };
  return { adapter, calls };
}

async function approvePending(s: ReturnType<typeof brokerSetup>): Promise<void> {
  await flush();
  await flush();
  const pending = s.operator.pending();
  expect(pending).toHaveLength(1);
  s.operator.resolve({
    handoffId: pending[0]?.handoffId as string,
    outcome: "approve",
    via: "cli",
  });
}

function tampered(f: Fixture): void {
  writeFileSync(f.outside, "TAMPERED");
}

describe("what runs is what was judged (#605 item 2)", () => {
  it("verdict probe: a held soffice launch changed to cp during the approval runs as judged", async () => {
    const f = fixture();
    tampered(f);
    const s = brokerSetup();
    const g = guardFor(f, HELD_RULES, { screen: () => true });
    const { t, calls } = spawningDesktop();
    const p = policedDesktopTransport(t, g, {
      trigger: s.trigger,
      focusIsCredential: () => false,
      launches: LAUNCHES,
    });
    const action = { kind: "launch", command: SOFFICE, args: ["--calc"] };
    const held = p.act("s1", action as GuardedDesktopAction);
    await flush();
    // The caller changes the object while a human is deciding.
    action.command = CP;
    action.args = [f.outside, f.original];
    await approvePending(s);
    expect(await held).toBe("delivered_unverified");
    expect(calls).toEqual([{ kind: "launch", command: SOFFICE, args: ["--calc"] }]);
    expect(calls[0]).not.toBe(action);
    expect(readFileSync(f.original, "utf8")).toBe("pristine");
    expect(g.log().map((e) => e.code)).toEqual(["POLICY_FLAGGED_SCREEN"]);
  });

  it("the args array is copied too: pushing onto it during the approval changes nothing", async () => {
    const f = fixture();
    tampered(f);
    const s = brokerSetup();
    const g = guardFor(f, HELD_RULES, { screen: () => true });
    const { t, calls } = spawningDesktop();
    const p = policedDesktopTransport(t, g, {
      trigger: s.trigger,
      focusIsCredential: () => false,
      launches: { ...LAUNCHES, [CP]: { app: "soffice" } },
    });
    const args: string[] = [];
    const held = p.act("s1", { kind: "launch", command: CP, args });
    await flush();
    args.push(f.outside, f.original);
    await approvePending(s);
    // cp with no operands fails on its own; what matters is that it ran with none.
    await held;
    expect(calls).toEqual([{ kind: "launch", command: CP, args: [] }]);
    expect(readFileSync(f.original, "utf8")).toBe("pristine");
  });

  it("the forwarded desktop action is deeply frozen", async () => {
    const f = fixture();
    const { t, calls } = spawningDesktop();
    const p = policedDesktopTransport(t, guardFor(f, FILE_RULES), {
      trigger: NO_APPROVALS,
      focusIsCredential: () => false,
      launches: LAUNCHES,
    });
    expect(await p.act("s1", { kind: "launch", command: SOFFICE, args: ["--calc"] })).toBe(
      "delivered_unverified",
    );
    const sent = calls[0] as Extract<GuardedDesktopAction, { kind: "launch" }>;
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent.args)).toBe(true);
  });

  it("getters are read once: a field that answers differently on a second read cannot run", async () => {
    const f = fixture();
    tampered(f);
    const { t, calls } = spawningDesktop();
    const g = guardFor(f, FILE_RULES);
    const p = policedDesktopTransport(t, g, {
      trigger: NO_APPROVALS,
      focusIsCredential: () => false,
      launches: LAUNCHES,
    });
    let commandReads = 0;
    let argsReads = 0;
    const action = {
      kind: "launch",
      get command() {
        commandReads += 1;
        return commandReads === 1 ? SOFFICE : CP;
      },
      get args() {
        argsReads += 1;
        return argsReads === 1 ? ["--calc"] : [f.outside, f.original];
      },
    };
    expect(await p.act("s1", action as unknown as GuardedDesktopAction)).toBe(
      "delivered_unverified",
    );
    expect(commandReads).toBe(1);
    expect(argsReads).toBe(1);
    expect(calls).toEqual([{ kind: "launch", command: SOFFICE, args: ["--calc"] }]);
    expect(readFileSync(f.original, "utf8")).toBe("pristine");
  });

  it("a copy that cannot be taken is unrecognised and never forwarded", async () => {
    const f = fixture();
    const { t, calls } = spawningDesktop();
    const g = guardFor(f, FILE_RULES);
    const p = policedDesktopTransport(t, g, {
      trigger: NO_APPROVALS,
      focusIsCredential: () => false,
      launches: LAUNCHES,
    });
    const throwing = {
      kind: "launch",
      get command(): string {
        throw new Error("boom");
      },
      args: [],
    };
    const bad = [
      throwing,
      { kind: "launch", command: SOFFICE, args: [1] },
      { kind: "launch", command: SOFFICE, args: "--calc" },
      { kind: "clickAt", x: "1", y: 2 },
      { kind: "clickAt", x: Number.NaN, y: 2 },
      { kind: "keyPress", keys: ["ctrl", "c"] },
      { kind: "typeTextGlobal", text: 5 },
      { kind: "other" },
      null,
    ];
    for (const [k, a] of bad.entries())
      expect(await p.act("s1", a as unknown as GuardedDesktopAction), `case ${k}`).toBe("failed");
    expect(calls).toEqual([]);
    expect(new Set(g.log().map((e) => e.code))).toEqual(new Set(["POLICY_ACTION_UNRECOGNISED"]));
  });

  it("app adapter: a held typeText changed to Ctrl+S during the approval forwards the typeText", async () => {
    const f = fixture();
    const s = brokerSetup();
    const g = guardFor(f, HELD_RULES, { screen: () => true });
    const { adapter, calls } = fakeAdapter();
    const judgedRefs: TargetRef[] = [];
    const p = policedAppAdapter(adapter, g, {
      trigger: s.trigger,
      isCredentialTarget: (ref) => {
        judgedRefs.push(ref);
        return false;
      },
    });
    const ref = { nodeId: "cell-A1" };
    const action: Record<string, unknown> = { kind: "typeText", ref, text: "hello" };
    const held = p.act(action as ProgramAction);
    await flush();
    action.kind = "keyPress";
    action.keys = "ctrl+s";
    ref.nodeId = "password-field";
    await approvePending(s);
    expect((await held).outcome).toBe("delivered_unverified");
    expect(calls).toEqual([{ kind: "typeText", ref: { nodeId: "cell-A1" }, text: "hello" }]);
    // The very ref object the classifier judged is the one forwarded, and it is frozen.
    const sent = calls[0] as Extract<ProgramAction, { kind: "typeText" }>;
    expect(judgedRefs).toHaveLength(1);
    expect(sent.ref).toBe(judgedRefs[0]);
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent.ref)).toBe(true);
  });

  it("the copy keeps only the declared fields of each action kind", () => {
    const predicate = () => true;
    expect(frozenAdapterAction({ kind: "click", ref: "r", extra: 1 })).toEqual({
      kind: "click",
      ref: "r",
    });
    expect(frozenAdapterAction({ kind: "click", ref: { nodeId: "n", extra: 1 } })).toEqual({
      kind: "click",
      ref: { nodeId: "n" },
    });
    expect(frozenAdapterAction({ kind: "setValue", ref: "r", value: "v" })).toEqual({
      kind: "setValue",
      ref: "r",
      value: "v",
    });
    expect(frozenAdapterAction({ kind: "waitFor", predicate, timeoutMs: 5 })).toEqual({
      kind: "waitFor",
      predicate,
      timeoutMs: 5,
    });
    expect(frozenAdapterAction({ kind: "setValue", ref: "r", value: 1 })).toBeNull();
    expect(frozenAdapterAction({ kind: "click", ref: { nodeId: 1 } })).toBeNull();
    expect(frozenDesktopAction({ kind: "keyPress", keys: "ctrl+c", extra: 1 })).toEqual({
      kind: "keyPress",
      keys: "ctrl+c",
    });
    expect(frozenDesktopAction({ kind: "launch", command: "/x", args: Array(65).fill("a") })).toBe(
      null,
    );
  });

  it("router: the decision returned is a frozen copy of the writes O judged", () => {
    const f = fixture();
    const writes = [join(f.docDir, "out.csv")];
    const reads = [f.original];
    const argv = ["cat", "x"];
    const inner: ActionPolicy = {
      id: "inner",
      check: (): PolicyDecision => ({ allow: true, code: "ALLOWED", reads, writes, argv }),
    };
    const policy = guardedActionPolicy(inner, guardFor(f, FILE_RULES));
    const d = policy.check({ route: "script", kind: "x", reads: [], writes: [] });
    // Whoever holds J's arrays changes them after O judged.
    writes[0] = f.original;
    reads.push(f.outside);
    argv.push("--evil");
    expect(d).toEqual({
      allow: true,
      code: "ALLOWED",
      reads: [f.original],
      writes: [join(f.docDir, "out.csv")],
      argv: ["cat", "x"],
    });
    expect(Object.isFrozen(d)).toBe(true);
    if (d.allow) {
      expect(Object.isFrozen(d.writes)).toBe(true);
      expect(Object.isFrozen(d.reads)).toBe(true);
      expect(Object.isFrozen(d.argv)).toBe(true);
    }
  });
});

describe("policedDesktopTransport exposes only the interface (#605 item 4)", () => {
  class ClassTransport implements GuardedDesktopTransport<string> {
    // Stands in for `RuntimeTransport`'s raw MCP client: must not be reachable once policed.
    readonly client = { callTool: () => "raw" };
    initialize(): string {
      return "init";
    }
    async create() {
      return "s1";
    }
    async observe() {
      return {};
    }
    async act() {
      return "delivered_unverified" as const;
    }
    async readFile() {
      return "";
    }
    async reset() {}
    async destroy() {}
  }

  it("returns exactly the six methods, frozen, with no inner field carried over", async () => {
    const f = fixture();
    const p = policedDesktopTransport(new ClassTransport(), guardFor(f, FILE_RULES), {
      trigger: NO_APPROVALS,
      focusIsCredential: () => false,
      launches: LAUNCHES,
    });
    expect(Object.keys(p).sort()).toEqual(
      ["act", "create", "destroy", "observe", "readFile", "reset"].sort(),
    );
    expect("client" in p).toBe(false);
    expect(Object.isFrozen(p)).toBe(true);
    // The pass-through methods still reach the class's prototype methods.
    expect(await p.create()).toBe("s1");
    expect(await p.act("s1", { kind: "clickAt", x: 1, y: 2 })).toBe("delivered_unverified");
  });
});
