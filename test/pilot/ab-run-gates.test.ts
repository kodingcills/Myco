/**
 * #572: the leftover #549 A/B runner follow-ups (`src/pilot/ab.ts`), pinned before Stage 0:
 *  - S2: tests that kill the round-3 verifier's survivors V7 (check-pack's arm-config diff),
 *    V11 (the launch-plan `env` comparison) and V12 (`recordDecided` counts `ungradable` as a
 *    miss, not only `fail`);
 *  - N1: a torn JSONL line is refused with an operator-readable code;
 *  - N2: an interrupted atomic write's `.tmp` never goes into a pack;
 *  - V8: export's own pre-registration check is not redundant (a header whose hash alone was
 *    edited derives the same configs).
 * Fake transports only: simulated stage-0 runs, no model, no `claude` process, no VM, $0.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import {
  AB_DRY_RUN_PLANNER,
  AbRefusal,
  abFakeDriver,
  analysisConfig,
  bundleGrader,
  checkAbPack,
  compareLaunchPlans,
  exportAbPack,
  type GradeFn,
  type HookContext,
  incidentId,
  incidentStatus,
  loadPrereg,
  recordDecided,
  runAbStage,
  stageRoot,
  TORN_JSONL,
} from "../../src/pilot/ab.ts";
import { configSha256, type PilotConfig } from "../../src/pilot/config.ts";
import { fakeDriver, virtualClock } from "../../src/pilot/dry-run.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { PUBLISHED, ROOT, SOURCES, tmp } from "./helpers.ts";

const LOADED = loadPrereg(ROOT);
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");

const run = (outRoot: string) => {
  const clock = virtualClock(0);
  return runAbStage({
    repoRoot: ROOT,
    published: PUBLISHED,
    loaded: LOADED,
    stage: 0,
    outRoot,
    driver: abFakeDriver(fakeDriver()),
    plannerModelId: AB_DRY_RUN_PLANNER,
    oracleSources: SOURCES,
    maxChunks: Number.POSITIVE_INFINITY,
    sleep: clock.sleep,
    now: clock.now,
    load1m: () => 0.25,
  });
};

/** One completed simulated stage-0 run; each test works on its own copy of it. */
let done: string;
beforeAll(async () => {
  done = tmp("myco-ab-gates-done-");
  await expect(run(done)).resolves.toMatchObject({ status: "complete" });
}, 120_000);

const copy = (prefix: string) => {
  const out = tmp(prefix);
  cpSync(done, out, { recursive: true });
  return out;
};

const refusal = (fn: () => unknown): AbRefusal => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbRefusal) return e;
    throw new Error(`expected an AbRefusal, got ${String(e)}`);
  }
  throw new Error("expected an AbRefusal, nothing was thrown");
};

describe("#572 S2: the round-3 survivors are killed", () => {
  it("V7: check-pack refuses arms that differ apart from corrections, all else consistent", () => {
    const out = copy("myco-ab-gates-v7-");
    const pack = join(out, "pack");
    exportAbPack(out, 0, pack, ROOT);
    expect(checkAbPack(pack, ROOT)).toMatchObject({ ok: true, errors: [] });
    // Tamper the OFF arm's config, then make every other record agree with it: its sha256 in
    // the manifest and its analysis config. Only the arm-config diff can see the difference.
    const mPath = join(pack, "ab-pack.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    const cPath = join(pack, "off", "run-config.json");
    const cfg = JSON.parse(readFileSync(cPath, "utf8")) as PilotConfig;
    const tampered = {
      ...cfg,
      pacing: { ...cfg.pacing, interTrialDelayS: cfg.pacing.interTrialDelayS + 1 },
    } as PilotConfig;
    writeFileSync(cPath, `${JSON.stringify(tampered, null, 2)}\n`);
    writeFileSync(
      join(pack, "off", "analysis-config.json"),
      `${JSON.stringify(analysisConfig(tampered, m.plannerModelId), null, 2)}\n`,
    );
    m.configSha256.off = configSha256(tampered);
    writeFileSync(mPath, JSON.stringify(m));
    expect(checkAbPack(pack, ROOT)).toEqual({
      ok: false,
      errors: ["the arms differ at pacing.interTrialDelayS (only corrections may differ)"],
      stage: 0,
    });
  });

  it("V11: a launch plan whose server env differs is refused, args identical", () => {
    const plan = (env: Record<string, string>) => ({
      argv: ["claude"],
      mcpConfigPath: "/x/mcp.json",
      mcpServers: { "myco-gate": { command: "node", args: ["gate.js"], env } },
    });
    expect(compareLaunchPlans(plan({}), plan({}))).toEqual([]);
    expect(compareLaunchPlans(plan({ MYCO_X: "1" }), plan({}))).toEqual([
      "server myco-gate differs beyond its args",
    ]);
    expect(compareLaunchPlans(plan({}), plan({ MYCO_X: "1" }))).toEqual([
      "server myco-gate differs beyond its args",
    ]);
    expect(compareLaunchPlans(plan({ MYCO_X: "1" }), plan({ MYCO_X: "2" }))).toEqual([
      "server myco-gate differs beyond its args",
    ]);
  });

  it("V12: a gate-VERIFIED trial the grader calls ungradable is a miss that halts", () => {
    const out = copy("myco-ab-gates-v12-");
    const armDir = join(stageRoot(out, 0), "on");
    const state = loadLedger(join(armDir, PROGRESS_FILE));
    const rec = [...state.byTask.values()].flat().find((r) => r.end?.armRow);
    if (rec?.end?.armRow === undefined || rec.end.armRow === null)
      throw new Error("no decided trial");
    const task = PUBLISHED.find((t) => t.taskId === rec.start.taskId);
    if (task === undefined) throw new Error("unknown task");
    const decided = {
      task,
      trialKey: rec.start.trialKey,
      armRow: {
        ...(rec.end.armRow as BenchmarkArmRow),
        gate: { ...(rec.end.armRow as BenchmarkArmRow).gate, verdict: "verified" },
      } as BenchmarkArmRow,
      persisted: readFileSync(join(armDir, "trials", rec.start.trialKey, "doc.csv")),
      resetBootClass: "cold" as const,
    };
    const real = bundleGrader(BUNDLE);
    const as =
      (status: "pass" | "ungradable" | "fail"): GradeFn =>
      (t, p, k) => ({ ...real(t, p, k), status });
    const ctx = (grader: GradeFn): HookContext => {
      const root = tmp("myco-ab-gates-v12-root-");
      mkdirSync(join(root, "on"), { recursive: true });
      return {
        stageRoot: root,
        armDir: join(root, "on"),
        stage: 0,
        arm: "on",
        grader,
        live: false,
        now: () => 0,
        load1m: () => 0,
      };
    };
    for (const status of ["ungradable", "fail"] as const) {
      const c = ctx(as(status));
      expect(recordDecided(c, decided), status).toMatch(
        new RegExp(
          `^HALTED: integrity incident, the gate VERIFIED ${decided.trialKey} and the independent grader says ${status}`,
        ),
      );
      const path = join(c.stageRoot, "incidents", `${incidentId(decided.trialKey)}.json`);
      expect(JSON.parse(readFileSync(path, "utf8")), status).toMatchObject({
        kind: "gate-miss",
        gateVerdict: "verified",
        graderStatus: status,
      });
      expect(
        incidentStatus(c.stageRoot).map((i) => i.acknowledged),
        status,
      ).toEqual([false]);
    }
    // A pass is no miss: no halt, no incident.
    const ok = ctx(as("pass"));
    expect(recordDecided(ok, decided)).toBeNull();
    expect(incidentStatus(ok.stageRoot)).toEqual([]);
  });
});

describe("#572 N1: a torn JSONL line is refused with an operator-readable code", () => {
  const torn = (out: string) => {
    const p = join(stageRoot(out, 0), "on", "grades.jsonl");
    const lines = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l !== "").length;
    writeFileSync(p, `${readFileSync(p, "utf8")}{"trialKey":"torn","sta`);
    return { p, line: lines + 1 };
  };

  it("export refuses with the code, the file and the line, and writes no pack", () => {
    const out = copy("myco-ab-gates-torn-export-");
    const { p, line } = torn(out);
    const e = refusal(() => exportAbPack(out, 0, join(out, "pack"), ROOT));
    expect(e.message).toBe(
      `${TORN_JSONL}: ${p} line ${line} is not a JSON record (a crash mid-append leaves a torn last line); nothing was changed: review the file, remove the partial line by hand, then re-run`,
    );
    expect(existsSync(join(out, "pack", "ab-pack.json"))).toBe(false);
  });

  it("a resume refuses with the code before any trial runs", async () => {
    const out = copy("myco-ab-gates-torn-resume-");
    const { p } = torn(out);
    const before = readFileSync(p, "utf8");
    const e = await run(out).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(AbRefusal);
    expect((e as Error).message).toMatch(new RegExp(`^${TORN_JSONL}: .*grades\\.jsonl line \\d+`));
    // Nothing repaired automatically.
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

describe("#572 N2: an interrupted atomic write's .tmp never goes into the pack", () => {
  it("export copies the incident records and acks, not the leftover .tmp", () => {
    const out = copy("myco-ab-gates-tmp-");
    const inc = join(stageRoot(out, 0), "incidents");
    mkdirSync(inc, { recursive: true });
    writeFileSync(join(inc, "incident-junk.json"), "{}\n");
    writeFileSync(join(inc, ".1700000000000-4242.tmp"), '{"schema":');
    const pack = join(out, "pack");
    const m = exportAbPack(out, 0, pack, ROOT);
    expect(readdirSync(join(pack, "incidents"))).toEqual(["incident-junk.json"]);
    expect(m.incidents.map((i) => i.id)).toEqual(["incident-junk"]);
  });
});

describe("#572 V8: export's pre-registration check is not redundant", () => {
  it("a header whose preregSha256 alone was edited is refused at export", () => {
    const out = copy("myco-ab-gates-v8-");
    const headerPath = join(stageRoot(out, 0), "ab-run.json");
    const header = JSON.parse(readFileSync(headerPath, "utf8"));
    const edited = "0".repeat(64);
    writeFileSync(headerPath, JSON.stringify({ ...header, preregSha256: edited }));
    const pack = join(out, "pack");
    expect(refusal(() => exportAbPack(out, 0, pack, ROOT)).message).toBe(
      `the run recorded pre-registration ${edited}, the committed one is ${LOADED.markdownSha256}: refused`,
    );
    expect(existsSync(join(pack, "ab-pack.json"))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  });
});
