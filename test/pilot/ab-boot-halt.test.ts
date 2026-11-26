/**
 * #549 verdict S1: the boot-class halt is sticky, and a live A/B pack refuses any trial whose
 * reset is not a recorded cold boot (`src/pilot/ab.ts`). The pre-registration says such a trial
 * "halts the run" (`docs/benchmark/corrections-ab-prereg.md`, "Harness faults, ledger,
 * resets"); these tests hold the code to that text.
 *
 * Fake transports only: every run here is the simulated dry run, and "live" is exercised at the
 * hook level (`HookContext.live`) exactly as the runner's per-trial hook sees it. No model, no
 * `claude` process, no VM, $0.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import {
  AB_DRY_RUN_PLANNER,
  type AbArm,
  abFakeDriver,
  ackIncident,
  assertNoPendingIncidents,
  bootIncidentId,
  bundleGrader,
  checkAbPack,
  exportAbPack,
  type HookContext,
  incidentStatus,
  loadPrereg,
  type RecordStep,
  reconcileGrades,
  recordDecided,
  runAbStage,
  stageRoot,
} from "../../src/pilot/ab.ts";
import { fakeDriver, virtualClock } from "../../src/pilot/dry-run.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { PUBLISHED, ROOT, SOURCES, tmp } from "./helpers.ts";

const LOADED = loadPrereg(ROOT);
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");

class Crash extends Error {}

function run(
  outRoot: string,
  extra: { maxChunks?: number; crashPoint?: (step: RecordStep, trialKey: string) => void } = {},
) {
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
    maxChunks: extra.maxChunks ?? Number.POSITIVE_INFINITY,
    sleep: clock.sleep,
    now: clock.now,
    load1m: () => 0.25,
    ...(extra.crashPoint === undefined ? {} : { crashPoint: extra.crashPoint }),
  });
}

const liveCtx = (
  root: string,
  arm: AbArm,
  crashPoint?: (step: RecordStep, key: string) => void,
): HookContext => ({
  stageRoot: root,
  armDir: join(root, arm),
  stage: 0,
  arm,
  grader: bundleGrader(BUNDLE),
  live: true,
  now: () => 0,
  load1m: () => 0,
  ...(crashPoint === undefined ? {} : { crashPoint }),
});

/**
 * A stage-0 run directory holding exactly one decided trial that the runner never recorded
 * (it died at `graded`, before any record): the state the live hook starts from.
 */
async function oneDecidedTrial(prefix: string) {
  const out = tmp(prefix);
  let key: string | null = null;
  await expect(
    run(out, {
      crashPoint: (s, k) => {
        if (s === "graded" && key === null) {
          key = k;
          throw new Crash("crash before any record");
        }
      },
    }),
  ).rejects.toThrow(Crash);
  const root = stageRoot(out, 0);
  for (const arm of ["on", "off"] as const) {
    const state = loadLedger(join(root, arm, PROGRESS_FILE));
    for (const list of state.byTask.values())
      for (const rec of list)
        if (rec.start.trialKey === key && rec.end?.armRow) {
          const task = PUBLISHED.find((t) => t.taskId === rec.start.taskId);
          if (task === undefined) throw new Error("unknown task");
          const doc = join(root, arm, "trials", rec.start.trialKey, "doc.csv");
          return {
            out,
            root,
            arm,
            key: rec.start.trialKey,
            decided: {
              task,
              trialKey: rec.start.trialKey,
              armRow: rec.end.armRow as BenchmarkArmRow,
              persisted: readFileSync(doc),
            },
          };
        }
  }
  throw new Error("no decided trial");
}

const ackFiles = (root: string) => {
  try {
    return readdirSync(join(root, "incidents")).filter((f) => f.endsWith(".ack.json"));
  } catch {
    return [];
  }
};

const ack = (root: string, id: string) => {
  const st = incidentStatus(root).find((i) => i.id === id);
  if (st === undefined) throw new Error(`no incident ${id}`);
  ackIncident(root, id, {
    operator: "test operator",
    statement: "reviewed the boot-class record in full",
    incidentSha256: st.sha256,
  });
};

const CRASH_POINTS = ["before-hook", "graded", "incident", "trial-record", "grade"] as const;

describe("a live non-cold reset is a sticky halt (crash-safe, ack-only)", () => {
  for (const at of CRASH_POINTS)
    for (const cls of ["fast", null] as const)
      it(`crash at ${at} after a ${cls ?? "null"} reset: every resume halts until an operator ack`, {
        timeout: 60_000,
      }, async () => {
        const t = await oneDecidedTrial(`myco-ab-boot-${at}-`);
        if (at !== "before-hook") {
          const ctx = liveCtx(t.root, t.arm, (s) => {
            if (s === at) throw new Crash(`crash at ${s}`);
          });
          expect(() => recordDecided(ctx, { ...t.decided, resetBootClass: cls })).toThrow(Crash);
          // Written before the run proceeds: from the incident step on, the record is on disk.
          const onDisk = incidentStatus(t.root).some((i) => i.id === bootIncidentId(t.key));
          expect(onDisk).toBe(at !== "graded");
        }
        for (let i = 0; i < 3; i++) {
          expect(reconcileGrades(liveCtx(t.root, t.arm), PUBLISHED)).toMatch(
            new RegExp(
              `${t.key}'s reset boot class is (fast|unrecorded), not a recorded cold boot`,
            ),
          );
          expect(() => assertNoPendingIncidents(t.root)).toThrow(/unacknowledged integrity/);
        }
        // Never automatic: no ack file appeared, and exactly one unacknowledged boot record.
        expect(ackFiles(t.root)).toEqual([]);
        const pending = incidentStatus(t.root).filter((i) => !i.acknowledged);
        expect(pending.map((i) => i.id)).toEqual([bootIncidentId(t.key)]);
        const rec = JSON.parse(readFileSync(pending[0]?.path as string, "utf8"));
        expect(rec).toMatchObject({ kind: "boot-class", arm: t.arm, stage: 0, trialKey: t.key });
        expect(rec.resetBootClass).not.toBe("cold");
        // Only the operator's ack clears it.
        ack(t.root, bootIncidentId(t.key));
        expect(reconcileGrades(liveCtx(t.root, t.arm), PUBLISHED)).toBeNull();
        expect(() => assertNoPendingIncidents(t.root)).not.toThrow();
      });

  it("a graded trial's boot class is re-derived from ab-trials.jsonl on resume", {
    timeout: 60_000,
  }, async () => {
    const t = await oneDecidedTrial("myco-ab-boot-rederive-");
    // Fully recorded as fast, then the incident file is lost: the resume writes it again.
    expect(recordDecided(liveCtx(t.root, t.arm), { ...t.decided, resetBootClass: "fast" })).toMatch(
      /boot class is fast/,
    );
    rmSync(join(t.root, "incidents"), { recursive: true });
    expect(reconcileGrades(liveCtx(t.root, t.arm), PUBLISHED)).toMatch(/boot class is fast/);
    expect(incidentStatus(t.root).map((i) => [i.id, i.acknowledged])).toEqual([
      [bootIncidentId(t.key), false],
    ]);
    // A graded trial with no ab-trials.jsonl record at all is unrecorded: it halts too.
    const t2 = await oneDecidedTrial("myco-ab-boot-norecord-");
    expect(
      recordDecided(liveCtx(t2.root, t2.arm), { ...t2.decided, resetBootClass: "cold" }),
    ).toBeNull();
    writeFileSync(join(t2.root, t2.arm, "ab-trials.jsonl"), "");
    expect(reconcileGrades(liveCtx(t2.root, t2.arm), PUBLISHED)).toMatch(
      /boot class is unrecorded/,
    );
    // An unknown value is not cold.
    const t3 = await oneDecidedTrial("myco-ab-boot-unknown-");
    expect(
      recordDecided(liveCtx(t3.root, t3.arm), { ...t3.decided, resetBootClass: "cold" }),
    ).toBeNull();
    const p = join(t3.root, t3.arm, "ab-trials.jsonl");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace('"resetBootClass":"cold"', '"resetBootClass":"warm"'),
    );
    expect(reconcileGrades(liveCtx(t3.root, t3.arm), PUBLISHED)).toMatch(/boot class is warm/);
    // A cold boot recorded live is not an incident; a simulated (non-live) context never is.
    const t4 = await oneDecidedTrial("myco-ab-boot-cold-");
    expect(
      recordDecided(liveCtx(t4.root, t4.arm), { ...t4.decided, resetBootClass: "cold" }),
    ).toBeNull();
    expect(reconcileGrades(liveCtx(t4.root, t4.arm), PUBLISHED)).toBeNull();
    expect(incidentStatus(t4.root)).toEqual([]);
  });

  it("a stale ack (wrong sha) or a record for another arm does not clear the halt", {
    timeout: 60_000,
  }, async () => {
    const t = await oneDecidedTrial("myco-ab-boot-stale-");
    expect(recordDecided(liveCtx(t.root, t.arm), { ...t.decided, resetBootClass: "fast" })).toMatch(
      /HALTED/,
    );
    const id = bootIncidentId(t.key);
    writeFileSync(
      join(t.root, "incidents", `${id}.ack.json`),
      JSON.stringify({
        schema: "myco.pilot.ab-incident-ack/1",
        incidentSha256: "0".repeat(64),
        operator: "x",
        statement: "reviewed the record in full",
      }),
    );
    expect(reconcileGrades(liveCtx(t.root, t.arm), PUBLISHED)).toMatch(/HALTED/);
    // The record rewritten to name the other arm: never this trial's valid record, never cleared.
    const path = join(t.root, "incidents", `${id}.json`);
    const rec = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...rec, arm: t.arm === "on" ? "off" : "on" }));
    rmSync(join(t.root, "incidents", `${id}.ack.json`));
    ack(t.root, id);
    expect(incidentStatus(t.root)[0]?.acknowledged).toBe(true);
    expect(reconcileGrades(liveCtx(t.root, t.arm), PUBLISHED)).toMatch(/HALTED/);
  });

  it("the runner itself refuses to resume over an unacknowledged boot-class record", {
    timeout: 60_000,
  }, async () => {
    const t = await oneDecidedTrial("myco-ab-boot-runner-");
    recordDecided(liveCtx(t.root, t.arm), { ...t.decided, resetBootClass: "fast" });
    for (let i = 0; i < 2; i++)
      await expect(run(t.out)).rejects.toThrow(/unacknowledged integrity/);
    ack(t.root, bootIncidentId(t.key));
    await expect(run(t.out, { maxChunks: 1 })).resolves.toMatchObject({ status: "paused" });
  });
});

describe("a live pack refuses any reset that is not a recorded cold boot", () => {
  const exported = async (prefix: string) => {
    const out = tmp(prefix);
    await expect(run(out)).resolves.toMatchObject({ status: "complete" });
    return out;
  };
  const setBoot = (file: string, edit: (lines: Record<string, unknown>[]) => void) => {
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    edit(lines);
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  };
  const variants: readonly [string, (lines: Record<string, unknown>[]) => void][] = [
    ["fast", (l) => Object.assign(l[0] as object, { resetBootClass: "fast" })],
    ["null", (l) => Object.assign(l[0] as object, { resetBootClass: null })],
    ["missing field", (l) => delete (l[0] as Record<string, unknown>).resetBootClass],
    ["unknown value", (l) => Object.assign(l[0] as object, { resetBootClass: "warm" })],
    ["missing record", (l) => l.splice(0, 1)],
    ["a second, fast record", (l) => l.push({ ...(l[0] as object), resetBootClass: "fast" })],
  ];

  it("export refuses a live run with a non-cold boot; a simulated run is unaffected", {
    timeout: 120_000,
  }, async () => {
    const out = await exported("myco-ab-boot-export-");
    const root = stageRoot(out, 0);
    const header = join(root, "ab-run.json");
    const live = JSON.parse(readFileSync(header, "utf8"));
    const trials = join(root, "on", "ab-trials.jsonl");
    const original = readFileSync(trials, "utf8");
    for (const [name, edit] of variants) {
      writeFileSync(trials, original);
      setBoot(trials, edit);
      // Simulated: the boot class is the fake's, and the pack exports as before.
      writeFileSync(header, JSON.stringify({ ...live, simulated: true }));
      expect(() => exportAbPack(out, 0, join(out, `sim-${name}`), ROOT), name).not.toThrow();
      writeFileSync(header, JSON.stringify({ ...live, simulated: false }));
      expect(() => exportAbPack(out, 0, join(out, `live-${name}`), ROOT), name).toThrow(
        /a live pack needs every trial's reset to be a recorded cold boot/,
      );
    }
    writeFileSync(trials, original);
    expect(() => exportAbPack(out, 0, join(out, "live-cold"), ROOT)).not.toThrow();
  });

  it("check-pack refuses a live pack with a non-cold boot; a simulated pack is unaffected", {
    timeout: 120_000,
  }, async () => {
    const out = await exported("myco-ab-boot-check-");
    const pack = join(out, "pack");
    exportAbPack(out, 0, pack, ROOT);
    const mPath = join(pack, "ab-pack.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    const trials = join(pack, "off", "ab-trials.jsonl");
    const original = readFileSync(trials, "utf8");
    expect(checkAbPack(pack, ROOT)).toMatchObject({ ok: true });
    for (const [name, edit] of variants) {
      writeFileSync(trials, original);
      setBoot(trials, edit);
      writeFileSync(mPath, JSON.stringify(m));
      expect(checkAbPack(pack, ROOT).ok, `simulated ${name}`).toBe(true);
      for (const liveManifest of [
        { ...m, simulated: false },
        Object.fromEntries(Object.entries(m).filter(([k]) => k !== "simulated")),
      ]) {
        writeFileSync(mPath, JSON.stringify(liveManifest));
        const r = checkAbPack(pack, ROOT);
        expect(r.ok, `live ${name}`).toBe(false);
        expect(r.errors.join("\n")).toMatch(
          /off: .*(not a recorded cold boot|unrecorded).*a live pack needs every reset to be a recorded cold boot/,
        );
      }
    }
    // All cold: the same pack, marked live, passes the boot check.
    writeFileSync(trials, original);
    writeFileSync(mPath, JSON.stringify({ ...m, simulated: false }));
    expect(checkAbPack(pack, ROOT)).toMatchObject({ ok: true });
  });
});
