/**
 * Track E guards: the subscription-only preflight (names only, never values), the child
 * environment allowlist, and the CLI that cannot start a real trial in this change (explicit
 * flag + the printed plan's hash, then a refusal). These tests never run `claude` or a model.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_ENV_ALLOWLIST } from "../../src/pilot/config.ts";
import {
  API_CREDENTIAL_NAMES,
  childEnv,
  preflightRefusal,
  subscriptionPreflight,
} from "../../src/pilot/launch.ts";
import { ROOT, tmp } from "./helpers.ts";

const CLI = join(ROOT, "scripts", "m2-r1-pilot.ts");
/** A minimal child environment: no inherited variable can stand in for a credential. */
const baseEnv = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmp("myco-pilot-home-"),
});
const cli = (args: string[], env: Record<string, string>) =>
  spawnSync("npx", ["tsx", CLI, ...args], { cwd: ROOT, env, encoding: "utf8" });

describe("subscription preflight (names only)", () => {
  it("refuses when any API-path credential name is configured, even empty", () => {
    for (const name of API_CREDENTIAL_NAMES) {
      const r = subscriptionPreflight(["PATH", "HOME", name]);
      expect(r.ok, name).toBe(false);
      expect(r.configured).toEqual([name]);
    }
    expect(subscriptionPreflight(["PATH", "HOME", "CLAUDE_CODE_OAUTH_TOKEN_x"]).ok).toBe(true);
  });

  it("reads names only: an environment whose values throw on access still preflights", () => {
    const env = new Proxy({ ANTHROPIC_API_KEY: "x", PATH: "y" } as Record<string, string>, {
      get() {
        throw new Error("a value was read");
      },
    });
    const r = subscriptionPreflight(Object.keys(env));
    expect(r).toEqual({ ok: false, configured: ["ANTHROPIC_API_KEY"] });
    expect(preflightRefusal(r)).toContain("ANTHROPIC_API_KEY");
  });

  it("the agent's environment carries allowlisted names only", () => {
    const parent = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "synthetic", OTHER: "o" };
    const env = childEnv(parent, CHILD_ENV_ALLOWLIST);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    for (const name of API_CREDENTIAL_NAMES) expect(CHILD_ENV_ALLOWLIST).not.toContain(name);
  });
});

describe("the runner CLI cannot start real trials in this change", () => {
  it("launch with an API-path variable set: refused, the name printed, the value never", {
    timeout: 60_000,
  }, () => {
    const r = cli(["launch", "--out", tmp(), "--launch-real-trials"], {
      ...baseEnv(),
      ANTHROPIC_API_KEY: "synthetic-value-not-a-key-7f3a",
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
    expect(`${r.stdout}${r.stderr}`).not.toContain("synthetic-value-not-a-key-7f3a");
  });

  it("launch without the flag or with a wrong plan hash: refused after printing the plan", {
    timeout: 60_000,
  }, () => {
    const out = tmp();
    const bare = cli(["launch", "--out", out], baseEnv());
    expect(bare.status).toBe(3);
    const plan = JSON.parse(bare.stdout) as { configSha256: string };
    expect(plan.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bare.stderr).toMatch(/--launch-real-trials and --plan-sha256/);
    const wrong = cli(
      ["launch", "--out", out, "--launch-real-trials", "--plan-sha256", "0".repeat(64)],
      baseEnv(),
    );
    expect(wrong.status).toBe(3);
    expect(wrong.stderr).toMatch(/--launch-real-trials and --plan-sha256/);
    // Flag and the right hash: still refused, because the live path is a later step.
    const right = cli(
      ["launch", "--out", out, "--launch-real-trials", "--plan-sha256", plan.configSha256],
      baseEnv(),
    );
    expect(right.status).toBe(3);
    expect(right.stderr).toMatch(/later, lead-approved step/);
  });

  it("the CLI wires no live transport and spawns no process", () => {
    const src = readFileSync(CLI, "utf8");
    expect(src).not.toMatch(/from "[^"]*(claude-transport|child_process)[^"]*"/);
    expect(src).not.toMatch(/claudeDriver\(/);
  });

  it("no pilot test runs the claude CLI: transports are fakes", () => {
    const dir = join(ROOT, "test", "pilot");
    for (const f of ["config.test.ts", "resume.test.ts", "pacing.test.ts", "dry-run.test.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/claudeDriver|claude-transport|["'`]claude["'`]/);
    }
    const transport = readFileSync(join(dir, "claude-transport.test.ts"), "utf8");
    // Type-only imports are fine; a value import could spawn a real process.
    expect(transport).not.toMatch(/^import (?!type )[^;]*from "node:child_process"/m);
  });
});
