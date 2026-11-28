/**
 * TIF-268: the hcu+shell CLI's real-run refusals, end to end, and the refusal functions on
 * their own. The CLI is spawned with a minimal environment and a trap `claude` first on PATH;
 * `launch` always stops at its refusals here (no lead GO is committed, and no vm-session.sh
 * holds the VM lock), so no test reaches the VM or a model.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HCU_GUEST_COMMAND,
  guestShellSha256,
} from "../../../src/baseline/hcu-shell-live/live-vm.ts";
import {
  coldBootGuardProblems,
  LEAD_GO_FILE,
  LEAD_GO_SCHEMA,
  leadGoProblems,
  liveRefusals,
} from "../../../src/baseline/hcu-shell-live/refusals.ts";
import {
  demoTasks,
  hcuRunPlan,
  loadFcV1,
  planSha256,
} from "../../../src/baseline/hcu-shell-live/runner.ts";
import { useClaudeTrap } from "./helpers.ts";

const trap = useClaudeTrap();
const ROOT = resolve(".");
const SHA = planSha256(
  hcuRunPlan(demoTasks(loadFcV1(ROOT)), {
    hcuGuestCommand: DEFAULT_HCU_GUEST_COMMAND,
    guestShellSha256: guestShellSha256(ROOT),
  }),
);

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("npx", ["tsx", "scripts/m2-hcu-shell-run.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: `${trap.dir}${delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
      ...extraEnv,
    },
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const codes = (stderr: string) =>
  [...stderr.matchAll(/^ {2}- ([a-z0-9-]+):/gm)].map((m) => m[1]).sort();

describe("launch refuses without every real-run precondition", () => {
  it("prints the plan and refuses with every reason when nothing is given", () => {
    const r = cli(["launch", "--out", mkdtempSync(join(tmpdir(), "hcu-cli-"))]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).planSha256).toBe(SHA);
    expect(codes(r.stderr)).toEqual(
      ["launch-flag-missing", "lead-go-missing", "plan-sha256-mismatch", "vm-lock-not-held"].sort(),
    );
  }, 120_000);
  it("the flag and the right hash still wait for the lead's GO and the VM lock", () => {
    const r = cli([
      "launch",
      "--out",
      mkdtempSync(join(tmpdir(), "hcu-cli-")),
      "--launch-real-trials",
      "--plan-sha256",
      SHA,
    ]);
    expect(r.code).toBe(3);
    expect(codes(r.stderr)).toEqual(["lead-go-missing", "vm-lock-not-held"]);
  }, 120_000);
  it("a wrong hash is refused", () => {
    const r = cli([
      "launch",
      "--out",
      "x",
      "--launch-real-trials",
      "--plan-sha256",
      "0".repeat(64),
    ]);
    expect(codes(r.stderr)).toContain("plan-sha256-mismatch");
  }, 120_000);
  it("an API-path variable is refused by name, even when empty", () => {
    const r = cli(["launch", "--out", "x", "--launch-real-trials", "--plan-sha256", SHA], {
      ANTHROPIC_API_KEY: "",
    });
    expect(r.code).toBe(3);
    expect(codes(r.stderr)).toContain("api-key-path-configured");
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
  }, 120_000);
  it("probe-planner needs --call-claude", () => {
    const r = cli(["probe-planner"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("--call-claude");
  }, 120_000);
  it("dry-run refuses an existing run directory without --resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-cli-"));
    expect(cli(["dry-run", "--out", dir, "--max-trials", "1"]).code).toBe(4);
    const again = cli(["dry-run", "--out", dir, "--max-trials", "1"]);
    expect(again.code).toBe(3);
    expect(again.stderr).toContain("run-exists");
    expect(cli(["dry-run", "--out", dir, "--resume", "--max-trials", "1"]).code).toBe(4);
  }, 180_000);
});

describe("refusal functions", () => {
  const base = {
    repoRoot: ROOT,
    planSha256: SHA,
    launchRealTrials: true,
    pinnedPlanSha256: SHA,
    envNames: ["HOME", "PATH"],
    vmLockHeld: true,
  };
  it("the committed repo has no GO yet, so a real run is refused", () => {
    expect(liveRefusals(base).map((r) => r.split(":")[0])).toEqual(["lead-go-missing"]);
  });
  it("the cold-boot guard is present on main (#546, trial-base-v4 default)", () => {
    expect(coldBootGuardProblems(ROOT)).toEqual([]);
  });
  it("a reset script without #546's guard is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-guard-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts/reset-trial-vm.sh"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal bash parameter expansion.
      "#!/bin/sh\nSNAPSHOT=${1:-trial-base-v2}\n",
    );
    expect(coldBootGuardProblems(dir)).toHaveLength(2);
  });

  function goRepo(go: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "hcu-go-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "docs/benchmark"), { recursive: true });
    writeFileSync(join(dir, LEAD_GO_FILE), typeof go === "string" ? go : JSON.stringify(go));
    git("add", ".");
    git("commit", "-qm", "go");
    return dir;
  }
  const GO = { schema: LEAD_GO_SCHEMA, arm: "hcu+shell", planSha256: SHA, ruling: "test" };
  it("a committed GO naming this plan admits the run", () => {
    expect(leadGoProblems(goRepo(GO), SHA)).toEqual([]);
  });
  it("a GO for another plan, of another shape, or edited after commit is refused", () => {
    expect(leadGoProblems(goRepo({ ...GO, planSha256: "1".repeat(64) }), SHA)[0]).toMatch(
      /^lead-go-plan-mismatch/,
    );
    expect(leadGoProblems(goRepo({ ...GO, arm: "myco-gate" }), SHA)[0]).toMatch(/^lead-go-invalid/);
    expect(leadGoProblems(goRepo("not json"), SHA)[0]).toMatch(/^lead-go-invalid/);
    const dir = goRepo(GO);
    writeFileSync(join(dir, LEAD_GO_FILE), JSON.stringify({ ...GO, ruling: "edited" }));
    expect(leadGoProblems(dir, SHA)).toEqual([
      `lead-go-uncommitted: ${LEAD_GO_FILE} differs from the committed copy`,
    ]);
  });
  it("an uncommitted GO is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-go-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "docs/benchmark"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
    writeFileSync(join(dir, LEAD_GO_FILE), JSON.stringify(GO));
    expect(leadGoProblems(dir, SHA)).toEqual([
      `lead-go-uncommitted: ${LEAD_GO_FILE} is not committed`,
    ]);
  });
  it("each precondition is refused on its own", () => {
    const one = (o: Partial<typeof base>) =>
      liveRefusals({ ...base, repoRoot: goRepo(GO), ...o })
        .map((r) => r.split(":")[0])
        .filter((c) => c !== "cold-boot-guard-missing");
    expect(one({})).toEqual([]);
    expect(one({ launchRealTrials: false })).toEqual(["launch-flag-missing"]);
    expect(one({ pinnedPlanSha256: undefined })).toEqual(["plan-sha256-mismatch"]);
    expect(one({ envNames: ["CLAUDE_CODE_USE_BEDROCK"] })).toEqual(["api-key-path-configured"]);
    expect(one({ vmLockHeld: false })).toEqual(["vm-lock-not-held"]);
  });
  it("the plan hash is stable for the reviewed inputs", () => {
    const r = cli(["plan"]);
    expect(JSON.parse(r.stdout).planSha256).toBe(SHA);
    expect(readFileSync(join(ROOT, "scripts/guest/hcu-shell.ps1")).length).toBeGreaterThan(0);
  }, 120_000);
});
