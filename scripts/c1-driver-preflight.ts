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

  // Both ids must be valid before any comparison, so a mismatch is never
  // reported between two values that were never comparable.
  const interactive = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0;

  const daemons: unknown[] = [];
  let sawUnreadable = false;
  for (const process of snapshot.processes) {
    const { CommandLine, SessionId } = record(process);
    // An unreadable candidate is counted and skipped rather than returned on, so
    // the loop still inspects every process. Its effect is not a new class:
    // `sawUnreadable` aborts below, so two unreadable candidates still report
    // `daemon-command-line-unreadable`. Counting buys the guarantee that a
    // readable serve daemon is never missed because an unreadable one came first.
    if (typeof CommandLine !== "string") {
      sawUnreadable = true;
      continue;
    }

    // Accept quoted and unquoted Windows executable paths. Only the first
    // argument can identify the serve subcommand, and nothing may follow it.
    const command =
      /^[ \t]*(?:"[^"]*\\cua-driver\.exe"|"cua-driver\.exe"|(?:[^" \t]*\\)?cua-driver\.exe)(?=[ \t]|$)(?:[ \t]+("[^"]*"|[^" \t]+)(?=[ \t]|$))?/i.exec(
        CommandLine,
      );
    // Reject any tail after the first argument. An earlier form of this guard
    // was unreachable — the regex had already consumed the leading whitespace,
    // so `/[^ \t]/.test(rest)` and `!command[1]` could never both hold — which
    // let `cua-driver.exe serve cmd.exe /c ...` classify as `match` and be kept
    // as telemetry, contradicting the "never retain command lines" invariant at
    // the call site below.
    // `serve` legitimately takes flags (`serve --socket pipe`), so only a tail
    // that does NOT begin with a flag is a refusal. That separates the real
    // forms from a smuggled command, which is what the dead guard above failed
    // to do.
    if (!command) {
      sawUnreadable = true;
      continue;
    }
    // `serve` is invoked with exactly one optional flag pair, so the tail is
    // validated against that grammar rather than guessed from a prefix. A
    // prefix test would accept `serve --socket pipe extra` — the very smuggling
    // the dead guard was supposed to stop.
    const isServe = command[1] === "serve" || command[1] === '"serve"';
    const tail = CommandLine.slice(command[0].length).trim();
    // The tail grammar only applies to `serve`. A cua-driver that is not serving
    // (a `call`, say) is not a daemon candidate at all, so `daemon-missing` is
    // the honest answer for it — not `daemon-command-line-unreadable`, which
    // means we could not READ a candidate, not that we read one we do not want.
    if (isServe && !/^(?:--socket[ \t]+\S+)?$/.test(tail)) {
      sawUnreadable = true;
      continue;
    }
    if (isServe) daemons.push(SessionId);
  }
  // Abort on any unreadable candidate: it may be the serving daemon, or a second
  // one whose kind we cannot name, and neither permits `match`. This precedes the
  // missing/ambiguous split because "we could not read a candidate" is a
  // different statement from "there were none" or "there were too many".
  if (sawUnreadable) return "daemon-command-line-unreadable";
  if (daemons.length === 0) return "daemon-missing";
  if (daemons.length !== 1) return "daemon-ambiguous";
  // Interactivity before identity: an unreadable id is its own condition.
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
