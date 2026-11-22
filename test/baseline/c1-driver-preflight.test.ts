import { describe, expect, it, vi } from "vitest";
import { probeC1Driver } from "../../scripts/c1-driver-preflight.ts";
import { driverReady } from "../../src/baseline/index.ts";

const process = (CommandLine: string | null, SessionId = 2) => ({ CommandLine, SessionId });
const daemon = process('"C:\\Program Files\\Cua\\cua-driver.exe" serve --socket pipe');
const snapshot = (processes: ReturnType<typeof process>[], calcSession = 2) =>
  JSON.stringify({ calcSession, processes });

describe("C1 driver session preflight", () => {
  it.each([
    ["C1_CALC_PID_UNRESOLVED", "calc-pid-unresolved"],
    ["C1_DAEMON_ENUMERATION_FAILED", "daemon-enumeration-failed"],
    [snapshot([]), "daemon-missing"],
    [snapshot([daemon, daemon]), "daemon-ambiguous"],
    [snapshot([daemon], 0), "session-noninteractive"],
    [snapshot([daemon], 1), "session-mismatch"],
    [snapshot([process("cua-driver.exe serve", 0)]), "session-noninteractive"],
    [snapshot([daemon]), "match"],
    [snapshot([process("cua-driver.exe\tserve\t--socket pipe")]), "match"],
    [snapshot([process("cua-driver.exe serve\u00a0--socket pipe")]), "daemon-missing"],
    [snapshot([process('C:\\serve\\cua-driver.exe call --argument "serve"')]), "daemon-missing"],
    [
      snapshot([process("cua-driver.exe call --name serve"), process("cua-driver.exe serve", 1)]),
      "session-mismatch",
    ],
    [snapshot([daemon, process(null)]), "daemon-command-line-unreadable"],
    [snapshot([daemon, process("private guest output")]), "daemon-command-line-unreadable"],
    ["private guest output\nC1_SESSION_MATCH", "session-marker-invalid"],
    ["C1_SESSION_MATCH", "session-marker-invalid"],
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

  it("refuses a command line with a tail after the subcommand, instead of retaining it", () => {
    // The guard meant to catch this was unreachable: the regex had already eaten
    // the leading whitespace, so its two conjuncts could never both hold. A tail
    // therefore classified as `match` and was kept as telemetry, contradicting
    // the "never retain command lines" invariant.
    const withTail = [
      "cua-driver.exe serve cmd.exe /c whoami",
      '"C:\\Cua\\cua-driver.exe" serve --socket pipe extra',
      "cua-driver.exe serve SECRET_TAIL",
    ];
    // Each case asserts on its own so one failure cannot hide the others: the
    // guard this replaces was dead, so every one of these was accepted.
    const seen = withTail.map((commandLine) => {
      const query = vi
        .fn<(command: string) => string>()
        .mockReturnValueOnce("cua-driver 0.56.4")
        .mockReturnValueOnce(snapshot([process(commandLine)]));
      const result = probeC1Driver(42, true, query);
      return { commandLine, diagnostic: result.diagnostic, ready: driverReady(result.driver) };
    });
    expect(seen).toEqual(
      withTail.map((commandLine) => ({
        commandLine,
        diagnostic: "daemon-command-line-unreadable",
        ready: false,
      })),
    );
  });

  it("still accepts a legitimate serve line, with and without a socket argument", () => {
    for (const commandLine of [
      "cua-driver.exe serve",
      '"C:\\Program Files\\Cua\\cua-driver.exe" serve --socket pipe',
      "cua-driver.exe serve\t--socket\tpipe",
    ]) {
      const query = vi
        .fn<(command: string) => string>()
        .mockReturnValueOnce("cua-driver 0.56.4")
        .mockReturnValueOnce(snapshot([process(commandLine)]));
      expect(probeC1Driver(42, true, query).diagnostic, commandLine).toBe("match");
    }
  });

  it("reports an unreadable daemon rather than masking it, and keeps ambiguity reachable", () => {
    const two = (a: string | null, b: string | null) => snapshot([process(a), process(b, 3)]);
    // One readable serve plus one unreadable: the unreadable one is not ignored.
    expect(
      probeC1Driver(
        42,
        true,
        vi
          .fn<(command: string) => string>()
          .mockReturnValueOnce("cua-driver 0.56.4")
          .mockReturnValueOnce(two(daemon.CommandLine, null)),
      ).diagnostic,
    ).toBe("daemon-command-line-unreadable");
    // Both unreadable: ambiguity is still reported, not swallowed by the
    // earlier return-on-first-unreadable behaviour.
    expect(
      probeC1Driver(
        42,
        true,
        vi
          .fn<(command: string) => string>()
          .mockReturnValueOnce("cua-driver 0.56.4")
          .mockReturnValueOnce(two(null, null)),
      ).diagnostic,
    ).toBe("daemon-command-line-unreadable");
    // Two readable serve daemons remain genuinely ambiguous.
    expect(
      probeC1Driver(
        42,
        true,
        vi
          .fn<(command: string) => string>()
          .mockReturnValueOnce("cua-driver 0.56.4")
          .mockReturnValueOnce(snapshot([daemon, daemon])),
      ).diagnostic,
    ).toBe("daemon-ambiguous");
  });

  it("rejects invalid PID or mismatched version without running a session query", () => {
    const query = vi.fn(() => "cua-driver 0.56.5");
    expect(probeC1Driver(-1, true, query).diagnostic).toBe("calc-pid-invalid");
    expect(probeC1Driver(42, true, query).diagnostic).toBe("version-mismatch");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
