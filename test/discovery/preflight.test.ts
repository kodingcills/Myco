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

  it("does not accept truthy non-boolean values", () => {
    const result = runPreflight({ ...allPass, coordinatorGo: "yes" as unknown as boolean });
    expect(result.ok).toBe(false);
    expect(result.abort).toContain("Coordinator GO for this host window");
  });
});
