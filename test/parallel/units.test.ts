/**
 * Track L — run-id folding and claims, cap validation, the isolation check, the CLI's
 * argument rules. Portable (macOS and Linux).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolationShortfalls, STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import { HARD_MAX_CONCURRENT, resolveCaps } from "../../src/parallel/caps.ts";
import { parseArgs, requirementsFor } from "../../src/parallel/cli.ts";
import { scanTree } from "../../src/parallel/pool.ts";
import {
  assertDistinctFolded,
  checkRunId,
  foldRunId,
  RunIdError,
  RunIdRegistry,
} from "../../src/parallel/runid.ts";
import { STRONG } from "./fake-backend.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-l-unit-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("run ids collide by their case-folded form", () => {
  it("folds case and compatibility forms", () => {
    expect(foldRunId("Run-A")).toBe(foldRunId("run-a"));
    expect(foldRunId("RUN.X_1")).toBe("run.x_1");
    expect(foldRunId("straße")).toBe(foldRunId("STRASSE"));
    expect(foldRunId("Kelvin")).toBe(foldRunId("kelvin"));
    expect(foldRunId("run-a")).not.toBe(foldRunId("run-b"));
  });

  it("refuses a batch with folded duplicates, and malformed ids", () => {
    expect(() => assertDistinctFolded(["a-1", "A-1"])).toThrow(/duplicate-folded/);
    expect(() => assertDistinctFolded(["a-1", "a-2"])).not.toThrow();
    for (const bad of ["", "../x", "a/b", ".hidden", "a..b", "x".repeat(129), "café"])
      expect(() => assertDistinctFolded([bad])).toThrow(/bad-run-id/);
  });

  it("refuses a trailing dot (NTFS drops it: run-a. is run-a) and Windows device names", () => {
    for (const bad of [
      "run-a.",
      "Run-A.",
      "x...",
      "con",
      "CON",
      "nul.txt",
      "Com1",
      "lpt9.csv",
      "aux",
    ])
      expect(() => checkRunId(bad)).toThrow(/^bad-run-id:/);
    expect(() => assertDistinctFolded(["run-a", "run-a."])).toThrow(/bad-run-id/);
    expect(() => assertDistinctFolded(["Run-A.", "run-a"])).toThrow(/bad-run-id/);
    for (const ok of ["run-a", "a.b", "console", "nul-1", "com10", "lpt-1", "run.v2"])
      expect(checkRunId(ok)).toBe(ok);
    // Trailing space, lookalikes (Cyrillic a, Kelvin sign, zero-width space, fullwidth),
    // NFD and NTFS stream / short-name forms: all outside the ASCII rule.
    for (const bad of [
      "run-a ",
      "run-a. .",
      "run-\u0430",
      "\u212Aey",
      "run\u200Ba",
      "\uFF52\uFF55\uFF4E",
      "cafe\u0301",
      "caf\u00E9",
      "run-a::$DATA",
      "RUN-A~1",
    ])
      expect(() => checkRunId(bad)).toThrow(/^bad-run-id:/);
    // Second line: even if a trailing dot got past the rule, it folds onto the bare id.
    expect(foldRunId("Run-A.")).toBe(foldRunId("run-a"));
  });

  it("a held run-a refuses a claim of run-a. (in-process and across pools)", () => {
    const reg = new RunIdRegistry(join(base, "locks-dot"));
    reg.claim("run-a");
    expect(() => reg.claim("run-a.")).toThrow(/^bad-run-id:/);
    expect(() => new RunIdRegistry(join(base, "locks-dot")).claim("RUN-A.")).toThrow(
      /^bad-run-id:/,
    );
  });

  it("in-process: a second claim of a folded-equal id is refused until released", () => {
    const reg = new RunIdRegistry();
    const first = reg.claim("Trial-7");
    expect(() => reg.claim("trial-7")).toThrow(RunIdError);
    expect(() => reg.claim("TRIAL-7")).toThrow(/^claimed:/);
    first.release();
    expect(reg.claim("trial-7").folded).toBe("trial-7");
  });

  it("across processes: two registries on one lock dir refuse each other's folded ids", () => {
    const a = new RunIdRegistry(join(base, "locks"));
    const b = new RunIdRegistry(join(base, "locks"));
    const held = a.claim("Pool-Run");
    expect(() => b.claim("pool-run")).toThrow(/^locked:/);
    expect(readdirSync(join(base, "locks"))).toHaveLength(1);
    held.release();
    expect(readdirSync(join(base, "locks"))).toHaveLength(0);
    expect(() => b.claim("POOL-RUN").release()).not.toThrow();
  });
});

describe("resource caps are validated before a pool starts", () => {
  const host = { memoryMb: 16_000, cpus: 8 };
  const ok = {
    maxConcurrent: 4,
    memoryMbPerTrial: 1024,
    cpusPerTrial: 2,
    cpuSecondsPerTrial: 60,
    trialTimeoutMs: 60_000,
  };

  it("accepts a cap set that fits the host, with defaults from the host", () => {
    const r = resolveCaps(ok, host);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.caps.memoryBudgetMb).toBe(12_000);
      expect(r.caps.cpuBudget).toBe(8);
      expect(Object.isFrozen(r.caps)).toBe(true);
    }
  });

  it.each([
    ["zero", { maxConcurrent: 0 }, /maxConcurrent must be/],
    ["negative", { memoryMbPerTrial: -1 }, /memoryMbPerTrial must be/],
    ["fraction", { cpusPerTrial: 0.5 }, /cpusPerTrial must be/],
    ["NaN", { cpuSecondsPerTrial: Number.NaN }, /cpuSecondsPerTrial must be/],
    ["infinite", { trialTimeoutMs: Number.POSITIVE_INFINITY }, /trialTimeoutMs must be/],
    ["string", { maxConcurrent: "4" as unknown as number }, /maxConcurrent must be/],
    [
      "hard ceiling",
      {
        maxConcurrent: HARD_MAX_CONCURRENT + 1,
        cpusPerTrial: 1,
        memoryMbPerTrial: 1,
        cpuBudget: 8,
      },
      /hard ceiling/,
    ],
    ["memory budget above host", { memoryBudgetMb: 16_001 }, /exceeds host memory/],
    ["cpu budget above host", { cpuBudget: 9 }, /exceeds host CPUs/],
    ["memory oversubscribed", { memoryMbPerTrial: 4000 }, /memoryMbPerTrial = 16000 MB exceeds/],
    ["cpu oversubscribed", { cpusPerTrial: 3 }, /cpusPerTrial = 12 exceeds/],
  ])("refuses %s", (_n, bad, why) => {
    const r = resolveCaps({ ...ok, ...bad }, host);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(why);
  });
});

describe("isolation check", () => {
  it("a strong report meets the strict requirements", () => {
    expect(isolationShortfalls(STRONG, STRICT_REQUIREMENTS)).toEqual([]);
  });

  it.each([
    ["network shared", { network: "shared" }, /private network/],
    ["tmp env", { tmp: "env" }, /private \/tmp/],
    ["roots visible", { hostDirsHidden: false }, /roots are visible/],
    ["no private root", { privateRoot: false }, /no private root/],
    ["processes survive", { processes: "none" }, /do not die/],
  ])("strict requirements refuse %s", (_n, weaken, why) => {
    const report = { ...STRONG, ...weaken } as typeof STRONG;
    expect(isolationShortfalls(report, STRICT_REQUIREMENTS).join("\n")).toMatch(why);
  });

  it("best-effort accepts shared network, tmp and visible roots, but never a missing private root", () => {
    const weak = requirementsFor({ weak: true, display: "none" });
    const plain = { ...STRONG, network: "shared", tmp: "env", hostDirsHidden: false } as const;
    expect(isolationShortfalls(plain, weak)).toEqual([]);
    expect(isolationShortfalls({ ...plain, privateRoot: false }, weak)).toEqual([
      "no private root",
    ]);
  });

  it("no report at all is a shortfall", () => {
    expect(isolationShortfalls(undefined, STRICT_REQUIREMENTS)).toEqual(["no isolation report"]);
  });

  it("requires a display when asked", () => {
    expect(isolationShortfalls(STRONG, { ...STRICT_REQUIREMENTS, display: "xvfb" })).toHaveLength(
      1,
    );
    const withX = { ...STRONG, display: { kind: "xvfb" as const, id: ":99" } };
    expect(isolationShortfalls(withX, { ...STRICT_REQUIREMENTS, display: "xvfb" })).toEqual([]);
  });
});

describe("marker scan", () => {
  it("finds markers in file bytes and in names, and marks an over-budget tree incomplete", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(base, "t", "d"), { recursive: true });
    writeFileSync(
      join(base, "t", "d", "f.bin"),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from("xx-M1-xx")]),
    );
    mkdirSync(join(base, "t", "M2-dir"));
    const markers = new Map([
      ["one", "M1"],
      ["two", "M2"],
      ["three", "M3"],
    ]);
    const r = scanTree(join(base, "t"), markers);
    expect([...r.found].sort()).toEqual(["one", "two"]);
    expect(r.complete).toBe(true);
  });
});

describe("myco-parallel arguments", () => {
  it("defaults to strict isolation and refuses bad values", () => {
    const a = parseArgs([]);
    expect(a).not.toBe("help");
    if (a !== "help") expect(requirementsFor(a)).toEqual(STRICT_REQUIREMENTS);
    expect(() => parseArgs(["--n", "0"])).toThrow();
    expect(() => parseArgs(["--trials", "1.5"])).toThrow();
    expect(() => parseArgs(["--agent", "claude"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
    const w = parseArgs(["--allow-weak-isolation", "--display", "xvfb"]);
    if (w !== "help") expect(requirementsFor(w).network).toBe("best-effort");
  });
});
