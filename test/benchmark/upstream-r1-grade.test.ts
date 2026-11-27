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
import { MYCO_FLEET, OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import {
  gradeR1Example,
  gradeR1ExampleDir,
  type HarnessStamp,
  harnessStampProblems,
  OSWORLD_EVALUATE_GRADER,
  stampHarness,
} from "../../src/benchmark/upstream/r1-grade.ts";
import { pinnedStamp } from "./upstream-fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OSW = process.env.MYCO_UPSTREAM_OSWORLD;
const REQUIRED = process.env.MYCO_UPSTREAM_REQUIRED === "1";
const PATCH = join(ROOT, "src/gate-hooks/osworld/run_multienv_claude.gate.patch");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The stamp of a run on the pinned harness with the documented patches, on the fleet. */
const PINNED: HarnessStamp = pinnedStamp();
const PROVIDER_PATCH = join(ROOT, "src/benchmark/upstream/fleet/desktop_env_providers.patch");
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
      // The provider registration patch must be applied, and nothing else changed.
      [
        withFile(
          "desktop_env/providers/__init__.py",
          OSWORLD_HARNESS.files["desktop_env/providers/__init__.py"],
        ),
        "HARNESS_FILE_MODIFIED:desktop_env/providers/__init__.py",
      ],
      [
        withFile("desktop_env/server/main.py", "1".repeat(64)),
        "HARNESS_FILE_MODIFIED:desktop_env/server/main.py",
      ],
      // B3 at grading level: every row runs on the Myco fleet provider, one pinned image, the
      // pinned fleet files.
      [{ ...PINNED, provider: "vmware" }, "HARNESS_PROVIDER_MISMATCH"],
      [{ ...PINNED, provider: "utm-reference" }, "HARNESS_PROVIDER_MISMATCH"],
      [{ ...PINNED, imageDigest: null }, "HARNESS_IMAGE_NOT_PINNED"],
      [{ ...PINNED, imageDigest: "myco-osworld-desktop:local" }, "HARNESS_IMAGE_NOT_PINNED"],
      [
        { ...PINNED, fleetFiles: { ...PINNED.fleetFiles, [MYCO_FLEET.adapter]: "2".repeat(64) } },
        `FLEET_FILE_MODIFIED:${MYCO_FLEET.adapter}`,
      ],
      [
        { ...PINNED, fleetFiles: { ...PINNED.fleetFiles, [MYCO_FLEET.image]: undefined as never } },
        `FLEET_FILE_MISSING:${MYCO_FLEET.image}`,
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
    // The parity reference stamp is checked against its own provider and files.
    expect(harnessStampProblems(pinnedStamp("utm-reference"), "utm-reference")).toEqual([]);
    expect(harnessStampProblems(pinnedStamp("utm-reference"))).toContain(
      "HARNESS_PROVIDER_MISMATCH",
    );
  });

  it("pins every harness file the rulings name: runner, loop, agent, environment, controllers, provider registry, controller server", () => {
    expect(Object.keys(OSWORLD_HARNESS.files).sort()).toEqual([
      "desktop_env/controllers/python.py",
      "desktop_env/controllers/setup.py",
      "desktop_env/desktop_env.py",
      "desktop_env/providers/__init__.py",
      "desktop_env/providers/base.py",
      "desktop_env/server/__init__.py",
      "desktop_env/server/main.py",
      "desktop_env/server/pyxcursor.py",
      "desktop_env/server/screen_recording.py",
      "lib_run_single.py",
      "mm_agents/anthropic/main.py",
      "mm_agents/anthropic/utils.py",
      "scripts/python/run_multienv_claude.py",
    ]);
    expect(Object.keys(OSWORLD_HARNESS.patchedFiles).sort()).toEqual([
      "desktop_env/desktop_env.py",
      "desktop_env/providers/__init__.py",
      "scripts/python/run_multienv_claude.py",
    ]);
    expect(OSWORLD_HARNESS.patchedFiles[OSWORLD_HARNESS.agentRunner]).toBe(
      OSWORLD_HARNESS.patchedAgentRunnerSha256,
    );
    const none = () => null;
    const run = { provider: "myco-fleet", imageDigest: null, readRepoFile: none };
    expect(stampHarness(OSWORLD_PIN.commit, none, run).files).toEqual({});
    const bytes = new TextEncoder().encode("x");
    expect(stampHarness(OSWORLD_PIN.commit, () => bytes, run).files["lib_run_single.py"]).toBe(
      sha256Hex(bytes),
    );
    // stampHarness hashes the fleet files from the repo; the result equals the pins.
    const fromRepo = stampHarness(OSWORLD_PIN.commit, none, {
      provider: "myco-fleet",
      imageDigest: null,
      readRepoFile: (rel) => readFileSync(join(ROOT, rel)),
    });
    expect(fromRepo.fleetFiles).toEqual(MYCO_FLEET.files);
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
    const stamp = stampHarness(OSWORLD_PIN.commit, (rel) => read(rel), {
      provider: "myco-fleet",
      imageDigest: null,
      readRepoFile: () => null,
    });
    expect(stamp.files).toEqual(OSWORLD_HARNESS.files);
  });

  it("the provider registration patch applies to the pinned files, yields the pinned patched digests, and leaves DesktopEnv.evaluate byte-identical", () => {
    const d = mkdtempSync(join(tmpdir(), "provider-patch-"));
    dirs.push(d);
    for (const rel of ["desktop_env/desktop_env.py", "desktop_env/providers/__init__.py"]) {
      mkdirSync(join(d, rel, ".."), { recursive: true });
      copyFileSync(join(root, rel), join(d, rel));
    }
    const applied = spawnSync("git", ["apply", PROVIDER_PATCH], { cwd: d, encoding: "utf8" });
    expect(applied.status, applied.stderr).toBe(0);
    for (const rel of ["desktop_env/desktop_env.py", "desktop_env/providers/__init__.py"])
      expect(sha256Hex(readFileSync(join(d, rel))), rel).toBe(OSWORLD_HARNESS.patchedFiles[rel]);
    const evaluate = (src: string) =>
      src.slice(src.indexOf("    def evaluate(self):"), src.indexOf("    def render(self"));
    const before = evaluate(read("desktop_env/desktop_env.py").toString("utf8"));
    expect(before.length).toBeGreaterThan(500);
    expect(evaluate(readFileSync(join(d, "desktop_env/desktop_env.py"), "utf8"))).toBe(before);
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
