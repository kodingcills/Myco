/**
 * Guest batch runner for host-side hygiene ops (M1-019 / TIF-48).
 *
 * The agent's op vocabulary (agent/README.md) has no directory listing or
 * deletion — only launch, read_file, write_file and kill. Since the host is
 * the trusted caller and `launch` already runs arbitrary argv in the
 * interactive session, small cmd.exe batches are the primitive used for the
 * two hygiene jobs: enumerate the guest run root and delete trial residue.
 *
 * One fixed script/report pair per batch name under `<runRoot>\myco-admin`
 * (excluded from run-dir hygiene). The report is truncated at the start of
 * every invocation and terminated by a per-invocation nonce marker, so a
 * stale report from a previous trial can never be mistaken for a fresh one.
 * Trials are serialized; a fixed name keeps scratch files from accumulating.
 */

import type { AgentClient } from "../win/agent-client.js";

/** Written by every batch as its final report line; carries a nonce. */
export const GUEST_BATCH_END = "__MYCO_BATCH_END__";

/** Host control dir under the guest run root; never a trial run dir. */
export const GUEST_ADMIN_DIRNAME = "myco-admin";

/** Trailing segment of a guest path (Windows and POSIX separators). */
export function guestBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return trimmed.slice(cut + 1);
}

export function guestAdminDir(runRoot: string): string {
  return `${runRoot.replace(/[\\/]+$/, "")}\\${GUEST_ADMIN_DIRNAME}`;
}

export interface GuestScriptPaths {
  scriptPath: string;
  reportPath: string;
}

/** Deterministic paths for a named batch (also used to delete its scratch). */
export function guestScriptPaths(runRoot: string, name: string): GuestScriptPaths {
  const admin = guestAdminDir(runRoot);
  return { scriptPath: `${admin}\\${name}.cmd`, reportPath: `${admin}\\${name}.out` };
}

export interface GuestScriptOptions {
  client: AgentClient;
  runRoot: string;
  /** Batch name: a fixed, lowercase basename (e.g. "probe", "cleanup"). */
  name: string;
  /**
   * cmd.exe lines. `%REPORT%` is replaced by the quoted report path, so
   * callers never have to deal with quoting the destination themselves.
   */
  lines: readonly string[];
  timeoutMs?: number;
  pollMs?: number;
}

/** Write, launch and wait for one guest batch. Throws if it never reports. */
export async function runGuestScript(options: GuestScriptOptions): Promise<string> {
  if (options.runRoot.includes('"')) {
    throw new Error(`guest run root cannot contain a quote: ${options.runRoot}`);
  }
  if (!/^[a-z0-9-]+$/.test(options.name)) {
    throw new Error(`invalid guest batch name: ${options.name}`);
  }
  const { scriptPath, reportPath } = guestScriptPaths(options.runRoot, options.name);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  // The nonce is written by THIS invocation. A stale report ends with a
  // different nonce (or no marker at all) and is never accepted.
  const nonce = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const end = `${GUEST_BATCH_END}${nonce}`;
  const quotedReport = `"${reportPath}"`;
  const body = [
    "@echo off",
    `del /q ${quotedReport} 2>nul`,
    ...options.lines.map((line) => line.replaceAll("%REPORT%", quotedReport)),
    `echo ${end}>>${quotedReport}`,
    "",
  ].join("\r\n");
  await options.client.writeFile(scriptPath, Buffer.from(body, "utf8"));
  await options.client.launch(["cmd.exe", "/c", scriptPath]);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = (await options.client.readFile(reportPath)).toString("utf8");
      const at = text.lastIndexOf(end);
      if (at >= 0) return text.slice(0, at);
    } catch {
      // batch has not created the report yet — keep polling
    }
    if (Date.now() >= deadline) {
      throw new Error(`guest batch ${options.name} produced no report within ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
