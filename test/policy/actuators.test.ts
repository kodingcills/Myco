/**
 * Track O guardrail: every actuator path is guarded.
 *
 * 1. Enumeration: the actuator entry points are pinned against their declarations in `src/`,
 *    `ACTUATOR_WRAPPERS` covers every one, and any file in `src/` that declares an `act`,
 *    `calcSet` or `writerAppend` method is either an entry point, an implementation of one, or
 *    a reviewed non-actuator (with its reason). A new actuator interface fails here until it
 *    has a wrapper.
 * 2. Each wrapper calls the guard BEFORE forwarding: with a policy that refuses, the inner
 *    actuator is never called and the refusal is a closed code; with a policy that allows, the
 *    call is forwarded once. Removing the guard call from any one wrapper fails its case.
 * 3. require-approval opens a track N handoff on the async paths (approve forwards, reject does
 *    not) and is a refusal (`POLICY_APPROVAL_REQUIRED`) on the sync paths.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type ActionPolicy, workspacePolicy } from "../../src/actions/policy.ts";
import type { ActResult, AppAdapter, ProgramAction } from "../../src/core/adapter.ts";
import type { DesktopTransport } from "../../src/discovery/live-runner.ts";
import type { CrossAppActuator } from "../../src/gate/cross-app-demo.ts";
import type { Actuator } from "../../src/linux/actuator.ts";
import {
  ACTUATOR_WRAPPERS,
  freezeLaunchTable,
  type GuardedCrossAppActuator,
  type GuardedDesktopAction,
  type GuardedDesktopTransport,
  type GuardedLinuxActuator,
  guardedActionPolicy,
  type LaunchTable,
  NO_APPROVALS,
  PolicyRefusal,
  policedAppAdapter,
  policedCrossAppActuator,
  policedDesktopTransport,
  policedLinuxActuator,
} from "../../src/policy/actuators.ts";
import { ACTUATOR_IDS } from "../../src/policy/codes.ts";
import { allStrings, flush } from "../handoff/helpers.ts";
import {
  ALL_RULES,
  brokerSetup,
  type Fixture,
  fixture,
  guardFor,
  MARKER,
  oneRule,
} from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");

// ---------------------------------------------------------------------------------------------
// 1. Enumeration.

/** Each entry point and the declaration that defines it. */
const ENTRY_POINTS: Record<string, { file: string; decl: RegExp }> = {
  "app-adapter.act": {
    file: "src/core/adapter.ts",
    decl: /export interface AppAdapter \{[^}]*\n\s+act\(action: ProgramAction\): Promise<ActResult>;/,
  },
  "desktop-transport.act": {
    file: "src/discovery/live-runner.ts",
    decl: /export interface DesktopTransport \{[^}]*\n\s+act\(session: DesktopSession, action: DesktopAction\): Promise<ActionOutcome>;/,
  },
  "linux-actuator.act": {
    file: "src/linux/actuator.ts",
    decl: /export interface Actuator \{\s*act\(docPath: string, cell: string, value: string, save: boolean\): ActuatorReport;\s*\}/,
  },
  "cross-app.calc-set": {
    file: "src/gate/cross-app-demo.ts",
    decl: /export interface CrossAppActuator \{[^}]*calcSet\(sheetPath: string, ref: string, value: string\): void;/,
  },
  "cross-app.writer-append": {
    file: "src/gate/cross-app-demo.ts",
    decl: /export interface CrossAppActuator \{[^}]*writerAppend\(reportPath: string, label: string, text: string\): void;/,
  },
  "action-router.policy": {
    // Every route of track J's router is checked by `ActionPolicy.check` before it runs.
    file: "src/actions/router.ts",
    decl: /const decision = options\.policy\.check\(request\);/,
  },
};

/** Files that implement a guarded entry point (wrapped by that entry point's wrapper). */
const IMPLEMENTATIONS: Record<string, string> = {
  "src/fake/app.ts": "implements AppAdapter",
  "src/win/calc-adapter.ts": "implements AppAdapter",
  "src/faults/arm.ts": "AppAdapter decorator (fault injection) around an AppAdapter",
  "src/faults/security/agent.ts": "AppAdapter decorator (security suite) around an AppAdapter",
  "src/integration/trial.ts": "AppAdapter decorator inside the trial runner",
  "src/discovery/mock-desktop.ts": "implements DesktopTransport",
  "src/discovery/runtime-transport.ts": "implements DesktopTransport",
  "src/linux/cross-app-actuator.ts": "implements CrossAppActuator",
  "src/actions/scripted-agent.ts": "calls ActionRouter.act (every route checked by ActionPolicy)",
  "src/policy/actuators.ts": "the policed wrappers themselves",
};

/** Files with an `act` method that is not an actuator of the agent track O polices. */
const REVIEWED_NON_ACTUATORS: Record<string, string> = {
  "src/baseline/planner.ts": "Planner.act asks a model for a decision; it actuates nothing",
  "src/baseline/hcu-shell/trial.ts": "HcuShellPlanner.act asks a model for a decision",
  "src/foundry/baseline/executor.ts":
    "Foundry baseline-arm harness (TIF-58): external baseline arms, audited by the Foundry scorer; not O's B / B+O agent (follow-up)",
  "src/foundry/baseline/recorder.ts": "records a delivered action; actuates nothing",
  "src/foundry/baseline/todo-transport.ts": "Foundry baseline-arm transport (see executor.ts)",
  "src/foundry/grader/baseline-runner.ts": "Foundry grader's local act() helper over a trace",
};

const MEMBER = /^\s+(?:async\s+)?(?:act|calcSet|writerAppend)\??\s*[(<]/m;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("every actuator path is guarded: enumeration", () => {
  it("the entry points are the closed ACTUATOR_IDS, each with a wrapper", () => {
    expect(Object.keys(ENTRY_POINTS).sort()).toEqual([...ACTUATOR_IDS].sort());
    expect(Object.keys(ACTUATOR_WRAPPERS).sort()).toEqual([...ACTUATOR_IDS].sort());
  });

  it.each(Object.entries(ENTRY_POINTS))("%s is still declared as pinned", (_id, ep) => {
    expect(readFileSync(join(ROOT, ep.file), "utf8")).toMatch(ep.decl);
  });

  it("each wrapper named in ACTUATOR_WRAPPERS is exported", async () => {
    const mod = (await import("../../src/policy/actuators.ts")) as Record<string, unknown>;
    for (const name of Object.values(ACTUATOR_WRAPPERS)) expect(typeof mod[name]).toBe("function");
  });

  it("every file in src/ with an act/calcSet/writerAppend method is classified", () => {
    const known = new Set([
      ...Object.values(ENTRY_POINTS).map((e) => e.file),
      ...Object.keys(IMPLEMENTATIONS),
      ...Object.keys(REVIEWED_NON_ACTUATORS),
    ]);
    const unclassified = tsFiles(SRC)
      .filter((f) => MEMBER.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .filter((f) => !known.has(f));
    expect(unclassified).toEqual([]);
  });

  it("the structural interfaces accept the real ones (type-level)", () => {
    // Compile-time checks (pnpm typecheck covers test/): assigning the real interfaces to the
    // wrappers' structural copies must type-check.
    const linux = (a: Actuator): GuardedLinuxActuator<ReturnType<Actuator["act"]>> => a;
    const cross = (a: CrossAppActuator): GuardedCrossAppActuator => a;
    const desk = <S>(t: DesktopTransport): GuardedDesktopTransport<S> =>
      t as unknown as GuardedDesktopTransport<S>;
    const deskAction = (a: Parameters<DesktopTransport["act"]>[1]): GuardedDesktopAction => a;
    expect([linux, cross, desk, deskAction].every((f) => typeof f === "function")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Each wrapper calls the guard before forwarding.

const DENY_ALL = "{"; // unparseable: the engine denies every action (POLICY_CONFIG_INVALID)
const ALLOW_ALL = oneRule({ kind: "no-credential-input", effect: "deny" });

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

function fakeDesktop() {
  const calls: GuardedDesktopAction[] = [];
  const t: GuardedDesktopTransport<string> = {
    create: async () => "s1",
    observe: async () => ({}),
    act: async (_s, a) => {
      calls.push(a);
      return "delivered_unverified";
    },
    readFile: async () => "",
    reset: async () => {},
    destroy: async () => {},
  };
  return { t, calls };
}

function fakeLinux() {
  const calls: unknown[][] = [];
  const a: GuardedLinuxActuator<{ ok: boolean }> = {
    act: (...args) => {
      calls.push(args);
      return { ok: true };
    },
  };
  return { a, calls };
}

function fakeCross() {
  const calls: string[] = [];
  const a: GuardedCrossAppActuator = {
    name: "fake",
    calcSet: () => void calls.push("calc"),
    writerAppend: () => void calls.push("writer"),
  };
  return { a, calls };
}

function scratchOf(f: Fixture): string {
  const s = join(f.docDir, "scratch");
  mkdirSync(s, { recursive: true });
  return s;
}

const adapterOpts = { trigger: NO_APPROVALS, isCredentialTarget: () => false };

/** A host bin directory with stand-in programs, at its real path. */
const BIN = realpathSync(mkdtempSync(join(tmpdir(), "myco-policy-bin-")));
for (const name of ["soffice", "xterm"]) {
  writeFileSync(join(BIN, name), "#!/bin/sh\nexit 0\n");
  chmodSync(join(BIN, name), 0o755);
}
const SOFFICE = join(BIN, "soffice");
const XTERM = join(BIN, "xterm");
/** The host's launch list for these tests: soffice may also run as `soffice --calc`. */
const LAUNCHES: LaunchTable = {
  [SOFFICE]: { app: "soffice", argv: [["--calc"]] },
  [XTERM]: { app: "xterm" },
};
const desktopOpts = { trigger: NO_APPROVALS, focusIsCredential: () => false, launches: LAUNCHES };

/** Run one call through each wrapper; returns whether the inner actuator was reached. */
const WRAPPER_CASES: Record<
  string,
  (f: Fixture, config: unknown) => Promise<{ reached: boolean; result: unknown }>
> = {
  "app-adapter.act": async (f, config) => {
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, guardFor(f, config), adapterOpts);
    const result = await p.act({ kind: "click", ref: "n1" });
    return { reached: calls.length === 1, result };
  },
  "desktop-transport.act": async (f, config) => {
    const { t, calls } = fakeDesktop();
    const p = policedDesktopTransport(t, guardFor(f, config), desktopOpts);
    const result = await p.act("s1", { kind: "clickAt", x: 1, y: 1 });
    return { reached: calls.length === 1, result };
  },
  "linux-actuator.act": async (f, config) => {
    const { a, calls } = fakeLinux();
    const p = policedLinuxActuator(a, guardFor(f, config));
    const result = p.act(join(f.docDir, "copy.xlsx"), "A1", "1", true);
    return { reached: calls.length === 1, result };
  },
  "cross-app.calc-set": async (f, config) => {
    const { a, calls } = fakeCross();
    const p = policedCrossAppActuator(a, guardFor(f, config));
    let result: unknown = "ok";
    try {
      p.calcSet(join(f.docDir, "sheet.csv"), "A1", "1");
    } catch (e) {
      result = e;
    }
    return { reached: calls.includes("calc"), result };
  },
  "cross-app.writer-append": async (f, config) => {
    const { a, calls } = fakeCross();
    const p = policedCrossAppActuator(a, guardFor(f, config));
    let result: unknown = "ok";
    try {
      p.writerAppend(join(f.docDir, "report.txt"), "Total", "1");
    } catch (e) {
      result = e;
    }
    return { reached: calls.includes("writer"), result };
  },
  "action-router.policy": async (f, config) => {
    // A passthrough inner policy, so the case isolates O's guard.
    let reached = false;
    const passthrough: ActionPolicy = {
      id: "pass",
      check: (r) => {
        reached = true;
        return { allow: true, code: "ALLOWED", reads: [], writes: r.writes };
      },
    };
    const p = guardedActionPolicy(passthrough, guardFor(f, config));
    const result = p.check({
      route: "api",
      kind: "x",
      reads: [],
      writes: [join(f.docDir, "c.csv")],
    });
    // The router runs a route only when check allows: "reached" means allowed through.
    return { reached: reached && (result as { allow: boolean }).allow, result };
  },
};

describe("every actuator path is guarded: the guard runs before forwarding", () => {
  it("covers every entry point", () => {
    expect(Object.keys(WRAPPER_CASES).sort()).toEqual([...ACTUATOR_IDS].sort());
  });

  it.each(Object.keys(WRAPPER_CASES))(
    "%s: a refusing policy never reaches the actuator",
    async (id) => {
      const f = fixture();
      const run = WRAPPER_CASES[id] as (
        f: Fixture,
        c: unknown,
      ) => Promise<{ reached: boolean; result: unknown }>;
      const { reached, result } = await run(f, DENY_ALL);
      expect(reached).toBe(false);
      const text = JSON.stringify(result instanceof Error ? { m: result.message } : result);
      // The desktop transport's outcome has no code channel: a refusal is `failed`.
      if (id === "desktop-transport.act") expect(result).toBe("failed");
      else expect(text).toContain("POLICY_DENIED");
      expect(text).not.toContain(f.root);
    },
  );

  it.each(Object.keys(WRAPPER_CASES))("%s: an allowing policy forwards the call", async (id) => {
    const f = fixture();
    const run = WRAPPER_CASES[id] as (
      f: Fixture,
      c: unknown,
    ) => Promise<{ reached: boolean; result: unknown }>;
    const { reached } = await run(f, ALLOW_ALL);
    expect(reached).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Host-side reduction and require-approval.

describe("policed wrappers: host-side reduction of real actions", () => {
  it("app adapter: Ctrl+S saves over the original and is denied; Save As is unrecognised", async () => {
    const f = fixture();
    const { adapter, calls } = fakeAdapter();
    const g = guardFor(f, ALL_RULES);
    const p = policedAppAdapter(adapter, g, adapterOpts);
    expect(await p.act({ kind: "keyPress", keys: "ctrl+s" })).toEqual({
      outcome: "failed",
      details: expect.stringMatching(/^POLICY_DENIED pol-[0-9a-f]{12}$/),
    });
    expect(await p.act({ kind: "keyPress", keys: "ctrl+shift+s" })).toEqual({
      outcome: "failed",
      details: "POLICY_DENIED",
    });
    // The guest reads a capital as Shift held: `Ctrl+S` is Ctrl+Shift+S, Save As.
    expect(await p.act({ kind: "keyPress", keys: "Ctrl+S" })).toEqual({
      outcome: "failed",
      details: "POLICY_DENIED",
    });
    expect(calls).toEqual([]);
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_OVERWRITE_ORIGINAL",
      "POLICY_ACTION_UNRECOGNISED",
      "POLICY_ACTION_UNRECOGNISED",
    ]);
  });

  // Round 1 D1: every spelling the guest's parse_chord delivers as Ctrl+S (or Meta+S).
  const SAVE_SPELLINGS = [
    "ctrl+s",
    "ctrl++s",
    "ctrl+s+",
    "+ctrl+s",
    "ctrl+ctrl+s",
    " CTRL + s ",
    "control+s",
    "cmd+s",
    "meta+s",
    "super+s",
    "SUPER+s",
    "ctrl+ s\u0085",
    "+++ctrl+++s+++",
  ];

  it.each(SAVE_SPELLINGS)(
    "app adapter and desktop transport: %j is Save, refused by no-overwrite-original",
    async (keys) => {
      const f = fixture();
      const g = guardFor(f, oneRule({ kind: "no-overwrite-original", effect: "deny" }));
      const { adapter, calls } = fakeAdapter();
      const p = policedAppAdapter(adapter, g, adapterOpts);
      expect(await p.act({ kind: "keyPress", keys })).toEqual({
        outcome: "failed",
        details: expect.stringMatching(/^POLICY_DENIED pol-[0-9a-f]{12}$/),
      });
      const { t, calls: dcalls } = fakeDesktop();
      const d = policedDesktopTransport(t, g, desktopOpts);
      expect(await d.act("s1", { kind: "keyPress", keys })).toBe("failed");
      expect([calls, dcalls]).toEqual([[], []]);
      expect(g.log().map((e) => e.code)).toEqual([
        "POLICY_OVERWRITE_ORIGINAL",
        "POLICY_OVERWRITE_ORIGINAL",
      ]);
    },
  );

  // Save As, menu accelerators, close/quit (their dialog defaults to Save), export, print, F10,
  // F12, both command keys at once, and chords the guest would refuse: never forwarded.
  const UNRECOGNISED_CHORDS = [
    "ctrl+shift+s",
    "shift+ctrl+s",
    "Ctrl+S",
    "meta+S",
    "f12",
    "F12",
    "shift+f12",
    "alt+f",
    "alt+F",
    "option+f",
    "alt+s",
    "ctrl+alt+s",
    "f10",
    "shift+f10",
    "alt+f2",
    "ctrl+w",
    "ctrl+q",
    "ctrl+e",
    "ctrl+p",
    "ctrl+shift+e",
    "ctrl+meta+s",
    "ctrl+f4",
    "alt+f4",
    "",
    "+",
    "ctrl",
    "ctrl+",
    "hyper+s",
    "ctrl+ss",
    "ctrl+﻿s",
    "ctrl+f256",
    "__proto__+s",
    "constructor+s",
  ];

  it.each(UNRECOGNISED_CHORDS)(
    "%j is POLICY_ACTION_UNRECOGNISED and never forwarded, even with only an unrelated rule",
    async (keys) => {
      const f = fixture();
      // A config that would allow the chord if it were reduced to no facts at all.
      const g = guardFor(f, ALLOW_ALL);
      const { adapter, calls } = fakeAdapter();
      const p = policedAppAdapter(adapter, g, adapterOpts);
      expect(await p.act({ kind: "keyPress", keys })).toEqual({
        outcome: "failed",
        details: "POLICY_DENIED",
      });
      expect(calls).toEqual([]);
      expect(g.log().map((e) => e.code)).toEqual(["POLICY_ACTION_UNRECOGNISED"]);
    },
  );

  it.each([
    "ctrl+c",
    "ctrl+v",
    "ctrl+x",
    "ctrl+z",
    "ctrl+shift+z",
    "ctrl+Z", // the guest holds Shift for the capital: Ctrl+Shift+Z, redo
    "cmd+a",
    "Return",
    "enter",
    "tab",
    "shift+tab",
    "escape",
    "a",
    "A",
    "shift+left",
    "ctrl+shift+right",
    "f2",
    "F02",
    "s",
    "shift+s",
  ])("%j cannot write a file by itself and is forwarded", async (keys) => {
    const f = fixture();
    const g = guardFor(f, ALL_RULES, { screen: () => false });
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, adapterOpts);
    expect((await p.act({ kind: "keyPress", keys })).outcome).toBe("delivered_unverified");
    expect(calls).toHaveLength(1);
  });

  it("typed text carrying a control character (U+0013 is Ctrl+S) is unrecognised", async () => {
    const f = fixture();
    const g = guardFor(f, ALLOW_ALL);
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, adapterOpts);
    expect((await p.act({ kind: "typeText", ref: "c", text: "a\u0013" })).outcome).toBe("failed");
    const { t, calls: dcalls } = fakeDesktop();
    const d = policedDesktopTransport(t, g, desktopOpts);
    expect(await d.act("s1", { kind: "typeTextGlobal", text: "\u007f" })).toBe("failed");
    expect(await d.act("s1", { kind: "typeTextGlobal", text: "line\tone\r\ntwo" })).toBe(
      "delivered_unverified",
    );
    expect([calls.length, dcalls.length]).toEqual([0, 1]);
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_ACTION_UNRECOGNISED",
      "POLICY_ACTION_UNRECOGNISED",
      "POLICY_ALLOWED",
    ]);
  });

  it("app adapter: typing into a host-classified credential field is denied; text never echoed", async () => {
    const f = fixture();
    const { adapter, calls } = fakeAdapter();
    const g = guardFor(f, ALL_RULES);
    const p = policedAppAdapter(adapter, g, {
      trigger: NO_APPROVALS,
      isCredentialTarget: (ref) => ref === "pw",
    });
    const r = await p.act({ kind: "typeText", ref: "pw", text: MARKER });
    expect(r.outcome).toBe("failed");
    expect(await p.act({ kind: "typeText", ref: "cell", text: "42" })).toMatchObject({
      outcome: "delivered_unverified",
    });
    expect(calls).toHaveLength(1);
    expect(allStrings(JSON.parse(JSON.stringify([r, g.log()]))).join()).not.toContain(MARKER);
  });

  it("app adapter: a classifier that throws or answers non-boolean denies", async () => {
    const f = fixture();
    const { adapter, calls } = fakeAdapter();
    const g = guardFor(f, ALL_RULES);
    const p = policedAppAdapter(adapter, g, {
      trigger: NO_APPROVALS,
      isCredentialTarget: () => {
        throw new Error("x");
      },
    });
    expect((await p.act({ kind: "setValue", ref: "a", value: "1" })).outcome).toBe("failed");
    const q = policedAppAdapter(adapter, g, {
      trigger: NO_APPROVALS,
      isCredentialTarget: () => "maybe" as unknown as boolean,
    });
    expect((await q.act({ kind: "setValue", ref: "a", value: "1" })).outcome).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("desktop transport: launches outside the allow-list and credential typing are refused", async () => {
    const f = fixture();
    const { t, calls } = fakeDesktop();
    const g = guardFor(f, ALL_RULES);
    const p = policedDesktopTransport(t, g, {
      trigger: NO_APPROVALS,
      focusIsCredential: () => true,
      launches: LAUNCHES,
    });
    expect(await p.act("s1", { kind: "launch", command: XTERM, args: [] })).toBe("failed");
    expect(await p.act("s1", { kind: "typeTextGlobal", text: MARKER })).toBe("failed");
    expect(await p.act("s1", { kind: "launch", command: SOFFICE, args: [] })).toBe(
      "delivered_unverified",
    );
    expect(await p.act("s1", { kind: "launch", command: SOFFICE, args: ["--calc"] })).toBe(
      "delivered_unverified",
    );
    expect(calls).toHaveLength(2);
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_APP_NOT_ALLOWED",
      "POLICY_CREDENTIAL_INPUT",
      "POLICY_ALLOWED",
      "POLICY_ALLOWED",
    ]);
  });

  it("linux actuator: saving over the original or outside the doc dir is refused; no-save passes", () => {
    const f = fixture();
    const { a, calls } = fakeLinux();
    const p = policedLinuxActuator(a, guardFor(f, ALL_RULES));
    expect(p.act(f.original, "A1", "1", true)).toEqual({
      ok: false,
      error: expect.stringMatching(/^POLICY_DENIED pol-/),
    });
    expect(p.act(f.outside, "A1", "1", true)).toMatchObject({ ok: false });
    expect(p.act(f.original, "A1", "1", false)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("destructive limit: the third overwrite in a trial is refused", () => {
    const f = fixture();
    const copy = join(f.docDir, "copy.xlsx");
    writeFileSync(copy, "x");
    const { a, calls } = fakeLinux();
    const p = policedLinuxActuator(a, guardFor(f, ALL_RULES));
    expect(p.act(copy, "A1", "1", true)).toEqual({ ok: true });
    expect(p.act(copy, "A1", "2", true)).toEqual({ ok: true });
    expect(p.act(copy, "A1", "3", true)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(2);
  });

  it("cross-app: a refusal is a PolicyRefusal whose message is the code only", () => {
    const f = fixture();
    const { a } = fakeCross();
    const p = policedCrossAppActuator(a, guardFor(f, ALL_RULES));
    let err: unknown;
    try {
      p.calcSet(f.outside, "A1", MARKER);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyRefusal);
    expect((err as Error).message).toBe("POLICY_DENIED");
  });

  it("router: J's workspace policy runs first, then O judges the resolved writes", () => {
    const f = fixture();
    const g = guardFor(f, ALL_RULES);
    const policy = guardedActionPolicy(
      workspacePolicy({ workspace: f.docDir, document: f.original, scratch: scratchOf(f) }),
      g,
    );
    // J refuses first (outside the workspace): O never decides.
    expect(policy.check({ route: "api", kind: "x", reads: [], writes: [f.outside] })).toEqual({
      allow: false,
      code: "PATH_OUTSIDE_WORKSPACE",
    });
    expect(g.log()).toHaveLength(0);
    // J allows a write to the trial document; O's no-overwrite-original refuses it.
    expect(policy.check({ route: "api", kind: "x", reads: [], writes: [f.original] })).toEqual({
      allow: false,
      code: "POLICY_DENIED",
    });
    expect(g.log()[0]).toMatchObject({
      actuator: "action-router.policy",
      code: "POLICY_OVERWRITE_ORIGINAL",
    });
  });

  it("sync paths: require-approval is POLICY_APPROVAL_REQUIRED, never an allow", () => {
    const f = fixture();
    const { a, calls } = fakeLinux();
    const p = policedLinuxActuator(a, guardFor(f, ALL_RULES, { screen: () => true }));
    expect(p.act(f.original, "A1", "1", false)).toEqual({
      ok: false,
      error: expect.stringMatching(/^POLICY_APPROVAL_REQUIRED pol-/),
    });
    expect(calls).toEqual([]);
  });
});

// Round 1 D2: the destructive limit holds exactly under concurrent async actions.
describe("destructive-limit: check-and-reserve is atomic across concurrent actions", () => {
  const LIMIT = (max: number) => oneRule({ kind: "destructive-limit", effect: "deny", max });
  const N = 25;
  /** A sensor that answers after a varying delay, so decisions interleave. */
  const jitter = () => {
    let i = 0;
    return () =>
      new Promise<boolean>((r) => {
        i += 1;
        setTimeout(() => r(false), (i * 7) % 5);
      });
  };

  it.each([0, 1, 3])(
    "app adapter: %i of %i concurrent Ctrl+S are forwarded, exactly",
    async (max) => {
      const f = fixture();
      const g = guardFor(f, LIMIT(max), { screen: jitter() });
      const { adapter, calls } = fakeAdapter();
      const p = policedAppAdapter(adapter, g, adapterOpts);
      const out = await Promise.all(
        Array.from({ length: N }, () => p.act({ kind: "keyPress", keys: "ctrl+s" })),
      );
      expect(calls).toHaveLength(max);
      expect(out.filter((o) => o.outcome === "failed")).toHaveLength(N - max);
      const codes = g.log().map((e) => e.code);
      expect(codes.filter((c) => c === "POLICY_ALLOWED")).toHaveLength(max);
      expect(codes.filter((c) => c === "POLICY_DESTRUCTIVE_LIMIT")).toHaveLength(N - max);
    },
  );

  it("desktop transport: 2 of 25 concurrent saves are forwarded, then the limit stays spent", async () => {
    const f = fixture();
    const g = guardFor(f, LIMIT(2), { screen: jitter() });
    const { t, calls } = fakeDesktop();
    const p = policedDesktopTransport(t, g, desktopOpts);
    await Promise.all(
      Array.from({ length: N }, () => p.act("s1", { kind: "keyPress", keys: "meta+s" })),
    );
    expect(calls).toHaveLength(2);
    expect(await p.act("s1", { kind: "keyPress", keys: "ctrl+s" })).toBe("failed");
    expect(await p.act("s1", { kind: "keyPress", keys: "ctrl+c" })).toBe("delivered_unverified");
    expect(calls).toHaveLength(3);
  });

  it("a held action that is not forwarded releases its reservation", async () => {
    const f = fixture();
    let flagged = true;
    const g = guardFor(
      f,
      {
        schema: "myco.policy-config/1",
        policies: [
          { id: "lim", kind: "destructive-limit", effect: "deny", max: 1 },
          { id: "inj", kind: "flagged-screen", effect: "require-approval" },
        ],
      },
      { screen: async () => flagged },
    );
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, adapterOpts);
    // Held for approval; NO_APPROVALS cancels it: not forwarded, so the slot comes back.
    expect((await p.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe("failed");
    flagged = false;
    expect((await p.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe(
      "delivered_unverified",
    );
    expect((await p.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("while a save waits on a human, a concurrent save cannot take the same slot", async () => {
    const f = fixture();
    const s = brokerSetup();
    let flagged = true;
    const g = guardFor(
      f,
      {
        schema: "myco.policy-config/1",
        policies: [
          { id: "lim", kind: "destructive-limit", effect: "deny", max: 1 },
          { id: "inj", kind: "flagged-screen", effect: "require-approval" },
        ],
      },
      { screen: () => flagged },
    );
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, {
      trigger: s.trigger,
      isCredentialTarget: () => false,
    });
    const held = p.act({ kind: "keyPress", keys: "ctrl+s" });
    await flush();
    await flush();
    const pending = s.operator.pending();
    expect(pending).toHaveLength(1);
    flagged = false;
    // The open handoff pauses the agent; a second policed adapter on the same guard, with no
    // broker, decides at once and must see the held reservation.
    const other = policedAppAdapter(adapter, g, adapterOpts);
    expect((await other.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe("failed");
    s.operator.resolve({
      handoffId: pending[0]?.handoffId as string,
      outcome: "approve",
      via: "cli",
    });
    expect((await held).outcome).toBe("delivered_unverified");
    expect(calls).toHaveLength(1);
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_FLAGGED_SCREEN",
      "POLICY_DESTRUCTIVE_LIMIT",
    ]);
  });

  it("sync paths: the cross-app and router wrappers commit on allow, release on refusal", () => {
    const f = fixture();
    const copy = join(f.docDir, "copy.csv");
    writeFileSync(copy, "x");
    const g = guardFor(f, {
      schema: "myco.policy-config/1",
      policies: [
        { id: "lim", kind: "destructive-limit", effect: "deny", max: 2 },
        { id: "scope", kind: "write-scope", effect: "deny" },
      ],
    });
    const { a, calls } = fakeCross();
    const p = policedCrossAppActuator(a, g);
    p.calcSet(copy, "A1", "1");
    // Refused by write-scope: nothing reserved, nothing spent.
    expect(() => p.calcSet(f.outside, "A1", "1")).toThrow(PolicyRefusal);
    p.writerAppend(copy, "T", "1");
    expect(() => p.calcSet(copy, "A1", "3")).toThrow(PolicyRefusal);
    expect(calls).toEqual(["calc", "writer"]);
  });

  it("a decision that times out reserves nothing", async () => {
    const f = fixture();
    let slow = true;
    const g = guardFor(f, LIMIT(1), {
      timeoutMs: 20,
      screen: () =>
        slow ? new Promise<boolean>((r) => setTimeout(() => r(false), 60)) : Promise.resolve(false),
    });
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, adapterOpts);
    expect((await p.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe("failed");
    await new Promise((r) => setTimeout(r, 80)); // the late reading arrives
    slow = false;
    expect((await p.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe(
      "delivered_unverified",
    );
    expect(calls).toHaveLength(1);
    expect(g.log().map((e) => e.code)).toEqual(["POLICY_ENGINE_TIMEOUT", "POLICY_ALLOWED"]);
  });
});

/** A transport that runs a launch the way the guest does: `Command::new(command).args(args)`. */
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

const FILE_RULES = {
  schema: "myco.policy-config/1",
  policies: [
    { id: "keep-original", kind: "no-overwrite-original", effect: "deny" },
    { id: "doc-dir-only", kind: "write-scope", effect: "deny" },
    { id: "none-destructive", kind: "destructive-limit", effect: "deny", max: 0 },
  ],
};

const launch = (command: unknown, args: unknown = []) =>
  ({ kind: "launch", command, args }) as unknown as GuardedDesktopAction;

describe("desktop transport: a launch is judged by its real path and its whole argument vector", () => {
  it("verdict probe 1: `launch cp <outside> <original>` is refused and the original is untouched", async () => {
    const f = fixture();
    writeFileSync(f.outside, "TAMPERED");
    const cp = realpathSync("/bin/cp");
    // The probe's spawning transport really overwrites a file when a cp launch reaches it.
    const scratch = join(scratchOf(f), "victim.txt");
    writeFileSync(scratch, "pristine");
    const raw = spawningDesktop();
    expect(await raw.t.act("s1", launch(cp, [f.outside, scratch]))).toBe("delivered_unverified");
    expect(readFileSync(scratch, "utf8")).toBe("TAMPERED");

    const { t, calls } = spawningDesktop();
    const g = guardFor(f, FILE_RULES);
    // Even with cp itself listed (no arguments declared), its arguments are refused.
    const p = policedDesktopTransport(t, g, {
      ...desktopOpts,
      launches: { ...LAUNCHES, [cp]: { app: "cp" } },
    });
    expect(await p.act("s1", { kind: "keyPress", keys: "ctrl+s" })).toBe("failed");
    expect(await p.act("s1", launch(cp, [f.outside, f.original]))).toBe("failed");
    expect(await p.act("s1", launch("/bin/cp", [f.outside, f.original]))).toBe("failed");
    expect(calls).toEqual([]);
    expect(readFileSync(f.original, "utf8")).toBe("pristine");
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_OVERWRITE_ORIGINAL",
      "POLICY_ACTION_UNRECOGNISED",
      "POLICY_ACTION_UNRECOGNISED",
    ]);
  });

  it("verdict probe 2: a soffice convert into the doc dir and a look-alike soffice are refused", async () => {
    const f = fixture();
    const fake = join(f.docDir, "soffice");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    const convert = [
      "--headless",
      "--convert-to",
      "xlsx",
      "--outdir",
      f.docDir,
      "/tmp/original.csv",
    ];
    const { t, calls } = spawningDesktop();
    const g = guardFor(f, ALL_RULES); // app-allowlist: soffice, localc
    const p = policedDesktopTransport(t, g, desktopOpts);
    expect(await p.act("s1", launch(SOFFICE, convert))).toBe("failed");
    expect(await p.act("s1", launch("/usr/bin/soffice", convert))).toBe("failed");
    expect(await p.act("s1", launch(fake, []))).toBe("failed");
    expect(calls).toEqual([]);
    expect(g.log().map((e) => e.code)).toEqual(Array(3).fill("POLICY_ACTION_UNRECOGNISED"));
  });

  it("only the listed real path, with no arguments or exactly a declared vector, is recognised", async () => {
    const f = fixture();
    const linkDir = join(f.root, "bin-link");
    symlinkSync(BIN, linkDir);
    const linkFile = join(f.docDir, "office");
    symlinkSync(SOFFICE, linkFile);
    const { t, calls } = fakeDesktop();
    const g = guardFor(f, ALL_RULES);
    const p = policedDesktopTransport(t, g, desktopOpts);
    const refused: GuardedDesktopAction[] = [
      launch("soffice"), // bare name: the guest would search its PATH
      launch(relative(process.cwd(), SOFFICE)), // relative
      launch(`${BIN}/../${BIN.split("/").pop()}/soffice`), // `..`
      launch(`${BIN}//soffice`), // doubled slash
      launch(`${BIN}/./soffice`), // `.`
      launch(`${BIN}/soffice/`), // trailing slash
      launch(join(linkDir, "soffice")), // through a symlinked directory
      launch(linkFile), // a symlink to the listed program
      launch(`${BIN}/SOFFICE`), // a different file
      launch(`${SOFFICE}\n`), // a control character
      launch(""),
      launch(42),
      launch(null),
      launch(SOFFICE, "--calc"), // args not an array
      { kind: "launch", command: SOFFICE } as unknown as GuardedDesktopAction, // no args field
      launch(SOFFICE, [1]),
      launch(SOFFICE, ["--calc", f.original]), // a declared vector plus an operand
      launch(SOFFICE, ["--calc", "--calc"]),
      launch(SOFFICE, ["--CALC"]),
      launch(SOFFICE, ["--calc "]),
      launch(SOFFICE, [""]),
      launch(SOFFICE, ["--writer"]),
      launch(XTERM, ["--calc"]), // another program's vector
      launch(XTERM, ["-e", "sh"]),
    ];
    for (const [k, a] of refused.entries())
      expect(await p.act("s1", a), `refused[${k}]`).toBe("failed");
    expect(calls).toEqual([]);
    expect(g.log().map((e) => e.code)).toEqual(
      Array(refused.length).fill("POLICY_ACTION_UNRECOGNISED"),
    );
    expect(await p.act("s1", launch(SOFFICE, []))).toBe("delivered_unverified");
    expect(await p.act("s1", launch(SOFFICE, ["--calc"]))).toBe("delivered_unverified");
    expect(calls).toHaveLength(2);
  });

  it("no launch table: every launch is unrecognised", async () => {
    const f = fixture();
    const { t, calls } = fakeDesktop();
    const g = guardFor(f, ALL_RULES);
    const p = policedDesktopTransport(t, g, { ...desktopOpts, launches: {} });
    expect(await p.act("s1", launch(SOFFICE))).toBe("failed");
    expect(calls).toEqual([]);
    expect(g.log().map((e) => e.code)).toEqual(["POLICY_ACTION_UNRECOGNISED"]);
  });

  it("the table is checked and copied when the wrapper is built", async () => {
    for (const bad of [
      { "bin/soffice": { app: "soffice" } },
      { [`${BIN}//soffice`]: { app: "soffice" } },
      { [SOFFICE]: { app: "" } },
      { [SOFFICE]: {} },
      { [SOFFICE]: { app: "soffice", argv: ["--calc"] } },
      { [SOFFICE]: { app: "soffice", argv: [[1]] } },
    ])
      expect(() => freezeLaunchTable(bad as unknown as LaunchTable)).toThrow(
        "POLICY_LAUNCH_TABLE_INVALID",
      );
    expect(() => freezeLaunchTable(null as unknown as LaunchTable)).toThrow(
      "POLICY_LAUNCH_TABLE_INVALID",
    );
    const f = fixture();
    const vector = ["--calc"];
    const argv: string[][] = [vector];
    const table: Record<string, { app: string; argv?: string[][] }> = {
      [SOFFICE]: { app: "soffice", argv },
    };
    const { t, calls } = fakeDesktop();
    const p = policedDesktopTransport(t, guardFor(f, ALL_RULES), {
      ...desktopOpts,
      launches: table,
    });
    // Mutating the host's object afterwards changes nothing.
    table[XTERM] = { app: "soffice" };
    argv.push(["--writer"]);
    vector[0] = "--impress";
    expect(await p.act("s1", launch(SOFFICE, ["--impress"]))).toBe("failed");
    expect(await p.act("s1", launch(SOFFICE, ["--calc"]))).toBe("delivered_unverified");
    calls.length = 0;
    expect(await p.act("s1", launch(XTERM))).toBe("failed");
    expect(await p.act("s1", launch(SOFFICE, ["--writer"]))).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("policed wrappers: require-approval opens a track N handoff (async paths)", () => {
  it("a human's fixed-it never forwards the held action, and releases its slot", async () => {
    const f = fixture();
    const s = brokerSetup();
    let flagged = true;
    const g = guardFor(
      f,
      {
        schema: "myco.policy-config/1",
        policies: [
          { id: "lim", kind: "destructive-limit", effect: "deny", max: 1 },
          { id: "inj", kind: "flagged-screen", effect: "require-approval" },
        ],
      },
      { screen: () => flagged },
    );
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, g, {
      trigger: s.trigger,
      isCredentialTarget: () => false,
    });
    const held = p.act({ kind: "keyPress", keys: "ctrl+s" });
    await flush();
    await flush();
    const pending = s.operator.pending();
    expect(pending).toHaveLength(1);
    s.operator.resolve({
      handoffId: pending[0]?.handoffId as string,
      outcome: "fixed-it",
      via: "cli",
    });
    expect(await held).toEqual({
      outcome: "failed",
      details: expect.stringMatching(/^POLICY_APPROVAL_REQUIRED pol-[0-9a-f]{12}$/),
    });
    expect(calls).toEqual([]);
    // The slot came back: with the screen clear, one save (the limit) is forwarded, then none.
    flagged = false;
    const other = policedAppAdapter(adapter, g, adapterOpts);
    expect((await other.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe(
      "delivered_unverified",
    );
    expect((await other.act({ kind: "keyPress", keys: "ctrl+s" })).outcome).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(g.log().map((e) => e.code)).toEqual([
      "POLICY_FLAGGED_SCREEN",
      "POLICY_ALLOWED",
      "POLICY_DESTRUCTIVE_LIMIT",
    ]);
  });

  it("approve forwards the action; reject and timeout do not", async () => {
    const f = fixture();
    const s = brokerSetup();
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, guardFor(f, ALL_RULES, { screen: () => true }), {
      trigger: s.trigger,
      isCredentialTarget: () => false,
    });
    const first = p.act({ kind: "click", ref: "ok" });
    await flush();
    await flush();
    const pending = s.operator.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ source: "policy", reason: "needs-approval" });
    expect(JSON.stringify(pending[0])).not.toContain(f.root);
    s.operator.resolve({
      handoffId: pending[0]?.handoffId as string,
      outcome: "approve",
      via: "cli",
    });
    expect((await first).outcome).toBe("delivered_unverified");
    expect(calls).toHaveLength(1);

    const second = p.act({ kind: "click", ref: "no" });
    await flush();
    await flush();
    const id = s.operator.pending()[0]?.handoffId as string;
    s.operator.resolve({ handoffId: id, outcome: "reject", via: "cli" });
    expect(await second).toEqual({
      outcome: "failed",
      details: expect.stringMatching(/^POLICY_APPROVAL_REQUIRED/),
    });
    expect(calls).toHaveLength(1);
  });

  it("without a broker (NO_APPROVALS) an approval cannot be granted: not forwarded", async () => {
    const f = fixture();
    const { t, calls } = fakeDesktop();
    const p = policedDesktopTransport(
      t,
      guardFor(f, ALL_RULES, { screen: () => true }),
      desktopOpts,
    );
    expect(await p.act("s1", { kind: "clickAt", x: 0, y: 0 })).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("a deny never opens a handoff", async () => {
    const f = fixture();
    const s = brokerSetup();
    const { adapter, calls } = fakeAdapter();
    const p = policedAppAdapter(adapter, guardFor(f, ALL_RULES), {
      trigger: s.trigger,
      isCredentialTarget: () => true,
    });
    expect((await p.act({ kind: "typeText", ref: "pw", text: "x" })).outcome).toBe("failed");
    expect(s.operator.pending()).toEqual([]);
    expect(s.broker.log().entries).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("while a handoff is open, the pause gate holds the action before the policy decides", async () => {
    const f = fixture();
    const s = brokerSetup();
    const g = guardFor(f, ALLOW_ALL);
    const { adapter, calls } = fakeAdapter();
    const agent = s.broker.agentChannel();
    void agent.request({ reason: "blocked", note: "help" }, Number.POSITIVE_INFINITY);
    await flush();
    const p = policedAppAdapter(adapter, g, {
      trigger: s.trigger,
      isCredentialTarget: () => false,
    });
    const held = p.act({ kind: "click", ref: "a" });
    await flush();
    expect(calls).toEqual([]);
    expect(g.log()).toHaveLength(0);
    s.operator.resolve({
      handoffId: s.operator.pending()[0]?.handoffId as string,
      outcome: "approve",
      via: "cli",
    });
    expect((await held).outcome).toBe("delivered_unverified");
    expect(calls).toHaveLength(1);
  });
});
