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

  // Round-2 verifier N1: every kind, desktop and adapter, drops undeclared fields.
  it.each([
    [
      { kind: "typeTextGlobal", text: "t", command: CP },
      { kind: "typeTextGlobal", text: "t" },
    ],
    [
      { kind: "clickAt", x: 1, y: 2, command: CP },
      { kind: "clickAt", x: 1, y: 2 },
    ],
    [
      { kind: "launch", command: SOFFICE, args: ["--calc"], env: { X: "1" } },
      { kind: "launch", command: SOFFICE, args: ["--calc"] },
    ],
    [
      { kind: "keyPress", keys: "ctrl+c", command: CP },
      { kind: "keyPress", keys: "ctrl+c" },
    ],
  ])("desktop copy of %o keeps only its declared fields", (raw, want) => {
    const got = frozenDesktopAction(raw);
    expect(got).toEqual(want);
    expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(want).sort());
  });

  it.each([
    [
      { kind: "click", ref: "r", extra: 1 },
      { kind: "click", ref: "r" },
    ],
    [
      { kind: "typeText", ref: "r", text: "t", extra: 1 },
      { kind: "typeText", ref: "r", text: "t" },
    ],
    [
      { kind: "setValue", ref: "r", value: "v", extra: 1 },
      { kind: "setValue", ref: "r", value: "v" },
    ],
    [
      { kind: "keyPress", keys: "k", extra: 1 },
      { kind: "keyPress", keys: "k" },
    ],
  ])("adapter copy of %o keeps only its declared fields", (raw, want) => {
    const got = frozenAdapterAction(raw);
    expect(got).toEqual(want);
    expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(want).sort());
  });

  it("adapter waitFor copy keeps only its declared fields", () => {
    const predicate = () => true;
    const got = frozenAdapterAction({ kind: "waitFor", predicate, timeoutMs: 5, extra: 1 });
    expect(Object.keys(got ?? {}).sort()).toEqual(["kind", "predicate", "timeoutMs"]);
  });

  // Round-2 verifier B1: the api and gui routes carry no argv, and they write.
  it("router, no argv (api/gui route): returned writes are the frozen judged copy", () => {
    const f = fixture();
    const writes = [join(f.docDir, "out.csv")];
    const reads = [f.original];
    const inner: ActionPolicy = {
      id: "i",
      check: (): PolicyDecision => ({ allow: true, code: "ALLOWED", reads, writes }),
    };
    const d = guardedActionPolicy(inner, guardFor(f, FILE_RULES)).check({
      route: "api",
      kind: "x",
      reads: [],
      writes: [],
    });
    writes[0] = f.original;
    reads.push(f.outside);
    expect(d).toEqual({
      allow: true,
      code: "ALLOWED",
      reads: [f.original],
      writes: [join(f.docDir, "out.csv")],
    });
    expect(Object.isFrozen(d)).toBe(true);
    if (d.allow) {
      expect(d.writes).not.toBe(writes);
      expect(d.reads).not.toBe(reads);
      expect(Object.isFrozen(d.writes)).toBe(true);
      expect(Object.isFrozen(d.reads)).toBe(true);
    }
  });

  it.each(["api", "gui", "script"] as const)(
    "router (%s): a writes getter that answers differently on a second read never returns unjudged writes",
    (route) => {
      const f = fixture();
      let n = 0;
      const decision = {
        allow: true,
        code: "ALLOWED",
        reads: [],
        get writes() {
          n += 1;
          return n === 1 ? [join(f.docDir, "out.csv")] : [f.original];
        },
      };
      const d = guardedActionPolicy(
        { id: "i", check: () => decision as unknown as PolicyDecision },
        guardFor(f, FILE_RULES),
      ).check({ route, kind: "x", reads: [], writes: [] });
      expect(d.allow && d.writes).toEqual([join(f.docDir, "out.csv")]);
      expect(n).toBe(1);
    },
  );

  it("router: a reads or argv getter is read once too", () => {
    const f = fixture();
    let nr = 0;
    let na = 0;
    const decision = {
      allow: true,
      code: "ALLOWED",
      writes: [join(f.docDir, "out.csv")],
      get reads() {
        nr += 1;
        return nr === 1 ? [f.original] : [f.outside];
      },
      get argv() {
        na += 1;
        return na === 1 ? ["cat", "x"] : ["cp", f.outside, f.original];
      },
    };
    const d = guardedActionPolicy(
      { id: "i", check: () => decision as unknown as PolicyDecision },
      guardFor(f, FILE_RULES),
    ).check({ route: "script", kind: "x", reads: [], writes: [] });
    expect(d).toEqual({
      allow: true,
      code: "ALLOWED",
      reads: [f.original],
      writes: [join(f.docDir, "out.csv")],
      argv: ["cat", "x"],
    });
    expect(nr).toBe(1);
    expect(na).toBe(1);
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

/** Turn the caller's object into `target` in place: every own key removed, then target's set. */
function retarget(action: Record<string, unknown>, target: Record<string, unknown>): void {
  for (const k of Object.keys(action)) delete action[k];
  Object.assign(action, target);
}

/** A caller-owned clone of `a`: its own object, and its own ref or args (functions kept). */
function callerCopy(a: Record<string, unknown>): Record<string, unknown> {
  const c: Record<string, unknown> = { ...a };
  if (typeof a.ref === "object" && a.ref !== null) c.ref = { ...(a.ref as object) };
  if (Array.isArray(a.args)) c.args = [...a.args];
  return c;
}

describe("every action kind runs as judged when changed during the approval (#605 item 2)", () => {
  const DESKTOP_KINDS: Record<string, unknown>[] = [
    { kind: "launch", command: SOFFICE, args: ["--calc"] },
    { kind: "typeTextGlobal", text: "hello" },
    { kind: "clickAt", x: 10, y: 20 },
    { kind: "keyPress", keys: "ctrl+c" },
  ];

  it.each(DESKTOP_KINDS.map((a) => [a.kind, a] as const))(
    "desktop %s changed to a launch of cp: the judged copy runs, frozen, and the original stays",
    async (_kind, judged) => {
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
      const action = callerCopy(judged);
      const held = p.act("s1", action as unknown as GuardedDesktopAction);
      await flush();
      // The caller turns the held action into `cp <outside> <original>` while a human decides.
      retarget(action, { kind: "launch", command: CP, args: [f.outside, f.original] });
      await approvePending(s);
      expect(await held).toBe("delivered_unverified");
      expect(calls).toEqual([judged]);
      expect(calls[0]).not.toBe(action);
      expect(Object.isFrozen(calls[0])).toBe(true);
      expect(readFileSync(f.original, "utf8")).toBe("pristine");
      expect(g.log().map((e) => e.code)).toEqual(["POLICY_FLAGGED_SCREEN"]);
    },
  );

  const predicate = () => true;
  const ADAPTER_KINDS: Record<string, unknown>[] = [
    { kind: "click", ref: { nodeId: "cell-A1" } },
    { kind: "typeText", ref: { nodeId: "cell-A1" }, text: "hello" },
    { kind: "setValue", ref: { nodeId: "cell-A1" }, value: "42" },
    { kind: "keyPress", keys: "ctrl+c" },
    { kind: "waitFor", predicate, timeoutMs: 5 },
  ];

  it.each(ADAPTER_KINDS.map((a) => [a.kind, a] as const))(
    "adapter %s changed to a setValue on a password field: the judged copy runs, frozen",
    async (_kind, judged) => {
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
      const action = callerCopy(judged);
      const callerRef = action.ref;
      const held = p.act(action as unknown as ProgramAction);
      await flush();
      // The caller changes both the held action and its ref object while a human decides.
      if (typeof callerRef === "object" && callerRef !== null)
        (callerRef as { nodeId: string }).nodeId = "password-field";
      retarget(action, {
        kind: "setValue",
        ref: { nodeId: "password-field" },
        value: "overwritten",
      });
      await approvePending(s);
      expect((await held).outcome).toBe("delivered_unverified");
      expect(calls).toEqual([judged]);
      expect(calls[0]).not.toBe(action);
      expect(Object.isFrozen(calls[0])).toBe(true);
      const sent = calls[0] as { ref?: unknown };
      if (judged.ref !== undefined) expect(Object.isFrozen(sent.ref)).toBe(true);
      if (judged.kind === "typeText" || judged.kind === "setValue") {
        // The very ref object the classifier judged is the one forwarded. (A click's target is
        // not classified yet: #605 item 6.)
        expect(judgedRefs).toHaveLength(1);
        expect(sent.ref).toBe(judgedRefs[0]);
      }
      expect(g.log().map((e) => e.code)).toEqual(["POLICY_FLAGGED_SCREEN"]);
    },
  );
});

describe("round-2 hardening (#629 N1-N3)", () => {
  it("N1: the 64-arg cap is checked on the copy, not on a length that can change", () => {
    let lengthReads = 0;
    const shifty = new Proxy(["a"], {
      get(target, key, receiver) {
        if (key === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 100;
        }
        if (typeof key === "string" && /^\d+$/.test(key)) return "a";
        return Reflect.get(target, key, receiver);
      },
    });
    expect(Array.isArray(shifty)).toBe(true);
    expect(frozenDesktopAction({ kind: "launch", command: "/x", args: shifty })).toBeNull();
    // 64 is still accepted; the cap is "more than 64".
    expect(
      frozenDesktopAction({ kind: "launch", command: "/x", args: Array(64).fill("a") }),
    ).not.toBeNull();
  });

  it("N2: a malformed allowing decision from J is a refusal code, never a throw", () => {
    const f = fixture();
    const throwing = {
      allow: true,
      code: "ALLOWED",
      reads: [],
      get writes(): string[] {
        throw new Error("boom");
      },
    };
    const malformed: unknown[] = [
      { allow: true, code: "ALLOWED", reads: [], writes: "out.csv" },
      { allow: true, code: "ALLOWED", reads: [], writes: [1] },
      { allow: true, code: "ALLOWED", reads: "x", writes: [] },
      { allow: true, code: "ALLOWED", reads: [], writes: [], argv: "cat x" },
      { allow: true, code: "ALLOWED", reads: [], writes: [], argv: ["cat", 1] },
      { allow: true, code: "ALLOWED" },
      throwing,
    ];
    for (const [k, decision] of malformed.entries()) {
      const g = guardFor(f, FILE_RULES);
      const inner: ActionPolicy = { id: "inner", check: () => decision as PolicyDecision };
      const policy = guardedActionPolicy(inner, g);
      let d: PolicyDecision | undefined;
      expect(() => {
        d = policy.check({ route: "script", kind: "x", reads: [], writes: [] });
      }, `case ${k}`).not.toThrow();
      expect(d, `case ${k}`).toEqual({ allow: false, code: "POLICY_DENIED" });
      expect(
        g.log().map((e) => e.code),
        `case ${k}`,
      ).toEqual(["POLICY_ACTION_UNRECOGNISED"]);
    }
  });

  it("N3: the waitFor copy requires a number timeout", () => {
    const predicate = () => true;
    for (const timeoutMs of ["5", undefined, null, {}])
      expect(frozenAdapterAction({ kind: "waitFor", predicate, timeoutMs })).toBeNull();
    expect(frozenAdapterAction({ kind: "waitFor", predicate: "p", timeoutMs: 5 })).toBeNull();
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
