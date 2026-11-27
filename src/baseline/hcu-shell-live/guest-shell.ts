/**
 * TIF-268 - the live `GuestShell` for the `hcu+shell` arm: each shell call runs the committed
 * guest helper `scripts/guest/hcu-shell.ps1` over SSH, with the path the host already checked
 * (`checkShellRequest`), base64-encoded so no shell on the way parses it.
 *
 * The helper reports every path it touched, resolved through the open handle. This module
 * reads that report strictly and THROWS on anything it cannot read (non-zero exit, no JSON, a
 * malformed access list): the trial loop then records the call `incomplete` and the row's
 * shell integrity `unaudited`, so the row is `uncertain`, never a silent pass. The resolved
 * accesses are held to the boundary by the loop (`checkResolvedAccesses`), not here.
 */
import type { GuestShell, ShellAccess, ShellRequest } from "../hcu-shell/shell-tool.ts";

/** Where prepare puts the helper in the guest (outside both read roots). */
export const GUEST_SHELL_SCRIPT = "C:\\myco\\harness\\hcu-shell.ps1";

export type GuestRun = (command: string) => Promise<{ stdout: string; code: number | null }>;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The guest command line for one call. Base64 and fixed tokens only: nothing to quote. */
export function guestShellCommand(
  request: ShellRequest,
  scratchDir: string,
  script = GUEST_SHELL_SCRIPT,
): string {
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Op",
    request.shell,
    "-PathB64",
    b64(request.path),
    "-ScratchB64",
    b64(scratchDir),
  ].join(" ");
}

/** Parse the helper's one JSON line; null when it is not exactly the documented shape. */
export function parseGuestShellOutput(
  stdout: string,
): { output: string; accesses: ShellAccess[] } | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length !== 1) return null;
  let v: unknown;
  try {
    v = JSON.parse(lines[0] as string);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "accesses,output") return null;
  if (typeof r.output !== "string" || !Array.isArray(r.accesses)) return null;
  const accesses: ShellAccess[] = [];
  for (const a of r.accesses) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) return null;
    const { operation, path } = a as Record<string, unknown>;
    if (Object.keys(a).length !== 2) return null;
    if ((operation !== "read" && operation !== "write") || typeof path !== "string" || path === "")
      return null;
    accesses.push({ operation, path });
  }
  // A call that reports touching nothing cannot be audited.
  if (accesses.length === 0) return null;
  return { output: r.output, accesses };
}

export function sshGuestShell(
  run: GuestRun,
  scratchDir: string,
  script = GUEST_SHELL_SCRIPT,
): GuestShell {
  return {
    async run(request) {
      const ran = await run(guestShellCommand(request, scratchDir, script));
      if (ran.code !== 0) throw new Error("guest-shell-failed");
      const parsed = parseGuestShellOutput(ran.stdout);
      if (parsed === null) throw new Error("guest-shell-malformed");
      return parsed;
    },
  };
}
