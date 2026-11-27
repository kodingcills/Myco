/**
 * Capability track V: the v-v1 pre-registration (Part 1 §3) is complete and self-consistent.
 * Every digest it pins is recomputed here (the bar section, the orch-v1 manifest, each
 * analysis file); its pre-registration hash is pinned; a drift in any pinned input refuses the
 * load; its limits parse as the orchestrator's limits; its estimate prices are the frozen
 * rates; and the CLI analyses a pack under it and refuses a mismatched or simulated one.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseLimits } from "../../src/orchestrate/limits.ts";
import { V_BAR, type VBarRow } from "../../src/orchestrate/v-bar.ts";
import {
  barSectionOf,
  loadVPrereg,
  preregHashOf,
  V_PREREG_PATH,
  type VPreregFile,
} from "../../src/orchestrate/v-prereg.ts";
import { FROZEN_RATES_MICROS } from "../../src/pilot/cost.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sha256 = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const raw = readFileSync(join(ROOT, V_PREREG_PATH), "utf8");
const prereg = JSON.parse(raw) as VPreregFile & Record<string, unknown>;

/** The v-v1 pre-registration hash. Packs record it; it changes only with a new version. */
const V_V1_PREREG_HASH = "db638dc124d1e1600c18f938fca4d5c2f843a86550d0ec0f5991eab7c0d6229f";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** A throwaway copy of every file the pre-registration reads, to mutate one at a time. */
function copyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "v-prereg-"));
  temps.push(dir);
  const paths = [
    V_PREREG_PATH,
    prereg.bar.spec,
    ...prereg.analysis.map((a) => a.path),
    `${prereg.taskSet.path}/manifest.json`,
    `${prereg.taskSet.path}/tasks.jsonl`,
  ];
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    cpSync(join(ROOT, p), join(dir, p));
  }
  return dir;
}

describe("v-v1 pre-registration content (Part 1 §3.1)", () => {
  it("holds the bar, task set + manifest SHA-256, seeds, step budget, model id and analysis files", () => {
    for (const key of [
      "bar",
      "taskSet",
      "seeds",
      "stepBudget",
      "modelId",
      "analysis",
      "test",
      "limits",
    ])
      expect(prereg[key], key).toBeDefined();
    expect(prereg.track).toBe(V_BAR.track);
    expect(prereg.version).toBe(V_BAR.version);
    expect(prereg.taskSet.version).toBe(V_BAR.taskSet);
    expect(prereg.taskSet.tasks).toBe(V_BAR.tasks);
    expect(prereg.test).toMatchObject({
      alpha: V_BAR.alpha,
      minDiscordant: V_BAR.minDiscordant,
      sided: expect.stringMatching(/^one-sided/),
    });
    expect(prereg.arms).toMatchObject({ primary: "V vs H" });
  });

  it("the bar digest is spec-2's V section as committed", () => {
    const section = barSectionOf(readFileSync(join(ROOT, prereg.bar.spec), "utf8"));
    expect(section).not.toBeNull();
    expect(section?.startsWith("### V. Recursive orchestration\n")).toBe(true);
    expect(section).toContain("**Pre-registered bar (fixed sequence).**");
    expect(section).not.toContain("## 3. Data capture");
    expect(sha256(section as string)).toBe(prereg.bar.sectionSha256);
  });

  it("the task set digest is sha256(manifest.json) of the committed orch-v1 bundle", () => {
    const manifest = readFileSync(join(ROOT, prereg.taskSet.path, "manifest.json"));
    expect(sha256(manifest)).toBe(prereg.taskSet.manifestSha256);
  });

  it("every analysis file hashes to its pinned SHA-256", () => {
    expect(prereg.analysis.map((a) => a.path).sort()).toEqual([
      "scripts/orch-v-bar.ts",
      "src/orchestrate/v-bar.ts",
      "src/orchestrate/v-prereg.ts",
    ]);
    for (const a of prereg.analysis)
      expect(sha256(readFileSync(join(ROOT, a.path))), a.path).toBe(a.sha256);
  });

  it("the limits parse as myco.orchestrate.limits/v1 and the estimate prices are the frozen model rates", () => {
    const limits = parseLimits(prereg.limits);
    const rate = FROZEN_RATES_MICROS[prereg.modelId];
    expect(rate).toBeDefined();
    expect(limits.estimateMicroUsdPerMInputTokens).toBe((rate?.input ?? 0) * 1_000_000);
    expect(limits.estimateMicroUsdPerMOutputTokens).toBe((rate?.output ?? 0) * 1_000_000);
    // The cost ceiling covers the whole token budget at the dearer price (the budget binds first).
    expect(limits.maxEstimatedCostMicroUsd).toBeGreaterThanOrEqual(
      (limits.maxTotalTokens * limits.estimateMicroUsdPerMOutputTokens) / 1_000_000,
    );
    // The concurrency cap admits one desktop per part of the largest task.
    expect(limits.maxConcurrentDesktops).toBeGreaterThanOrEqual(4);
  });

  it("does not claim ratification and lists the values pending a lead ruling", () => {
    expect(String(prereg.ratification)).toMatch(/^not ratified/);
    const pending = (prereg.proposedPendingLeadRuling as string[]).join("\n");
    for (const key of [
      "test.sided",
      "kill-switch latency",
      "maxDepth",
      "maxConcurrentDesktops",
      "stepBudget",
      "modelId",
    ])
      expect(pending).toContain(key);
  });

  it("the pre-registration hash is SHA-256 over canonical JSON, independent of key order and whitespace", () => {
    const hash = preregHashOf(prereg);
    expect(hash).toBe(V_V1_PREREG_HASH);
    const reordered = Object.fromEntries(Object.entries(prereg).reverse());
    expect(preregHashOf(reordered)).toBe(hash);
    expect(preregHashOf({ ...prereg, modelId: "claude-opus-5-5" })).not.toBe(hash);
  });
});

describe("loadVPrereg fails closed on drift", () => {
  it("loads the committed pre-registration with 60 tasks and their parts", () => {
    const loaded = loadVPrereg(ROOT);
    expect(loaded.preregHash).toBe(V_V1_PREREG_HASH);
    expect(loaded.tasks.size).toBe(60);
    expect(loaded.tasks.get("orch-v1-060")).toEqual([1, 2, 3, 4].map((k) => `orch-v1-060-p${k}`));
  });

  it.each([
    ["an analysis file", "src/orchestrate/v-bar.ts", /analysis file differs.*v-bar\.ts/],
    ["the CLI", "scripts/orch-v-bar.ts", /analysis file differs.*orch-v-bar\.ts/],
    ["the manifest", "benchmark/orchestration/orch-v1/manifest.json", /manifest differs/],
    ["tasks.jsonl", "benchmark/orchestration/orch-v1/tasks.jsonl", /tasks\.jsonl differs/],
  ])("refuses when %s changes", (_what, path, message) => {
    const dir = copyRoot();
    writeFileSync(join(dir, path), `${readFileSync(join(dir, path), "utf8")} `);
    expect(() => loadVPrereg(dir)).toThrow(message);
  });

  it("refuses when the V section of the spec changes (a change is a new version)", () => {
    const dir = copyRoot();
    const p = join(dir, prereg.bar.spec);
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "`V` better than `H` on verified, p ≤ 0.05",
        "`V` better than `H` on verified, p ≤ 0.10",
      ),
    );
    expect(() => loadVPrereg(dir)).toThrow(/bar section differs/);
  });

  it("does not refuse when another section of the spec changes", () => {
    const dir = copyRoot();
    const p = join(dir, prereg.bar.spec);
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "### U. Linux scale track",
        "### U. Linux scale track (edited)",
      ),
    );
    expect(loadVPrereg(dir).preregHash).toBe(V_V1_PREREG_HASH);
  });
});

describe("scripts/orch-v-bar.ts", () => {
  const loaded = loadVPrereg(ROOT);
  const ids = [...loaded.tasks.keys()];
  const controls = {
    tokensUsed: 1000,
    costEstimateMicroUsd: 100,
    wallMs: 1000,
    maxDepthObserved: 1,
    maxConcurrentObserved: 1,
    maxSpawnsByOnePlanner: 2,
    totalSpawns: 2,
    unmetered: false,
    spawnsAdmittedAfterUnmetered: 0,
    killed: false,
    spawnsAdmittedAfterKill: 0,
    killLatencyMs: null,
    orphanedDesktops: 0,
    orphanedWorkerTrials: 0,
    openLedgerAttempts: 0,
    ledgerWriteFailed: false,
    haltedOnLedgerFailure: false,
    workerTrials: 2,
    ledgerWorkerAttempts: 2,
  };
  const rows = (simulated: boolean): VBarRow[] =>
    (["V", "H", "C1"] as const).flatMap((arm) =>
      ids.map((taskId, i) => {
        const ok = arm === "V" ? i < 30 : i < 20;
        return {
          arm,
          taskId,
          simulated,
          modelId: prereg.modelId,
          claim: ok ? ("done" as const) : ("not-done" as const),
          parts: (loaded.tasks.get(taskId) ?? []).map((partId) => ({
            partId,
            grade: ok ? ("pass" as const) : ("fail" as const),
            ...(arm === "V"
              ? { gateVerdict: ok ? ("verified" as const) : ("refuted" as const) }
              : {}),
          })),
          costEstimateMicroUsd: 100,
          wallMs: 1000,
          ...(arm === "V" ? { controls } : {}),
        };
      }),
    );
  const run = (pack: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "v-pack-"));
    temps.push(dir);
    const path = join(dir, "pack.json");
    writeFileSync(path, JSON.stringify(pack));
    return spawnSync("npx", ["tsx", "scripts/orch-v-bar.ts", "--pack", path], {
      cwd: ROOT,
      encoding: "utf8",
    });
  };

  it("analyses a pack that records the hash: exit 0, decision printed", { timeout: 60_000 }, () => {
    const r = run({ preregHash: V_V1_PREREG_HASH, rows: rows(false) });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { decision: string; preregHash: string };
    expect(out.preregHash).toBe(V_V1_PREREG_HASH);
    expect(out.decision).toBe("shown");
  });

  it("refuses a pack with another hash, and a simulated pack: exit 2", { timeout: 60_000 }, () => {
    const wrong = run({ preregHash: "0".repeat(64), rows: rows(false) });
    expect(wrong.status).toBe(2);
    expect(JSON.parse(wrong.stdout).reasons).toContain("PREREG_HASH_MISMATCH");
    const simulated = run({ preregHash: V_V1_PREREG_HASH, rows: rows(true) });
    expect(simulated.status).toBe(2);
    expect(JSON.parse(simulated.stdout).decision).toBe("refused");
  });
});
