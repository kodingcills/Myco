/**
 * Track K agent surface: checkpoint_take / checkpoint_restore / snapshot_restore_start
 * (docs/recovery/recovery.md, acceptance K1-K3, K8). Pure: an in-memory guest document.
 */
import { describe, expect, it } from "vitest";
import { auditToolSurface } from "../../src/integrity/surface.ts";
import {
  RECOVERY_CODES,
  RECOVERY_SERVER_CLASS,
  RECOVERY_SERVER_NAME,
  RECOVERY_TOOL_DEFS,
  RECOVERY_TOOLS,
  RecoveryTools,
  StepMeter,
} from "../../src/recovery/tools.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function guest(initial = "handed") {
  const state = { bytes: enc(initial), writes: 0, failRead: false, failWrite: false };
  return {
    state,
    document: {
      read: async () => {
        if (state.failRead) throw new Error("/home/secret/path unreadable");
        return state.bytes;
      },
      write: async (b: Uint8Array) => {
        if (state.failWrite) throw new Error("/home/secret/path unwritable");
        state.writes++;
        state.bytes = Uint8Array.from(b);
      },
    },
  };
}

function tools(
  opts: { budget?: number; initial?: string; maxCheckpoints?: number; maxBytes?: number } = {},
) {
  const g = guest(opts.initial);
  const meter = new StepMeter(opts.budget ?? 100);
  const t = new RecoveryTools({
    document: g.document,
    handed: enc(opts.initial ?? "handed"),
    meter,
    ...(opts.maxCheckpoints === undefined ? {} : { maxCheckpoints: opts.maxCheckpoints }),
    ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
  });
  return { t, g, meter };
}

describe("K1. checkpoint_take returns an opaque id; checkpoint_restore restores exactly that state", () => {
  it("take -> edit -> restore puts the taken bytes back", async () => {
    const { t, g } = tools();
    g.state.bytes = enc("step-1 done");
    const r = await t.call("checkpoint_take", {});
    expect(r.ok).toBe(true);
    const id = r.ok ? (r.id as string) : "";
    expect(id).toMatch(/^ckpt_[0-9a-f]{32}$/);
    expect(id).not.toContain("step");
    g.state.bytes = enc("broken");
    expect(await t.call("checkpoint_restore", { id })).toEqual({ ok: true });
    expect(dec(g.state.bytes)).toBe("step-1 done");
  });

  it("ids are random: two takes of the same document give different ids", async () => {
    const { t } = tools();
    const a = await t.call("checkpoint_take");
    const b = await t.call("checkpoint_take");
    expect(a.ok && b.ok && a.id !== b.id).toBe(true);
  });

  it("the checkpoint is a copy: later guest edits do not change it", async () => {
    const { t, g } = tools();
    g.state.bytes = enc("v1");
    const r = await t.call("checkpoint_take");
    g.state.bytes.set(enc("XX"));
    const id = r.ok ? (r.id as string) : "";
    await t.call("checkpoint_restore", { id });
    expect(dec(g.state.bytes)).toBe("v1");
  });
});

describe("K2. snapshot_restore_start restores the document the agent was handed", () => {
  it("writes back the handed bytes, even after the source buffer is mutated", async () => {
    const g = guest("start");
    const handed = enc("start");
    const t = new RecoveryTools({ document: g.document, handed, meter: new StepMeter(10) });
    handed.set(enc("XXXXX"));
    g.state.bytes = enc("agent edits");
    expect(await t.call("snapshot_restore_start", {})).toEqual({ ok: true });
    expect(dec(g.state.bytes)).toBe("start");
  });
});

describe("K3. rollback never restores a state the agent did not produce or was not given", () => {
  it("an id from another instance (another trial or attempt) is CHECKPOINT_UNKNOWN", async () => {
    const a = tools({ initial: "other trial's verified doc" });
    const b = tools({ initial: "mine" });
    const r = await a.t.call("checkpoint_take");
    const id = r.ok ? (r.id as string) : "";
    expect(await b.t.call("checkpoint_restore", { id })).toEqual({
      ok: false,
      code: "CHECKPOINT_UNKNOWN",
    });
    expect(dec(b.g.state.bytes)).toBe("mine");
    expect(b.g.state.writes).toBe(0);
  });

  it("a well-formed guessed id is CHECKPOINT_UNKNOWN and writes nothing", async () => {
    const { t, g } = tools();
    await t.call("checkpoint_take");
    expect(await t.call("checkpoint_restore", { id: `ckpt_${"0".repeat(32)}` })).toEqual({
      ok: false,
      code: "CHECKPOINT_UNKNOWN",
    });
    expect(g.state.writes).toBe(0);
  });

  it("malformed or smuggling arguments are ARGS_INVALID and write nothing", async () => {
    const { t, g } = tools();
    const r = await t.call("checkpoint_take");
    const id = r.ok ? (r.id as string) : "";
    const bad: [string, unknown][] = [
      ["checkpoint_take", { path: "/etc/passwd" }],
      ["checkpoint_take", null],
      ["checkpoint_take", []],
      ["checkpoint_take", "x"],
      ["checkpoint_take", Object.create(null)],
      ["snapshot_restore_start", { checkpoint: 0 }],
      ["snapshot_restore_start", { runId: "other" }],
      ["checkpoint_restore", undefined],
      ["checkpoint_restore", {}],
      ["checkpoint_restore", { id, verdict: "verified" }],
      ["checkpoint_restore", { id: 5 }],
      ["checkpoint_restore", { id: `${id} ` }],
      ["checkpoint_restore", { id: id.toUpperCase() }],
      ["checkpoint_restore", { bytes: "verified doc" }],
      ["checkpoint_restore", [id]],
      ["checkpoint_restore", { [Symbol("id")]: id }],
    ];
    for (const [name, args] of bad)
      expect(await t.call(name, args), `${name} #${bad.findIndex((b) => b[1] === args)}`).toEqual({
        ok: false,
        code: "ARGS_INVALID",
      });
    expect(g.state.writes).toBe(0);
  });

  it("an unknown tool name is TOOL_UNKNOWN", async () => {
    const { t } = tools();
    for (const name of ["verdict", "checkpoint_list", 7, undefined, "__proto__"])
      expect(await t.call(name, {})).toEqual({ ok: false, code: "TOOL_UNKNOWN" });
  });

  it("closed tools (the attempt ended) refuse everything and write nothing", async () => {
    const { t, g } = tools();
    const r = await t.call("checkpoint_take");
    const id = r.ok ? (r.id as string) : "";
    t.close();
    for (const [name, args] of [
      ["checkpoint_restore", { id }],
      ["snapshot_restore_start", {}],
      ["checkpoint_take", {}],
    ] as const)
      expect(await t.call(name, args)).toEqual({ ok: false, code: "TOOLS_CLOSED" });
    expect(g.state.writes).toBe(0);
  });

  it("a restore whose attempt closes mid-call writes nothing", async () => {
    const g = guest("v");
    let release: () => void = () => {};
    const gated = new Promise<void>((r) => {
      release = r;
    });
    const t = new RecoveryTools({
      document: {
        read: async () => {
          await gated;
          return g.state.bytes;
        },
        write: g.document.write,
      },
      handed: enc("h"),
      meter: new StepMeter(10),
    });
    const pending = t.call("checkpoint_take");
    t.close();
    release();
    expect(await pending).toEqual({ ok: false, code: "TOOLS_CLOSED" });
  });
});

describe("K4 (tools). every call takes a step from the shared meter", () => {
  it("refused calls count too, and an empty meter makes every call a no-op", async () => {
    const { t, g, meter } = tools({ budget: 3 });
    await t.call("checkpoint_take");
    await t.call("nope");
    await t.call("snapshot_restore_start", {});
    expect(meter.used).toBe(3);
    g.state.bytes = enc("edited");
    expect(await t.call("snapshot_restore_start", {})).toEqual({
      ok: false,
      code: "STEP_BUDGET_EXHAUSTED",
    });
    expect(dec(g.state.bytes)).toBe("edited");
    expect(meter.used).toBe(3);
  });

  it("the meter refuses a non-positive or fractional budget", () => {
    for (const b of [0, -1, 1.5, Number.NaN]) expect(() => new StepMeter(b)).toThrow();
  });
});

describe("K-limits. fail closed with codes only", () => {
  it("checkpoint limit and size limit", async () => {
    const a = tools({ maxCheckpoints: 2 });
    await a.t.call("checkpoint_take");
    await a.t.call("checkpoint_take");
    expect(await a.t.call("checkpoint_take")).toEqual({ ok: false, code: "CHECKPOINT_LIMIT" });
    const b = tools({ maxBytes: 3, initial: "four" });
    expect(await b.t.call("checkpoint_take")).toEqual({ ok: false, code: "DOCUMENT_TOO_LARGE" });
  });

  it("read and write failures carry a code, never the error message", async () => {
    const { t, g } = tools();
    const r = await t.call("checkpoint_take");
    const id = r.ok ? (r.id as string) : "";
    g.state.failRead = true;
    expect(await t.call("checkpoint_take")).toEqual({ ok: false, code: "DOCUMENT_UNREADABLE" });
    g.state.failWrite = true;
    const w = await t.call("checkpoint_restore", { id });
    expect(w).toEqual({ ok: false, code: "DOCUMENT_WRITE_FAILED" });
    expect(JSON.stringify(w)).not.toContain("/home");
  });

  it("every reply has only ok / id / code, and every code is a declared one", async () => {
    const { t } = tools({ budget: 4 });
    const replies = [
      await t.call("checkpoint_take"),
      await t.call("checkpoint_restore", { id: 1 }),
      await t.call("x"),
      await t.call("snapshot_restore_start"),
      await t.call("snapshot_restore_start"),
    ];
    for (const r of replies) {
      for (const k of Object.keys(r)) expect(["ok", "id", "code"]).toContain(k);
      if (!r.ok) expect(RECOVERY_CODES).toContain(r.code);
    }
  });

  it("the operator log records every call in order, with the bytes' sha256 on success", async () => {
    const { t } = tools({ budget: 3 });
    await t.call("checkpoint_take");
    await t.call("bogus");
    await t.call("snapshot_restore_start");
    const ev = t.events();
    expect(ev.map((e) => [e.seq, e.tool, e.ok, e.code])).toEqual([
      [0, "checkpoint_take", true, undefined],
      [1, "bogus", false, "TOOL_UNKNOWN"],
      [2, "snapshot_restore_start", true, undefined],
    ]);
    expect(ev[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("K8. surface: classified for the K arm audit only", () => {
  const granted = RECOVERY_TOOLS.map((t) => `mcp__${RECOVERY_SERVER_NAME}__${t}`);
  it("passes the audit as guest reach when the K arm passes its class", () => {
    const audit = auditToolSurface(granted, { extraServers: RECOVERY_SERVER_CLASS });
    expect(audit.ok).toBe(true);
  });
  it("the default (R1) audit refuses the recovery tools as unclassified", () => {
    const audit = auditToolSurface(granted);
    expect(audit.ok).toBe(false);
    expect(audit.violations.every((v) => v.reach === "unknown")).toBe(true);
  });
  it("tool definitions are exactly the three tools with closed input schemas", () => {
    expect(RECOVERY_TOOL_DEFS.map((d) => d.name)).toEqual([...RECOVERY_TOOLS]);
    for (const d of RECOVERY_TOOL_DEFS) expect(d.inputSchema.additionalProperties).toBe(false);
  });
});
