/**
 * R1 grader path (gap item 2 of the lead's 13:55Z ruling): ground truth is OSWorld's own
 * `DesktopEnv.evaluate()` at the pin, run inside OSWorld's runner, which writes its score to
 * `result.txt`. Myco only reads that score, and refuses a run whose harness is not the pinned
 * one. It never stands in for a getter, runs a postconfig or calls a metric itself.
 *
 * With MYCO_UPSTREAM_OSWORLD (the upstream CI job), it also checks the pinned harness hashes
 * against a fresh clone, that `run_single_example` calls `env.evaluate()` and writes its
 * return value to result.txt, and that the documented runner patch applies and yields the
 * pinned patched digest. test/benchmark/osworld-gate-hook.test.ts drives the real loop.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/benchmark/upstream/import.ts";
import { OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import {
  gradeR1Example,
  gradeR1ExampleDir,
  type HarnessStamp,
  harnessStampProblems,
  OSWORLD_EVALUATE_GRADER,
  stampHarness,
} from "../../src/benchmark/upstream/r1-grade.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OSW = process.env.MYCO_UPSTREAM_OSWORLD;
const REQUIRED = process.env.MYCO_UPSTREAM_REQUIRED === "1";
const PATCH = join(ROOT, "src/gate-hooks/osworld/run_multienv_claude.gate.patch");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The stamp of a run on the pinned harness with the documented runner patch applied. */
const PINNED: HarnessStamp = {
  repo: OSWORLD_HARNESS.repo,
  commit: OSWORLD_PIN.commit,
  files: {
    ...OSWORLD_HARNESS.files,
    [OSWORLD_HARNESS.agentRunner]: OSWORLD_HARNESS.patchedAgentRunnerSha256,
  },
};
const grade = (resultTxt: string | null, stamp = PINNED, trajJsonl: string | null = null) =>
  gradeR1Example({ taskId: "t", stamp, files: { resultTxt, trajJsonl } });

describe("R1 grader: reads the score OSWorld's own evaluate path wrote", () => {
  it("is stamped with the upstream evaluate path at the pinned commit", () => {
    expect(grade("1.0\n").graderVersion).toBe(OSWORLD_EVALUATE_GRADER);
    expect(OSWORLD_EVALUATE_GRADER).toBe(`osworld-desktopenv-evaluate@${OSWORLD_PIN.commit}`);
    expect(OSWORLD_HARNESS.grader).toBe("desktop_env/desktop_env.py#DesktopEnv.evaluate");
  });

  it("maps upstream's score: exactly 1.0 passes, any other finite score fails", () => {
    expect(grade("1.0\n")).toMatchObject({ status: "pass", upstreamScore: 1 });
    expect(grade("1\n")).toMatchObject({ status: "pass", upstreamScore: 1 });
    expect(grade("0.0\n")).toMatchObject({ status: "fail", upstreamScore: 0 });
    expect(grade("0.5\n")).toMatchObject({ status: "fail", upstreamScore: 0.5 });
    expect(grade("0.9999\n").status).toBe("fail");
  });

  it("is ungradable, never a pass, when upstream wrote no score or not one number", () => {
    expect(grade(null)).toMatchObject({ status: "ungradable", codes: ["RESULT_MISSING"] });
    for (const bad of ["", "nan\n", "inf\n", "1.0 1.0\n", "pass\n", "1.0\nextra\n"])
      expect(grade(bad), JSON.stringify(bad)).toMatchObject({
        status: "ungradable",
        codes: ["RESULT_UNPARSEABLE"],
      });
  });

  it("refuses a run whose harness is not the pinned one: other commit, repo, modified or missing file, unpatched runner", () => {
    const withFile = (rel: string, digest: string | undefined): HarnessStamp => {
      const files: Record<string, string> = { ...PINNED.files };
      if (digest === undefined) delete files[rel];
      else files[rel] = digest;
      return { ...PINNED, files };
    };
    const cases: [HarnessStamp, string][] = [
      [{ ...PINNED, commit: "0".repeat(40) }, "HARNESS_COMMIT_MISMATCH"],
      [{ ...PINNED, repo: "https://github.com/someone/OSWorld" }, "HARNESS_REPO_MISMATCH"],
      [
        withFile("desktop_env/desktop_env.py", "0".repeat(64)),
        "HARNESS_FILE_MODIFIED:desktop_env/desktop_env.py",
      ],
      [withFile("lib_run_single.py", undefined), "HARNESS_FILE_MISSING:lib_run_single.py"],
      [
        withFile(OSWORLD_HARNESS.agentRunner, OSWORLD_HARNESS.files[OSWORLD_HARNESS.agentRunner]),
        `HARNESS_FILE_MODIFIED:${OSWORLD_HARNESS.agentRunner}`,
      ],
    ];
    for (const [stamp, code] of cases) {
      expect(harnessStampProblems(stamp), code).toContain(code);
      expect(grade("1.0\n", stamp), code).toMatchObject({
        status: "ungradable",
        upstreamScore: null,
      });
    }
    expect(harnessStampProblems(PINNED)).toEqual([]);
  });

  it("pins every harness file the ruling names: runner, loop, agent, environment, controllers", () => {
    expect(Object.keys(OSWORLD_HARNESS.files).sort()).toEqual([
      "desktop_env/controllers/python.py",
      "desktop_env/controllers/setup.py",
      "desktop_env/desktop_env.py",
      "lib_run_single.py",
      "mm_agents/anthropic/main.py",
      "mm_agents/anthropic/utils.py",
      "scripts/python/run_multienv_claude.py",
    ]);
    expect(stampHarness(OSWORLD_PIN.commit, () => null).files).toEqual({});
    const bytes = new TextEncoder().encode("x");
    expect(stampHarness(OSWORLD_PIN.commit, () => bytes).files["lib_run_single.py"]).toBe(
      sha256Hex(bytes),
    );
  });

  it("records the last action upstream logged, from traj.jsonl", () => {
    const traj = (action: unknown) => `${JSON.stringify({ step_num: 1, action })}\n`;
    expect(grade("1.0\n", PINNED, traj({ action_type: "DONE" })).lastAction).toBe("DONE");
    expect(grade("0\n", PINNED, traj("FAIL")).lastAction).toBe("FAIL");
    expect(grade("0\n", PINNED, traj({ command: "pyautogui.click(1, 2)\nx" })).lastAction).toBe(
      "pyautogui.click(1, 2)",
    );
    expect(grade("0\n", PINNED, "not json\n").lastAction).toBeNull();
  });

  it("reads result.txt and traj.jsonl from an example result directory", () => {
    const d = mkdtempSync(join(tmpdir(), "r1-grade-"));
    dirs.push(d);
    expect(gradeR1ExampleDir(d, "t", PINNED).codes).toEqual(["RESULT_MISSING"]);
    writeFileSync(join(d, "result.txt"), "1.0\n");
    expect(gradeR1ExampleDir(d, "t", PINNED)).toMatchObject({ status: "pass", taskId: "t" });
  });

  it("never evaluates anything itself: no MOCK metric runner, no process, no getter", () => {
    const code = readFileSync(join(ROOT, "src/benchmark/upstream/r1-grade.ts"), "utf8").replace(
      /^\s*(\/\/|\*|\/\*\*).*$/gm,
      "",
    );
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./import.ts", "./pins.ts", "node:fs", "node:path"]);
    expect(code).not.toMatch(/evaluate\.ts|child_process|spawn|run_upstream_metric|getter|python/i);
  });
});

describe.runIf(Boolean(OSW) || REQUIRED)("against a fresh OSWorld clone at the pin", () => {
  const root = OSW as string;
  const read = (rel: string) => readFileSync(join(root, rel));

  it("every pinned harness file matches the clone byte for byte", () => {
    const stamp = stampHarness(OSWORLD_PIN.commit, (rel) => read(rel));
    expect(stamp.files).toEqual(OSWORLD_HARNESS.files);
  });

  it("run_single_example calls env.evaluate() after the loop and writes that value to result.txt (the R1 grader path)", () => {
    const src = read("lib_run_single.py").toString("utf8");
    const fn = src.slice(src.indexOf("def run_single_example("), src.indexOf("def setup_logger("));
    expect(fn).toMatch(/result = env\.evaluate\(\)/);
    expect(fn).toMatch(/"result\.txt"[\s\S]*f\.write\(f"\{result\}\\n"\)/);
    const runner = read(OSWORLD_HARNESS.agentRunner).toString("utf8");
    expect(runner).toMatch(/lib_run_single\.run_single_example\(/);
    expect(runner).toMatch(/from mm_agents\.anthropic import AnthropicAgent/);
  });

  it("the documented runner patch applies to the pinned runner and yields the pinned patched digest", () => {
    const d = mkdtempSync(join(tmpdir(), "runner-patch-"));
    dirs.push(d);
    mkdirSync(join(d, "scripts/python"), { recursive: true });
    copyFileSync(join(root, OSWORLD_HARNESS.agentRunner), join(d, OSWORLD_HARNESS.agentRunner));
    const applied = spawnSync("git", ["apply", PATCH], { cwd: d, encoding: "utf8" });
    expect(applied.status, applied.stderr).toBe(0);
    expect(sha256Hex(readFileSync(join(d, OSWORLD_HARNESS.agentRunner)))).toBe(
      OSWORLD_HARNESS.patchedAgentRunnerSha256,
    );
  });
});
