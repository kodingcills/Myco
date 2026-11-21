import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureFingerprint, generateFixture } from "../src/tasks/fixture.ts";
import { generateParameterSets } from "../src/tasks/intent.ts";

const SEEDS = ["m1-013-live", "seed-b", "seed-c", "seed-d", "seed-e", "seed-f"];
const RECORD = join(__dirname, "..", "scripts", "m1-sweep-record.py");

function fingerprints(): Record<string, string> {
  return Object.fromEntries(
    SEEDS.map((s) => [s, fixtureFingerprint(generateFixture(s)).csvSha256]),
  );
}

function runRecord(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("python3", [RECORD, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout };
}

describe("fixture fingerprint (M1-013 sweep seed check)", () => {
  it("is the SHA-256 of the exact CSV bytes the trial uploads", () => {
    const f = generateFixture("seed-b");
    const want = createHash("sha256").update(Buffer.from(f.csv, "utf8")).digest("hex");
    expect(fixtureFingerprint(f)).toEqual({
      seed: "seed-b",
      dataRows: f.dataRows,
      csvSha256: want,
    });
  });

  it("differs across all six sweep seeds and is stable per seed", () => {
    const map = fingerprints();
    expect(new Set(Object.values(map)).size).toBe(SEEDS.length);
    expect(fixtureFingerprint(generateFixture("seed-c")).csvSha256).toBe(map["seed-c"]);
  });

  it("every sweep row key exists in its own seed's fixture", () => {
    for (const p of generateParameterSets(SEEDS)) {
      const n = Number(p.rowKey.slice(4));
      expect(n).toBeLessThanOrEqual(generateFixture(p.fixtureSeed).dataRows);
    }
  });
});

describe("m1-sweep-record.py", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-seed-"));
  const fp = join(dir, "fp.json");
  writeFileSync(fp, JSON.stringify(fingerprints()));
  const map = fingerprints();

  function report(seed: string, sha: string | undefined): string {
    const p = join(dir, `out-${seed}-${sha?.slice(0, 6)}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        runId: "r",
        verdict: { status: "verified", reasons: ["ok"] },
        completed: true,
        elapsedMs: 1,
        ...(sha ? { fixture: { seed, dataRows: 10, csvSha256: sha } } : {}),
      }),
    );
    return p;
  }

  it("keeps the verdict when the trial used the requested seed", () => {
    const out = report("seed-b", map["seed-b"]);
    const r = runRecord(["3", "seed-b", "EMP-0001", "qty", "1", out, fp]);
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: "verified",
      fixtureSha256: map["seed-b"],
    });
  });

  it("flags seed-mismatch when the trial ran on the default sheet (the pilot bug)", () => {
    const out = report("m1-013-live", map["m1-013-live"]);
    const rec = JSON.parse(runRecord(["3", "seed-b", "EMP-0001", "qty", "1", out, fp]).stdout);
    expect(rec.status).toBe("seed-mismatch");
    expect(rec.trialStatus).toBe("verified");
  });

  it("flags seed-mismatch when the report carries no fixture identity", () => {
    const out = report("seed-b", undefined);
    const rec = JSON.parse(runRecord(["3", "seed-b", "EMP-0001", "qty", "1", out, fp]).stdout);
    expect(rec.status).toBe("seed-mismatch");
  });

  it("final check passes on one hash per seed and fails on a single-sheet run", () => {
    const good = join(dir, "good.jsonl");
    writeFileSync(
      good,
      `${SEEDS.map((s, i) => JSON.stringify({ index: i, fixtureSeed: s, fixtureSha256: map[s] })).join("\n")}\n`,
    );
    expect(runRecord(["--final", good, fp]).status).toBe(0);

    const single = join(dir, "single.jsonl");
    writeFileSync(
      single,
      `${SEEDS.map((s, i) => JSON.stringify({ index: i, fixtureSeed: s, fixtureSha256: map["m1-013-live"] })).join("\n")}\n`,
    );
    expect(runRecord(["--final", single, fp]).status).toBe(1);

    const fiveSeeds = join(dir, "five.jsonl");
    writeFileSync(
      fiveSeeds,
      `${SEEDS.slice(1)
        .map((s, i) => JSON.stringify({ index: i, fixtureSeed: s, fixtureSha256: map[s] }))
        .join("\n")}\n`,
    );
    expect(runRecord(["--final", fiveSeeds, fp]).status).toBe(1);
  });

  it("treats a non-object report as a harness error, not a crash", () => {
    const out = join(dir, "array.json");
    writeFileSync(out, "[]");
    const rec = JSON.parse(runRecord(["3", "seed-b", "EMP-0001", "qty", "1", out, fp]).stdout);
    expect(rec.status).toBe("harness-error");
  });

  it("final check fails on a recorded seed-mismatch even when its stored hash matches (resume hole)", () => {
    const log = join(dir, "mismatch-resumed.jsonl");
    const rows = SEEDS.map((s, i) =>
      JSON.stringify({ index: i, fixtureSeed: s, fixtureSha256: map[s], status: "verified" }),
    );
    rows.push(
      JSON.stringify({
        index: 6,
        fixtureSeed: "seed-b",
        fixtureSha256: map["seed-b"],
        status: "seed-mismatch",
        trialStatus: "verified",
      }),
    );
    writeFileSync(log, `${rows.join("\n")}\n`);
    const r = runRecord(["--final", log, fp]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("seed-mismatch disqualifies");
  });

  it("copies the conversion timing into the sweep record", () => {
    const out = join(dir, "with-timing.json");
    writeFileSync(
      out,
      JSON.stringify({
        runId: "r",
        verdict: { status: "verified", reasons: ["ok"] },
        completed: true,
        elapsedMs: 1,
        fixture: { seed: "seed-b", dataRows: 10, csvSha256: map["seed-b"] },
        fixtureConvert: { deadlineMs: 240000, durationMs: 31234, outcome: "arrived" },
      }),
    );
    const rec = JSON.parse(runRecord(["3", "seed-b", "EMP-0001", "qty", "1", out, fp]).stdout);
    expect(rec).toMatchObject({
      status: "verified",
      convertMs: 31234,
      convertDeadlineMs: 240000,
      convertOutcome: "arrived",
    });
  });
});
