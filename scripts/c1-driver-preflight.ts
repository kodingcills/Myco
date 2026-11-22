import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DriverPrecondition } from "../src/baseline/index.ts";

const EXPECTED_VERSION = "0.56.4";

export function probeC1Driver(calcPid: number, pipeReachable: boolean): DriverPrecondition {
  const evidence = {
    hostVersion: EXPECTED_VERSION,
    guestVersion: "",
    pipeReachable,
    sessionIdentityMatches: false,
  };
  if (!pipeReachable || !Number.isSafeInteger(calcPid) || calcPid <= 0) return evidence;
  const ssh = join(homedir(), "VMs/myco-win11/scripts/vssh");
  const query = (command: string) =>
    execFileSync(ssh, [command], { encoding: "utf8", timeout: 15_000 });
  try {
    evidence.guestVersion =
      query("C:\\myco\\bin\\cua-driver.exe --version")
        .trim()
        .match(/(?:^|\s)v?(\d+\.\d+\.\d+)$/)?.[1] ?? "";
    const sessions = query(
      `$calc = Get-Process -Id ${calcPid} -ErrorAction Stop; ` +
        "$daemon = @(Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | " +
        "Where-Object { $_.CommandLine -match '\\bserve\\b' }); " +
        "if ($daemon.Count -eq 1 -and $calc.SessionId -gt 0 -and " +
        "$daemon[0].SessionId -eq $calc.SessionId) { 'C1_SESSION_MATCH' }",
    );
    evidence.sessionIdentityMatches = sessions.trim() === "C1_SESSION_MATCH";
  } catch {
    // Probe failures leave readiness unconfirmed.
  }
  return evidence;
}
