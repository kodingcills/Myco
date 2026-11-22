import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "../src/baseline/c1.ts";
import type { DriverPrecondition } from "../src/baseline/index.ts";

const EXPECTED_VERSION = "0.56.4";

function classifySession(output: string): string {
  const marker = output.trim();
  if (marker === "C1_CALC_PID_UNRESOLVED") return "calc-pid-unresolved";
  if (marker === "C1_DAEMON_ENUMERATION_FAILED") return "daemon-enumeration-failed";

  let snapshot: Record<string, unknown>;
  try {
    snapshot = record(JSON.parse(marker));
  } catch {
    return "session-marker-invalid";
  }
  if (!("calcSession" in snapshot) || !Array.isArray(snapshot.processes))
    return "session-marker-invalid";

  const daemons: unknown[] = [];
  for (const process of snapshot.processes) {
    const { CommandLine, SessionId } = record(process);
    if (typeof CommandLine !== "string") return "daemon-command-line-unreadable";

    // Accept quoted and unquoted Windows executable paths. Only the first
    // argument can identify the serve subcommand.
    const command =
      /^[ \t]*(?:"[^"]*\\cua-driver\.exe"|"cua-driver\.exe"|(?:[^" \t]*\\)?cua-driver\.exe)(?=[ \t]|$)(?:[ \t]+("[^"]*"|[^" \t]+)(?=[ \t]|$))?/i.exec(
        CommandLine,
      );
    if (!command) return "daemon-command-line-unreadable";
    if (/[^ \t]/.test(CommandLine.slice(command[0].length)) && !command[1])
      return "daemon-command-line-unreadable";
    if (command[1] === "serve" || command[1] === '"serve"') daemons.push(SessionId);
  }
  if (daemons.length === 0) return "daemon-missing";
  if (daemons.length !== 1) return "daemon-ambiguous";
  const interactive = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  if (!interactive(snapshot.calcSession) || !interactive(daemons[0]))
    return "session-noninteractive";
  return daemons[0] === snapshot.calcSession ? "match" : "session-mismatch";
}

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
        "try { $processes = @(Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" -ErrorAction Stop | " +
        "Select-Object CommandLine, SessionId) } catch { 'C1_DAEMON_ENUMERATION_FAILED'; return }; " +
        "@{ calcSession = $calc.SessionId; processes = $processes } | ConvertTo-Json -Compress -Depth 3",
    );
  } catch {
    return { driver, diagnostic: "session-command-failed" };
  }

  // Never retain guest output or command lines.
  const diagnostic = classifySession(output);
  driver.sessionIdentityMatches = diagnostic === "match";
  return { driver, diagnostic };
}
