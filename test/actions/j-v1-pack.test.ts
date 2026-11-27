/**
 * Track J, j-v1 pack writer: the frozen-in commit is checked with git, rows land in schedule
 * order exactly once, a failed trial halts the pack, and finalize runs the frozen analysis.
 *
 * Each test works in a throwaway git repository holding copies of the committed prereg.json and
 * analysis script. Every row is synthetic; nothing here ran a model, and no row is evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  J_CAPABILITY_ARM,
  J_V1_TRIAL_SCHEMA,
  type JScheduledTrial,
  type JTrialRow,
} from "../../src/actions/j-v1-analysis.ts";
import {
  J_V1_ANALYSIS_PATH,
  J_V1_PREREG_PATH,
  jV1Schedule,
  loadJV1Prereg,
} from "../../src/actions/j-v1-harness.ts";
import {
  finalizeJV1Pack,
  J_V1_PACK_FILES,
  J_V1_PACK_SCHEMA,
  JV1PackError,
  openJV1Pack,
  runJV1,
  verifyJV1FrozenCommit,
} from "../../src/actions/j-v1-pack.ts";

const ROOT = mkdtempSync(join(tmpdir(), "j-v1-pack-"));
const REPO = join(ROOT, "repo");
let packCount = 0;
const freshPackDir = () => join(ROOT, `pack-${packCount++}`);

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      REPO,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function put(rel: string, from: string) {
  mkdirSync(dirname(join(REPO, rel)), { recursive: true });
  copyFileSync(from, join(REPO, rel));
}

/** Commits: C0 (no prereg) -> BAD (prereg with one value changed) -> FROZEN, all on main; SIDE off main. */
const C: { c0: string; bad: string; frozen: string; side: string } = {
  c0: "",
  bad: "",
  frozen: "",
  side: "",
};

beforeAll(() => {
  mkdirSync(REPO);
  git("init", "-q", "-b", "main");
  writeFileSync(join(REPO, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "c0");
  C.c0 = git("rev-parse", "HEAD");
  put(J_V1_ANALYSIS_PATH, J_V1_ANALYSIS_PATH);
  const altered = JSON.parse(readFileSync(J_V1_PREREG_PATH, "utf8")) as Record<string, unknown>;
  altered.stepBudget = 31;
  mkdirSync(dirname(join(REPO, J_V1_PREREG_PATH)), { recursive: true });
  writeFileSync(join(REPO, J_V1_PREREG_PATH), JSON.stringify(altered));
  git("add", ".");
  git("commit", "-q", "-m", "bad");
  C.bad = git("rev-parse", "HEAD");
  put(J_V1_PREREG_PATH, J_V1_PREREG_PATH);
  git("add", ".");
  git("commit", "-q", "-m", "frozen");
  C.frozen = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "side");
  git("commit", "-q", "--allow-empty", "-m", "side");
  C.side = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const loaded = () => loadJV1Prereg(REPO);
const open = (packDir: string, commit = C.frozen) =>
  openJV1Pack({ repoRoot: REPO, packDir, preregCommit: commit, mainRef: "main" });
const finalize = (packDir: string) => finalizeJV1Pack({ repoRoot: REPO, packDir, mainRef: "main" });

/** A per-task parity hash stand-in: one value per task, shared by both arms and every repeat. */
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** A synthetic row for scheduled trial `t`. Simulated by default. */
function rowFor(t: JScheduledTrial, over: Partial<JTrialRow> = {}): JTrialRow {
  return {
    schema: J_V1_TRIAL_SCHEMA,
    taskId: t.taskId,
    arm: t.arm,
    seq: t.seq,
    plannerModelId: "scripted-fake",
    simulated: true,
    claim: "done",
    grade: "pass",
    steps: t.arm === J_CAPABILITY_ARM ? 4 : 9,
    wallMs: t.arm === J_CAPABILITY_ARM ? 40_000 : 90_000,
    harnessFault: null,
    boundaryBreach: false,
    instructionSha256: hex(`i:${t.taskId}`),
    fixtureSha256: hex(`f:${t.taskId}`),
    stepBudget: 30,
    outputCeiling: 1024,
    ...over,
  };
}

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof JV1PackError) return e.code;
    throw e;
  }
  return "NO_THROW";
};

const rowsOnDisk = (dir: string) =>
  readFileSync(join(dir, J_V1_PACK_FILES.rows), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JTrialRow);

describe("verifyJV1FrozenCommit (spec §3 item 2, the git half)", () => {
  const hash = () => loaded().hash;
  const verify = (commit: string, ref = "main") => verifyJV1FrozenCommit(REPO, commit, hash(), ref);

  it("accepts the commit on main whose prereg.json is this pre-registration", () => {
    expect(verify(C.frozen)).toEqual([]);
  });
  it("refuses a commit that is not 40 lowercase hex", () => {
    expect(verify(C.frozen.slice(0, 12))).toEqual(["PACK_COMMIT_FORM"]);
    expect(verify(C.frozen.toUpperCase())).toEqual(["PACK_COMMIT_FORM"]);
    expect(verify(`-${C.frozen.slice(1)}`)).toEqual(["PACK_COMMIT_FORM"]);
  });
  it("refuses a well-formed commit the repository does not have", () => {
    expect(verify("0123456789abcdef0123456789abcdef01234567")).toEqual(["PACK_COMMIT_UNKNOWN"]);
  });
  it("refuses a commit without prereg.json", () => {
    expect(verify(C.c0)).toEqual(["PACK_COMMIT_NO_PREREG"]);
  });
  it("refuses a commit on main whose prereg.json differs (one value changed)", () => {
    expect(verify(C.bad)).toEqual(["PACK_COMMIT_PREREG_DIFFERS"]);
  });
  it("refuses a commit holding the same prereg.json that is not on the main ref", () => {
    expect(verify(C.side)).toEqual(["PACK_COMMIT_NOT_ON_MAIN"]);
    expect(verify(C.side, "side")).toEqual([]);
  });
  it("refuses a main ref that does not resolve or looks like an option", () => {
    expect(verify(C.frozen, "no-such-ref")).toEqual(["PACK_MAIN_REF_UNKNOWN"]);
    expect(verify(C.frozen, "--all")).toEqual(["PACK_MAIN_REF_UNKNOWN"]);
    expect(verify(C.frozen, "")).toEqual(["PACK_MAIN_REF_UNKNOWN"]);
  });
  it("refuses when the expected hash is not the frozen file's", () => {
    expect(verifyJV1FrozenCommit(REPO, C.frozen, "0".repeat(64), "main")).toEqual([
      "PACK_COMMIT_PREREG_DIFFERS",
    ]);
  });
});

describe("openJV1Pack", () => {
  it("writes a header recording the pre-registration hash, the frozen-in commit and the schedule", () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const header = JSON.parse(readFileSync(join(dir, J_V1_PACK_FILES.header), "utf8"));
    const schedule = jV1Schedule(loaded().prereg);
    expect(header).toEqual(pack.header);
    expect(header.schema).toBe(J_V1_PACK_SCHEMA);
    expect(header.preregHash).toBe(loaded().hash);
    expect(header.preregCommit).toBe(C.frozen);
    expect(header.analysisSha256).toBe(
      (JSON.parse(readFileSync(J_V1_PREREG_PATH, "utf8")) as { analysis: { sha256: string } })
        .analysis.sha256,
    );
    expect(header.trials).toBe(360);
    expect(pack.schedule).toEqual(schedule);
    expect(header.scheduleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.written()).toBe(0);
    expect(pack.next()).toEqual(schedule[0]);
    expect(readFileSync(join(dir, J_V1_PACK_FILES.rows), "utf8")).toBe("");
  });

  it("refuses a frozen-in commit that fails the git check and writes nothing", () => {
    for (const [commit, code] of [
      [C.side, "PACK_COMMIT_NOT_ON_MAIN"],
      [C.bad, "PACK_COMMIT_PREREG_DIFFERS"],
      ["abc", "PACK_COMMIT_FORM"],
    ] as const) {
      const dir = freshPackDir();
      expect(codeOf(() => open(dir, commit))).toBe(code);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("refuses a directory that already holds something other than a pack", () => {
    const dir = freshPackDir();
    mkdirSync(dir);
    writeFileSync(join(dir, "stray.txt"), "x");
    expect(codeOf(() => open(dir))).toBe("PACK_DIR_NOT_EMPTY");
    expect(readdirSync(dir)).toEqual(["stray.txt"]);
  });

  it("errors carry codes only, never the pack's path", () => {
    const dir = freshPackDir();
    mkdirSync(dir);
    writeFileSync(join(dir, "stray.txt"), "x");
    try {
      open(dir);
    } catch (e) {
      expect((e as Error).message).toBe("j-v1 pack: PACK_DIR_NOT_EMPTY");
      expect((e as Error).message).not.toContain(ROOT);
    }
  });
});

describe("rows land in schedule order, exactly once", () => {
  it("refuses a row that is not the next scheduled trial, and writes nothing", () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const [t0, t1] = pack.schedule as [JScheduledTrial, JScheduledTrial];
    const otherArm = t0.arm === J_CAPABILITY_ARM ? "hcu+shell" : J_CAPABILITY_ARM;
    const otherTask = pack.schedule.find((t) => t.taskId !== t0.taskId) as JScheduledTrial;
    for (const bad of [
      rowFor(t1),
      rowFor(t0, { seq: t0.seq + 1 }),
      rowFor(t0, { arm: otherArm }),
      rowFor(t0, { taskId: otherTask.taskId }),
    ]) {
      expect(pack.check(bad)).toBe("PACK_OUT_OF_ORDER");
      expect(codeOf(() => pack.append(bad))).toBe("PACK_OUT_OF_ORDER");
    }
    const wrongSchema = { ...rowFor(t0), schema: "myco.capability.fast-path-row/1" } as never;
    expect(codeOf(() => pack.append(wrongSchema))).toBe("PACK_ROW_SCHEMA");
    expect(pack.written()).toBe(0);
    expect(readFileSync(join(dir, J_V1_PACK_FILES.rows), "utf8")).toBe("");
    pack.append(rowFor(t0));
    expect(pack.written()).toBe(1);
    expect(rowsOnDisk(dir)).toEqual([rowFor(t0)]);
    // The same trial a second time is refused: it is no longer the next one.
    expect(codeOf(() => pack.append(rowFor(t0)))).toBe("PACK_OUT_OF_ORDER");
    expect(pack.next()).toEqual(t1);
  });

  it("resumes a pack: same header, rows a schedule prefix, continues at the next trial", () => {
    const dir = freshPackDir();
    const first = open(dir);
    for (const t of first.schedule.slice(0, 5)) first.append(rowFor(t));
    const again = open(dir);
    expect(again.written()).toBe(5);
    expect(again.next()).toEqual(first.schedule[5]);
    again.append(rowFor(first.schedule[5] as JScheduledTrial));
    expect(rowsOnDisk(dir).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("refuses to resume a pack whose header was changed", () => {
    const dir = freshPackDir();
    open(dir);
    const path = join(dir, J_V1_PACK_FILES.header);
    const header = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...header, trials: 359 }));
    expect(codeOf(() => open(dir))).toBe("PACK_HEADER_MISMATCH");
    // Reformatting alone is not a change: the comparison is over canonical JSON.
    writeFileSync(path, canonicalJson(header));
    expect(open(dir).written()).toBe(0);
  });

  it("refuses to resume a pack whose rows on disk are out of order", () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const [t0, t1] = pack.schedule as [JScheduledTrial, JScheduledTrial];
    writeFileSync(
      join(dir, J_V1_PACK_FILES.rows),
      `${JSON.stringify(rowFor(t1))}\n${JSON.stringify(rowFor(t0))}\n`,
    );
    expect(codeOf(() => open(dir))).toBe("PACK_OUT_OF_ORDER");
  });

  it("refuses a torn last row (no newline) instead of repairing it", () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const t0 = pack.schedule[0] as JScheduledTrial;
    pack.append(rowFor(t0));
    appendFileSync(join(dir, J_V1_PACK_FILES.rows), '{"schema":');
    expect(codeOf(() => open(dir))).toBe("PACK_TORN_ROW");
    expect(codeOf(() => finalize(dir))).toBe("PACK_TORN_ROW");
  });

  it("refuses an unreadable row line", () => {
    const dir = freshPackDir();
    open(dir);
    writeFileSync(join(dir, J_V1_PACK_FILES.rows), "not json\n");
    expect(codeOf(() => open(dir))).toBe("PACK_ROW_UNREADABLE");
  });
});

describe("runJV1 and finalizeJV1Pack (fakes only)", () => {
  it("runs every scheduled trial once, in order, and finalize writes the frozen analysis once", async () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const seen: number[] = [];
    const outcome = await runJV1(pack, async (t) => {
      seen.push(t.seq);
      return rowFor(t);
    });
    expect(outcome).toEqual({ status: "complete", trials: 360 });
    expect(seen).toEqual(pack.schedule.map((t) => t.seq));
    expect(rowsOnDisk(dir).map((r) => [r.seq, r.taskId, r.arm])).toEqual(
      pack.schedule.map((t) => [t.seq, t.taskId, t.arm]),
    );
    expect(codeOf(() => pack.append(rowFor(pack.schedule[0] as JScheduledTrial)))).toBe(
      "PACK_COMPLETE",
    );

    const result = finalize(dir);
    expect(result.preregHash).toBe(loaded().hash);
    expect(result.preregCommit).toBe(C.frozen);
    expect(result.computed).toBe(true);
    expect(result.verdict).toBe("not-shown");
    expect(result.reasons.some((r) => r.startsWith("SIMULATED: 360 row(s)"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, J_V1_PACK_FILES.analysis), "utf8"))).toEqual(result);
    expect(codeOf(() => finalize(dir))).toBe("PACK_FINALIZED");
    expect(codeOf(() => open(dir))).toBe("PACK_FINALIZED");
  });

  it("plumbing only: synthetic rows under the model id reach the 'shown' path end to end", async () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const model = loaded().prereg.modelId;
    await runJV1(pack, async (t) => rowFor(t, { plannerModelId: model, simulated: false }));
    const result = finalize(dir);
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe("shown");
  });

  it("an incomplete pack is the analysis's to refuse", () => {
    const dir = freshPackDir();
    const pack = open(dir);
    pack.append(rowFor(pack.schedule[0] as JScheduledTrial));
    const result = finalize(dir);
    expect(result.verdict).toBe("not-shown");
    expect(result.computed).toBe(false);
  });

  it("a runner that throws halts the pack at that trial; nothing is re-run", async () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const calls: number[] = [];
    const outcome = await runJV1(pack, async (t) => {
      calls.push(t.seq);
      if (t.seq === 3) throw new Error("harness crashed");
      return rowFor(t);
    });
    const t3 = pack.schedule[3] as JScheduledTrial;
    expect(outcome).toEqual({
      status: "halted",
      halt: {
        schema: "myco.capability.j-v1.halt/1",
        seq: 3,
        taskId: t3.taskId,
        arm: t3.arm,
        code: "TRIAL_THREW",
      },
    });
    expect(calls).toEqual([0, 1, 2, 3]);
    expect(rowsOnDisk(dir)).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dir, J_V1_PACK_FILES.halted), "utf8"))).toEqual(
      outcome.status === "halted" ? outcome.halt : null,
    );
    expect(readFileSync(join(dir, J_V1_PACK_FILES.halted), "utf8")).not.toContain("crashed");
    expect(codeOf(() => pack.append(rowFor(t3)))).toBe("PACK_HALTED");
    expect(codeOf(() => open(dir))).toBe("PACK_HALTED");
    expect(codeOf(() => finalize(dir))).toBe("PACK_HALTED");
  });

  it("a runner that returns a row for the wrong trial halts the pack; the row is not written", async () => {
    const dir = freshPackDir();
    const pack = open(dir);
    const outcome = await runJV1(pack, async (t) => rowFor(t, { seq: t.seq === 2 ? 7 : t.seq }));
    expect(outcome.status).toBe("halted");
    expect(outcome.status === "halted" && outcome.halt.code).toBe("ROW_REFUSED");
    expect(outcome.status === "halted" && outcome.halt.seq).toBe(2);
    expect(rowsOnDisk(dir).map((r) => r.seq)).toEqual([0, 1]);
  });

  it("finalize re-checks the header's commit and hash with git, and writes nothing on failure", async () => {
    for (const [patch, code] of [
      [{ preregCommit: C.side }, "PACK_COMMIT_NOT_ON_MAIN"],
      [{ preregHash: "0".repeat(64) }, "PACK_COMMIT_PREREG_DIFFERS"],
      [{ preregCommit: C.bad }, "PACK_COMMIT_PREREG_DIFFERS"],
    ] as const) {
      const dir = freshPackDir();
      const pack = open(dir);
      await runJV1(pack, async (t) => rowFor(t));
      const path = join(dir, J_V1_PACK_FILES.header);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
      expect(codeOf(() => finalize(dir))).toBe(code);
      expect(existsSync(join(dir, J_V1_PACK_FILES.analysis))).toBe(false);
    }
  });

  it("finalize refuses a missing or foreign header", () => {
    const dir = freshPackDir();
    mkdirSync(dir);
    expect(codeOf(() => finalize(dir))).toBe("PACK_HEADER_MISSING");
    writeFileSync(join(dir, J_V1_PACK_FILES.header), JSON.stringify({ schema: "other" }));
    expect(codeOf(() => finalize(dir))).toBe("PACK_HEADER_UNREADABLE");
  });

  it("finalize refuses when the analysis script no longer matches its frozen SHA-256", async () => {
    const dir = freshPackDir();
    const pack = open(dir);
    await runJV1(pack, async (t) => rowFor(t));
    const script = join(REPO, J_V1_ANALYSIS_PATH);
    const original = readFileSync(script, "utf8");
    try {
      writeFileSync(script, `${original}\n// changed\n`);
      expect(() => finalize(dir)).toThrow(/does not match its SHA-256/);
      expect(existsSync(join(dir, J_V1_PACK_FILES.analysis))).toBe(false);
    } finally {
      writeFileSync(script, original);
    }
  });
});
