import { describe, expect, it, vi } from "vitest";
import { probeC1Driver } from "../../scripts/c1-driver-preflight.ts";
import { driverReady } from "../../src/baseline/index.ts";

describe("C1 driver session preflight", () => {
  it.each([
    ["C1_CALC_PID_UNRESOLVED", "calc-pid-unresolved"],
    ["C1_DAEMON_ENUMERATION_FAILED", "daemon-enumeration-failed"],
    ["C1_DAEMON_MISSING", "daemon-missing"],
    ["C1_DAEMON_AMBIGUOUS", "daemon-ambiguous"],
    ["C1_SESSION_NONINTERACTIVE", "session-noninteractive"],
    ["C1_SESSION_MISMATCH", "session-mismatch"],
    ["\r\nC1_SESSION_MATCH\r\n", "match"],
    ["private guest output\nC1_SESSION_MATCH", "session-marker-invalid"],
    ["", "session-marker-invalid"],
  ])("classifies %j without exposing raw guest output", (output, diagnostic) => {
    const query = vi
      .fn<(command: string) => string>()
      .mockReturnValueOnce("cua-driver 0.56.4\r\n")
      .mockReturnValueOnce(output);
    const result = probeC1Driver(42, true, query);
    expect(result.diagnostic).toBe(diagnostic);
    expect(driverReady(result.driver)).toBe(diagnostic === "match");
    expect(query.mock.calls[1]?.[0]).toContain("Get-Process -Id 42 -ErrorAction Stop");
    expect(JSON.stringify(result)).not.toContain("private guest output");
  });

  it("distinguishes command failures from guest markers without retaining raw exceptions", () => {
    const query = vi
      .fn<(command: string) => string>()
      .mockReturnValueOnce("cua-driver 0.56.4")
      .mockImplementation(() => {
        throw new Error("private SSH output");
      });
    for (const diagnostic of ["session-command-failed", "version-command-failed"]) {
      const result = probeC1Driver(42, true, query);
      expect(result.diagnostic).toBe(diagnostic);
      expect(driverReady(result.driver)).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private SSH output");
    }
  });

  it("rejects invalid PID or mismatched version without running a session query", () => {
    const query = vi.fn(() => "cua-driver 0.56.5");
    expect(probeC1Driver(-1, true, query).diagnostic).toBe("calc-pid-invalid");
    expect(probeC1Driver(42, true, query).diagnostic).toBe("version-mismatch");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
