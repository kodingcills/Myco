import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverPrecondition } from "../src/baseline/index.ts";

const EXPECTED_VERSION = "0.56.4";
const SESSION_MARKERS = new Map([
  ["C1_SESSION_MATCH", "match"],
  ["C1_CALC_PID_UNRESOLVED", "calc-pid-unresolved"],
  ["C1_DAEMON_ENUMERATION_FAILED", "daemon-enumeration-failed"],
  ["C1_DAEMON_MISSING", "daemon-missing"],
  ["C1_DAEMON_AMBIGUOUS", "daemon-ambiguous"],
  ["C1_SESSION_NONINTERACTIVE", "session-noninteractive"],
  ["C1_SESSION_MISMATCH", "session-mismatch"],
]);

function queryGuest(command: string): string {
  return execFileSync(join(homedir(), "VMs/myco-win11/scripts/vssh"), [command], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function probeC1Driver(calcPid: number, pipeReachable: boolean, query = queryGuest) {
  const driver: DriverPrecondition = {
    hostVersion: EXPECTED_VERSION,
    guestVersion: "",
    pipeReachable,
    sessionIdentityMatches: false,
  };
  if (!pipeReachable) return { driver, diagnostic: "pipe-unreachable" };
  if (!Number.isSafeInteger(calcPid) || calcPid <= 0)
    return { driver, diagnostic: "calc-pid-invalid" };
  try {
    driver.guestVersion =
      query("C:\\myco\\bin\\cua-driver.exe --version")
        .trim()
        .match(/(?:^|\s)v?(\d+\.\d+\.\d+)$/)?.[1] ?? "";
  } catch {
    return { driver, diagnostic: "version-command-failed" };
  }
  if (!driver.guestVersion) return { driver, diagnostic: "version-output-invalid" };
  if (driver.guestVersion !== EXPECTED_VERSION) return { driver, diagnostic: "version-mismatch" };

  let output: string;
  try {
    output = query(
      `try { $calc = Get-Process -Id ${calcPid} -ErrorAction Stop } catch { 'C1_CALC_PID_UNRESOLVED'; return }; ` +
        "try { $daemon = @(Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" -ErrorAction Stop | " +
        "Where-Object { $_.CommandLine -match '\\bserve\\b' }) } catch { 'C1_DAEMON_ENUMERATION_FAILED'; return }; " +
        "if ($daemon.Count -eq 0) { 'C1_DAEMON_MISSING'; return }; " +
        "if ($daemon.Count -ne 1) { 'C1_DAEMON_AMBIGUOUS'; return }; " +
        "if ($null -eq $calc.SessionId -or $calc.SessionId -le 0 -or $null -eq $daemon[0].SessionId -or $daemon[0].SessionId -le 0) " +
        "{ 'C1_SESSION_NONINTERACTIVE'; return }; " +
        "if ($daemon[0].SessionId -ne $calc.SessionId) { 'C1_SESSION_MISMATCH'; return }; " +
        "'C1_SESSION_MATCH'",
    );
  } catch {
    return { driver, diagnostic: "session-command-failed" };
  }

  // Only an exact allowlisted marker is evidence. Never retain guest output.
  const diagnostic = SESSION_MARKERS.get(output.trim()) ?? "session-marker-invalid";
  driver.sessionIdentityMatches = diagnostic === "match";
  return { driver, diagnostic };
}
