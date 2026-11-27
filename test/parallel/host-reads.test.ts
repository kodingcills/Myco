/**
 * #541 R3-1: no host read an agent can reach on `linux-plain` may block the pool.
 *
 * The round-3 verifier froze the whole pool (0 heartbeats, SIGKILL at 40 s) by replacing an
 * oracle source with a FIFO: the vault read it with a plain blocking `readFileSync`. The
 * vault's sealed files and manifests had the same lstat-then-blocking-read pattern.
 *
 * Linux only (the child uses `setsid` and GNU `stat`). Every case that could hang runs in a child (`host-read-child.ts`) under a hard SIGKILL
 * limit, with an honest sibling trial and a heartbeat timer; a regression is a killed child
 * (a test failure), never a frozen test run. Each guard's mutant is listed in the PR's
 * round-1 comment with the test that kills it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRegularNoBlock } from "../../src/integrity/nonblocking-read.ts";
import { type ScriptedDesktopAgent, scriptedFileAgent } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import {
  type OracleSnapshot,
  runPool,
  SCAN_LIMIT_BYTES,
  sealMatchesSnapshot,
} from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES, L_TASK_ID, lTaskRegistry } from "../../src/parallel/throughput.ts";
import { fakeBackend } from "./fake-backend.ts";

const TSX = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
const CHILD = join(import.meta.dirname, "host-read-child.ts");
const HARD_LIMIT_MS = 30_000;
/** Longest the child's event loop may go without a heartbeat (a hang is unbounded). */
const MAX_GAP_MS = 5_000;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mhr-"));
});
afterEach(() => {
  // A race daemon exits when its stop file appears, even if its child was killed.
  for (const stop of ["stop", "stop-race"]) {
    try {
      writeFileSync(join(base, stop), "");
    } catch {
      // base already gone
    }
  }
  rmSync(base, { recursive: true, force: true });
});

interface TrialOut {
  disqualifiers: string[];
  counted: boolean;
  verdict: string | null;
  reasons: string[];
  error: string | null;
}
interface ChildOut {
  trials?: Record<string, TrialOut>;
  refused?: string[] | null;
  plantedKind?: string | null;
  codes?: string[];
  iterations?: number;
  heartbeat: { beats: number; maxGapMs: number };
}

function child(args: readonly string[]): ChildOut {
  const r = spawnSync(TSX, [CHILD, ...args], {
    encoding: "utf8",
    timeout: HARD_LIMIT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `child did not finish (status ${String(r.status)}, signal ${String(r.signal)}): ${r.stderr}`,
    );
  const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as ChildOut;
  expect(out.heartbeat.maxGapMs).toBeLessThan(MAX_GAP_MS);
  return out;
}

const oracle = (where: string, index: number, kind: string, concurrency: number) =>
  child([
    "oracle",
    join(base, "r"),
    join(base, "src"),
    where,
    String(index),
    kind,
    String(concurrency),
  ]);

const INDEXES = CALC_ORACLE_SOURCES.map((_, i) => i);
const KINDS = [
  ["fifo", "fifo"],
  ["zero", "symlink"],
] as const;
const cases = INDEXES.flatMap((i) => KINDS.map(([kind, planted]) => [i, kind, planted] as const));

describe.skipIf(process.platform !== "linux")(
  "R3-1: an oracle source replaced by the agent cannot hang the pool",
  () => {
    it.each(cases)(
      "source %i replaced (%s) before the pool: refused at once with a code, nothing runs",
      (i, kind, planted) => {
        const out = oracle("before", i, kind, 2);
        expect(out.plantedKind).toBe(planted);
        expect(out.refused).toHaveLength(1);
        expect(out.refused?.[0]).toMatch(new RegExp(`${i}-[a-z-]+\\.ts": not-regular$`));
        expect(out.trials).toEqual({});
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each(cases)(
      "source %i replaced (%s) at the operator's path mid-run: never read again, both trials finish and count",
      (i, kind, planted) => {
        // The pool read the sources once, before the first trial; the agent's replacement
        // is real (plantedKind) but the pool never opens that path again.
        const out = oracle("during", i, kind, 2);
        expect(out.plantedKind).toBe(planted);
        expect(out.refused).toBeNull();
        for (const id of ["attacker", "honest"]) {
          expect(out.trials?.[id]?.disqualifiers).toEqual([]);
          expect(out.trials?.[id]?.counted).toBe(true);
        }
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each(cases)(
      "snapshot copy %i replaced (%s) mid-run, serial pool: the verdict is uncertain and the next seal is refused, never a hang",
      (i, kind, planted) => {
        const out = oracle("snapshot", i, kind, 1);
        expect(out.plantedKind).toBe(planted);
        const attacker = out.trials?.attacker;
        expect(attacker?.verdict).toBe("uncertain");
        expect(attacker?.reasons.join(" ")).toContain("integrity:oracle-source-missing");
        expect(attacker?.counted).toBe(false);
        const honest = out.trials?.honest;
        expect(honest?.disqualifiers).toEqual(["oracle-source"]);
        expect(honest?.verdict).toBeNull();
        expect(honest?.error).toMatch(
          /^verdict vault: not-regular: oracle source .* \(not-regular\)$/,
        );
        expect(honest?.counted).toBe(false);
      },
      HARD_LIMIT_MS + 5_000,
    );

    it(
      "snapshot copy replaced by other regular bytes: the next trial's gate verifies on them, and the count is withheld",
      () => {
        const out = oracle("snapshot", 2, "file", 1);
        expect(out.plantedKind).toBe("file");
        expect(out.trials?.attacker?.reasons.join(" ")).toContain("integrity:oracle-source-hash");
        // The honest trial sealed the replaced bytes, so its gate has nothing to object to:
        // only the seal-vs-snapshot check withholds the count.
        expect(out.trials?.honest?.verdict).toBe("verified");
        expect(out.trials?.honest?.disqualifiers).toEqual(["oracle-source"]);
        expect(out.trials?.honest?.counted).toBe(false);
      },
      HARD_LIMIT_MS + 5_000,
    );
  },
);

describe.skipIf(process.platform !== "linux")(
  "R3-1: a vault file swapped for a FIFO or a /dev/zero link is refused with a code",
  () => {
    it.each([
      ["seal.json", ["seal-malformed"]],
      ["stop.json", ["capture-signature", "stop-signature"]],
      ["capture.json", ["capture-signature", "unexpected-file"]],
      ["sealed/ground-truth.json", ["sealed-file-not-regular"]],
      ["sealed/fixtures/fixture.csv", ["sealed-file-not-regular"]],
      ["captured/persisted/sheet.csv", ["captured-file-not-regular"]],
    ] as const)(
      "%s",
      (rel, codes) => {
        for (const kind of ["fifo", "zero"]) {
          const out = child(["vault-static", join(base, `v-${kind}`), rel, kind]);
          expect(out.codes).toEqual(codes);
        }
      },
      2 * HARD_LIMIT_MS + 5_000,
    );

    // The lstat-then-read window: a setsid daemon swaps the file for a FIFO and back as
    // fast as it can while the vault checks the run 3000 times. With a blocking read the
    // child hangs within a few hundred checks (the R1/R2 mutants are killed this way).
    it.each([
      ["seal.json", ["seal-malformed", "seal-missing", "unexpected-file"]],
      [
        "sealed/ground-truth.json",
        ["sealed-file-missing", "sealed-file-not-regular", "unexpected-file"],
      ],
      [
        "captured/persisted/sheet.csv",
        ["captured-file-missing", "captured-file-not-regular", "unexpected-file"],
      ],
    ] as const)(
      "%s raced by a setsid daemon: every check returns, with a code",
      (rel, allowed) => {
        const out = child(["vault-race", base, rel, "3000"]);
        expect(out.iterations).toBe(3000);
        expect(out.codes?.length).toBeGreaterThan(0);
        for (const code of out.codes ?? []) expect(allowed).toContain(code);
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each(["seal", "ground-truth"])(
      "serial pool: a setsid daemon from trial 1 races trial 2's vault %s file; the pool finishes with a code",
      (site) => {
        const out = child(["pool-race", join(base, "r"), site]);
        expect(out.trials?.starter?.counted).toBe(true);
        const honest = out.trials?.honest;
        expect(honest).toBeDefined();
        expect(honest?.counted).toBe(false);
        // Either the vault refused the verdict, or the stop/capture refused the trial.
        const coded = honest?.verdict === "uncertain" || (honest?.disqualifiers.length ?? 0) > 0;
        expect(coded).toBe(true);
      },
      HARD_LIMIT_MS + 5_000,
    );
  },
);

describe("readRegularNoBlock", () => {
  it("returns exactly readFileSync's bytes for a regular file", () => {
    for (const src of CALC_ORACLE_SOURCES) {
      const r = readRegularNoBlock(src, { maxBytes: 16 * 1024 * 1024 });
      expect(r.ok && r.bytes.equals(readFileSync(src))).toBe(true);
    }
  });

  it("refuses a symlink, even to a regular file (O_NOFOLLOW)", () => {
    const target = join(base, "real.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(base, "link.txt"));
    expect(readRegularNoBlock(join(base, "link.txt"), { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "not-regular",
    });
  });

  it("refuses a file over the cap without reading it", () => {
    const path = join(base, "big");
    writeFileSync(path, "0123456789A");
    expect(readRegularNoBlock(path, { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(readRegularNoBlock(path, { maxBytes: 11 }).ok).toBe(true);
  });

  it("refuses a file swapped after the caller's lstat (another inode)", () => {
    const path = join(base, "f");
    writeFileSync(path, "first");
    const st = lstatSync(path);
    writeFileSync(join(base, "g"), "second");
    renameSync(join(base, "g"), path);
    expect(readRegularNoBlock(path, { maxBytes: 100, expect: st })).toMatchObject({
      ok: false,
      code: "swapped",
    });
  });

  it("a missing file is missing", () => {
    expect(readRegularNoBlock(join(base, "nope"), { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "missing",
    });
  });
});

describe("sealMatchesSnapshot", () => {
  const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
  const snapshot: OracleSnapshot[] = [
    { source: "/src/a.ts", path: "/snap/0-a.ts", sha256: sha("a") },
    { source: "/src/b.ts", path: "/snap/1-b.ts", sha256: sha("b") },
  ];
  const write = (sources: Record<string, string>) => {
    const text = `${JSON.stringify({ oracle: { id: "f@1", sources } })}\n`;
    const path = join(base, "seal.json");
    writeFileSync(path, text);
    return { path, digest: sha(text) };
  };

  it("is true only for the seal the receipt names, with exactly the snapshot's sources", () => {
    const ok = write({ "/snap/0-a.ts": sha("a"), "/snap/1-b.ts": sha("b") });
    expect(sealMatchesSnapshot(ok.path, ok.digest, snapshot)).toBe(true);
    expect(sealMatchesSnapshot(ok.path, sha("another seal"), snapshot)).toBe(false);
  });

  it("is false when a source hash, path or count differs", () => {
    for (const sources of <Record<string, string>[]>[
      { "/snap/0-a.ts": sha("A"), "/snap/1-b.ts": sha("b") },
      { "/src/a.ts": sha("a"), "/snap/1-b.ts": sha("b") },
      { "/snap/0-a.ts": sha("a") },
      { "/snap/0-a.ts": sha("a"), "/snap/1-b.ts": sha("b"), "/x": sha("x") },
    ]) {
      const s = write(sources);
      expect(sealMatchesSnapshot(s.path, s.digest, snapshot)).toBe(false);
    }
  });

  it("is false for a missing or non-JSON seal", () => {
    expect(sealMatchesSnapshot(join(base, "none.json"), sha(""), snapshot)).toBe(false);
    writeFileSync(join(base, "bad.json"), "not json");
    expect(sealMatchesSnapshot(join(base, "bad.json"), sha("not json"), snapshot)).toBe(false);
  });
});

describe("Q1: the final pass's incomplete scan withholds the count", () => {
  it("a trial that leaves an unscannable file in its evidence dir is not counted", async () => {
    const runRoot = join(base, "run");
    const honest = scriptedFileAgent("honest");
    const bloats: ScriptedDesktopAgent = {
      id: "bloats-evidence",
      simulated: true,
      async run(ctx) {
        const done = await honest.run(ctx);
        // A sparse file over the scan budget: the final pass cannot scan it, so it cannot
        // say no other trial's marker is there. Only the final pass looks at this dir.
        const big = join(runRoot, "evidence", ctx.runId, "big.bin");
        writeFileSync(big, "");
        truncateSync(big, SCAN_LIMIT_BYTES + 1);
        return done;
      },
    };
    mkdirSync(runRoot, { recursive: true });
    const report = await runPool(
      {
        backend: fakeBackend(),
        caps: {
          maxConcurrent: 1,
          memoryMbPerTrial: 64,
          cpusPerTrial: 1,
          cpuSecondsPerTrial: 60,
          trialTimeoutMs: 20_000,
          memoryBudgetMb: 1024,
          cpuBudget: 1,
        },
        requirements: STRICT_REQUIREMENTS,
        runRoot,
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [
        { runId: "bloats", taskId: L_TASK_ID, agent: bloats },
        { runId: "honest", taskId: L_TASK_ID, agent: honest },
      ],
    );
    const [b, h] = report.trials;
    expect(b?.gate?.verdict).toBe("verified");
    expect(b?.disqualifiers).toEqual(["scan-incomplete"]);
    expect(b?.countedVerified).toBe(false);
    expect(h?.countedVerified).toBe(true);
    expect(report.oracleSources.map((o) => o.source)).toEqual([...CALC_ORACLE_SOURCES]);
  });
});
