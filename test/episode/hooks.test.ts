/**
 * Writer hooks fire on every ending: verified, refuted, uncertain (labelled), harness fault
 * (labelled, never an agent outcome), launch refused, unregistrable; on the gated trial path,
 * the M2 dry run and the gate's mock demo. Simulated rows are labelled simulated and a real
 * store refuses them. Real gate (sealed vault, calc-record-edit), no VM, no model.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runDryRun } from "../../src/benchmark/r1-dryrun.ts";
import { writeDryRunEpisodes } from "../../src/episode/dry-run.ts";
import { runGatedTrialWithEpisode } from "../../src/episode/gated.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import type { Episode } from "../../src/episode/types.ts";
import { main as gateMain } from "../../src/gate/cli.ts";
import {
  BUNDLE,
  captureFor,
  draft,
  HOST,
  honestDoc,
  ORACLE_SOURCES,
  plan,
  pristineDoc,
  registry,
  scratch,
  TASKS,
  task,
  vaultIn,
} from "./helpers.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function only(store: EpisodeStore): Episode {
  const { episodes } = readStoreDir(store.root);
  expect(episodes).toHaveLength(1);
  return episodes[0] as Episode;
}

async function gated(
  doc: Uint8Array | null | "throw-run" | "throw-capture",
  over: Parameters<typeof captureFor>[2] = {},
  planEnv: Record<string, string> = {},
) {
  const base = dir("gated");
  const t = task("none");
  const store = EpisodeStore.open(join(base, "store"), { simulated: true, host: HOST });
  const run = runGatedTrialWithEpisode(
    {
      vault: vaultIn(base),
      runId: "run-hook",
      taskId: t.taskId,
      tasks: registry(t),
      plan: plan(base, planEnv),
      oracleSources: ORACLE_SOURCES,
      transport: {
        async runAgent() {
          if (doc === "throw-run") throw new Error("ssh dropped");
        },
        async captureAfterStop(): Promise<Record<string, Uint8Array>> {
          if (doc === "throw-capture") throw new Error("copy failed");
          return doc === null || typeof doc === "string" ? {} : { "persisted/doc.csv": doc };
        },
      },
    },
    captureFor(store, t, over),
  );
  return { store, run, t };
}

describe("runGatedTrialWithEpisode: every ending writes a labelled episode", () => {
  it("verified: the gate's verdict, and the independent grader's pass as ground truth", async () => {
    const t = task("none");
    const { store, run } = await gated(honestDoc(t));
    const { outcome, episode } = await run;
    expect(outcome.status).toBe("decided");
    expect(episode.status).toBe("written");
    const ep = only(store);
    expect(ep.outcome).toBe("verified");
    expect(ep.gate).toMatchObject({
      verdict: "verified",
      accepted: true,
      reasonCodes: ["ORACLE_PASS"],
    });
    expect(ep.gate?.oracle?.family).toBe("calc-record-edit");
    expect(ep.groundTruth).toMatchObject({ source: "independent-grader", status: "pass" });
    expect(ep.observations.items[0]).toMatchObject({ kind: "state", label: "persisted" });
    expect(ep.simulated).toBe(true);
  });

  it("refuted: the untouched fixture, graded fail by the grader", async () => {
    const t = task("none");
    const { store, run } = await gated(pristineDoc(t));
    await run;
    const ep = only(store);
    expect(ep.outcome).toBe("refuted");
    expect(ep.gate?.reasonCodes).toContain("ORACLE_FAIL");
    expect(ep.groundTruth).toMatchObject({ source: "independent-grader", status: "fail" });
  });

  it("uncertain: a document the gate cannot read is labelled uncertain", async () => {
    const { store, run } = await gated(new Uint8Array([0xff, 0xfe, 0x00, 0x22, 0x0a, 0x22]));
    await run;
    const ep = only(store);
    expect(ep.outcome).toBe("uncertain");
    expect(ep.gate?.verdict).toBe("uncertain");
    expect(ep.harness.fault).toBeNull();
  });

  it("harness fault (gate harness code): no document captured is a harness fault, not an agent outcome", async () => {
    const { store, run } = await gated(null);
    await run;
    const ep = only(store);
    expect(ep.outcome).toBe("harness-fault");
    expect(ep.harness.fault).toEqual({ class: "gate-harness-code", code: "STATE_MISSING" });
    expect(ep.groundTruth).toEqual({ source: "none", reason: "harness-fault" });
  });

  it("harness fault (transport threw): saved labelled, and the error still propagates", async () => {
    const { store, run } = await gated("throw-run");
    await expect(run).rejects.toThrow(/ssh dropped/);
    const ep = only(store);
    expect(ep.outcome).toBe("harness-fault");
    expect(ep.harness.fault?.class).toBe("transport-error");
    expect(ep.gate).toBeNull();
  });

  it("harness fault (capture threw)", async () => {
    const { store, run } = await gated("throw-capture");
    await expect(run).rejects.toThrow(/copy failed/);
    expect(only(store).harness.fault?.class).toBe("capture-error");
  });

  it("harness fault declared by the caller (its trial-ops row) overrides an agent outcome", async () => {
    const t = task("none");
    const { store, run } = await gated(honestDoc(t), {
      harnessFault: { class: "load", code: null },
    });
    await run;
    const ep = only(store);
    expect(ep.outcome).toBe("harness-fault");
    expect(ep.gate?.verdict).toBe("verified");
    expect(ep.groundTruth).toEqual({ source: "none", reason: "harness-fault" });
  });

  it("launch refused: the audit refused the plan, the agent never ran", async () => {
    // A plan the audit refuses: an extra MCP server that is not classified.
    const base = dir("refused");
    const t = task("none");
    const store2 = EpisodeStore.open(join(base, "store"), { simulated: true, host: HOST });
    const p = plan(base);
    const { outcome } = await runGatedTrialWithEpisode(
      {
        vault: vaultIn(base),
        runId: "run-refused",
        taskId: t.taskId,
        tasks: registry(t),
        plan: {
          ...p,
          mcpServers: { ...p.mcpServers, shell: { command: "bash", args: [], env: {} } },
        },
        oracleSources: ORACLE_SOURCES,
        transport: {
          async runAgent() {
            throw new Error("must not run");
          },
          async captureAfterStop() {
            return {};
          },
        },
      },
      captureFor(store2, t),
    );
    expect(outcome.status).toBe("refused");
    const ep = only(store2);
    expect(ep.outcome).toBe("launch-refused");
    expect(ep.agentClaim).toBe("no-claim");
    expect(ep.groundTruth).toEqual({ source: "none", reason: "agent-never-ran" });
  });

  it("an episode refused as unclean never changes the trial's outcome", async () => {
    const t = task("none");
    const { store, run } = await gated(honestDoc(t), {
      task: { ...captureFor({} as never, t).task, instruction: "PLANTED_FAKE_MARKER" },
    });
    const { outcome, episode } = await run;
    expect(outcome.status).toBe("decided");
    expect(episode.status).toBe("refused");
    expect(readdirSync(join(store.root, "episodes"))).toEqual([]);
  });

  it("records the attempt ledger head when one is kept (lands with #518)", async () => {
    const t = task("none");
    const head = {
      schema: "myco.m2.attempt-event/1",
      events: 2,
      headSha256: "a".repeat(64),
    } as const;
    const { store, run } = await gated(honestDoc(t), { attemptLedger: () => head });
    await run;
    expect(only(store).provenance.attemptLedger).toEqual(head);
  });
});

describe("simulated rows never mix into real datasets", () => {
  it("a real store refuses a simulated episode, and a simulated store a real one", () => {
    const real = EpisodeStore.open(join(dir("real"), "s"), { simulated: false, host: HOST });
    expect(real.record(draft()).status).toBe("refused");
    const sim = EpisodeStore.open(join(dir("sim"), "s"), { simulated: true, host: HOST });
    const realDraft = draft({
      simulated: false,
      harness: { ...draft().harness, plannerModelId: "claude-opus-5-5" },
    });
    expect(sim.record(realDraft).status).toBe("refused");
    expect(real.record(realDraft).status).toBe("written");
  });

  it("a store's kind is fixed at creation", () => {
    const root = join(dir("kind"), "s");
    EpisodeStore.open(root, { simulated: true, host: HOST });
    expect(() => EpisodeStore.open(root, { simulated: false, host: HOST })).toThrow(/simulated/);
  });

  it("a simulated planner on a gated trial cannot be labelled real", () => {
    const real = EpisodeStore.open(join(dir("real2"), "s"), { simulated: false, host: HOST });
    const r = real.record(draft({ simulated: false }));
    expect(r.status).toBe("refused");
  });
});

describe("M2 dry run hook (SIMULATED)", () => {
  it("writes one simulated episode per dry-run trial, with the grader's ground truth", {
    timeout: 60_000,
  }, async () => {
    const subset = ["none", "kill-app", "focus-change", "invalid-target"].map((f) => task(f));
    const out = dir("dry");
    const { armRows } = await runDryRun(subset, join(out, "run"), ORACLE_SOURCES);
    const store = EpisodeStore.open(join(out, "episodes"), { simulated: true, host: HOST });
    const results = writeDryRunEpisodes({
      tasks: TASKS,
      armRows,
      dryRunDir: join(out, "run"),
      bundleDir: BUNDLE,
      store,
    });
    expect(results.map((r) => r.status)).toEqual(["written", "written", "written", "written"]);
    const eps = readStoreDir(store.root).episodes;
    const byTask = new Map(eps.map((e) => [e.task.faultClass, e]));
    expect(eps.every((e) => e.simulated && e.provenance.source === "m2-dry-run")).toBe(true);
    expect(byTask.get("none")).toMatchObject({
      outcome: "verified",
      groundTruth: { status: "pass" },
    });
    expect(byTask.get("focus-change")).toMatchObject({
      outcome: "refuted",
      groundTruth: { status: "fail" },
    });
    expect(byTask.get("invalid-target")?.outcome).toBe("unregistrable");
    expect(byTask.get("invalid-target")?.gate).toBeNull();
    expect(eps.every((e) => e.gate === null || e.gate.reasonCodes === null)).toBe(true);
    const real = EpisodeStore.open(join(out, "real"), { simulated: false, host: HOST });
    expect(() =>
      writeDryRunEpisodes({
        tasks: TASKS,
        armRows,
        dryRunDir: join(out, "run"),
        bundleDir: BUNDLE,
        store: real,
      }),
    ).toThrow(/simulated/);
  });
});

describe("gate mock demo hook (myco-gate demo --transport mock)", () => {
  it("writes a simulated episode per scenario, including the refuted and tampered ones", {
    timeout: 60_000,
  }, async () => {
    const out = dir("demo");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c) => {
      err += String(c);
    });
    const code = await gateMain(["demo", "--transport", "mock", "--out", out], {
      stdin: new PassThrough(),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(err).toMatch(/episodes: 4 simulated episode\(s\) saved/);
    const { episodes } = readStoreDir(join(out, "episodes"));
    expect(episodes).toHaveLength(4);
    expect(episodes.every((e) => e.simulated && e.provenance.source === "demo-mock")).toBe(true);
    const outcomes = episodes.map((e) => e.outcome).sort();
    expect(outcomes).toContain("verified");
    expect(outcomes).toContain("refuted");
    expect(readFileSync(join(out, "episodes", "STORE.json"), "utf8")).toContain('"simulated":true');
  });
});
