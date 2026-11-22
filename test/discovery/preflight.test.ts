import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PreflightProbe,
  renderPreflight,
  runPreflight,
} from "../../src/discovery/preflight.ts";

const allPass: PreflightProbe = {
  coordinatorGo: true,
  hostLock: true,
  runtimeReachable: true,
  guestReady: true,
  appPresent: true,
  storeReadable: true,
  oraclePresent: true,
  guestClean: true,
};

describe("Direction A preflight", () => {
  it("passes only when every check is true", () => {
    const result = runPreflight(allPass);
    expect(result.ok).toBe(true);
    expect(result.abort).toEqual([]);
    expect(renderPreflight(result)).toContain("PREFLIGHT: PASS");
  });

  it("aborts on each missing check, by name", () => {
    for (const name of Object.keys(allPass) as (keyof PreflightProbe)[]) {
      const result = runPreflight({ ...allPass, [name]: false });
      expect(result.ok).toBe(false);
      expect(result.abort).toHaveLength(1);
      expect(result.checks.find((check) => check.name === name)?.ok).toBe(false);
    }
  });

  it("treats a missing or unreadable probe as an abort, never a pass", () => {
    for (const probe of [null, undefined, {}]) {
      const result = runPreflight(probe);
      expect(result.ok).toBe(false);
      expect(result.abort).toHaveLength(8);
    }
  });

  it("CLI exit codes: 0 pass, 2 abort, 3 unreadable", () => {
    const root = join(import.meta.dirname, "..", "..");
    const dir = mkdtempSync(join(tmpdir(), "myco-preflight-"));
    const run = (content: string) => {
      const probe = join(dir, "probe.json");
      writeFileSync(probe, content);
      return spawnSync(
        "pnpm",
        ["exec", "tsx", "scripts/discovery-preflight.ts", "--probe", probe],
        { cwd: root, encoding: "utf8" },
      );
    };
    expect(run(JSON.stringify(allPass)).status).toBe(0);
    expect(run(JSON.stringify({ ...allPass, guestClean: false })).status).toBe(2);
    expect(run("{not json").status).toBe(3);
  });

  it("does not accept truthy non-boolean values", () => {
    const result = runPreflight({ ...allPass, coordinatorGo: "yes" as unknown as boolean });
    expect(result.ok).toBe(false);
    expect(result.abort).toContain("Coordinator GO for this host window");
  });
});
