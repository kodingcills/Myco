/**
 * The one SSH channel to HCU in the trial guest (#732, #733 round 2), shared by the agent's
 * actuator CLI (`scripts/myco-hcu.ts`) and the VM step's PRE-AGENT probe
 * (`realVmBackend().probeHcu`, `src/pilot/vm-capture.ts`), so both reach HCU with the very
 * same command line:
 *
 *   ssh -F ~/VMs/myco-win11/ssh_config -o LogLevel=ERROR myco-win11 '<HCU attach command>'
 *
 * The HCU command must be the ATTACH form (`isHcuAttachCommand`; VM-owner finding on #733,
 * lead ruling 14:00Z): `computer-use.exe mcp --attach <session socket>` reaches the HCU that
 * the trial base's `MycoHCU` logon task serves in the interactive session (#734). A bare
 * `computer-use.exe mcp` runs in SSH's session 0 and is refused before anything is spawned.
 *
 * `probeHcuDesktop` is the lead's 13:38Z B1 check, modelled on hcu+shell's
 * (`src/baseline/hcu-shell-live/live-vm.ts`, `hcu-unreachable`): open the channel, initialise
 * HCU through the arm's own client (`connectHcuGui`: the `GUI` tool must be served), and take
 * ONE screenshot that must succeed (a valid PNG/JPEG image; HCU attached to no interactive
 * desktop cannot produce one). Anything else, or the bound passing, rejects. The caller turns a
 * rejection into a harness fault; no HCU text is carried.
 *
 * No secret is read here; SSH authenticates with the operator's own SSH setup.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";
import type { Mcp } from "../baseline/c1.ts";
import { connectHcuGui } from "../baseline/hcu-shell/hcu-gui.ts";
import { mcpStdio } from "../baseline/mcp-stdio.ts";
import { isHcuAttachCommand } from "../integrity/surface.ts";

/** The trial VM's SSH host alias (as the `hcu+shell` arm's live VM). */
export const HCU_SSH_HOST = "myco-win11";

/** The pre-agent probe's bound: connect, initialise and one screenshot. */
export const HCU_PROBE_TIMEOUT_MS = 60_000;

export type HcuSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** One open HCU MCP session. */
export interface HcuSession {
  readonly mcp: Mcp;
  close(): void;
}

/** The `ssh` argv for one HCU session; a non-attach command throws before any spawn. */
export function hcuSshArgs(hcuCommand: string, home: string): string[] {
  if (!isHcuAttachCommand(hcuCommand))
    throw new Error("the HCU command must be the attach form: computer-use.exe mcp --attach");
  return [
    "-F",
    join(home, "VMs", HCU_SSH_HOST, "ssh_config"),
    "-o",
    "LogLevel=ERROR",
    HCU_SSH_HOST,
    hcuCommand,
  ];
}

/** Open HCU in the guest over SSH (stderr is dropped: HCU text never reaches anyone). */
export function openHcuSession(spawn: HcuSpawn, hcuCommand: string, home: string): HcuSession {
  const child = spawn("ssh", hcuSshArgs(hcuCommand, home), {
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (child.stdin === null || child.stdout === null) {
    child.kill();
    throw new Error("ssh started without pipes");
  }
  const mcp = mcpStdio(child.stdin, child.stdout);
  return {
    mcp,
    close() {
      mcp.close();
      child.kill();
    },
  };
}

/**
 * The pre-agent HCU check: open, initialise (GUI tool served), ONE successful screenshot.
 * Resolves only then; rejects on anything else or when `timeoutMs` passes. The session is
 * always closed. The rejection carries no HCU text.
 */
export async function probeHcuDesktop(
  open: () => HcuSession,
  timeoutMs: number = HCU_PROBE_TIMEOUT_MS,
): Promise<void> {
  let session: HcuSession | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("hcu-probe-timeout")), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        session = open();
        const gui = await connectHcuGui(session.mcp);
        await gui.screenshot();
      })(),
      bound,
    ]);
  } catch {
    throw new Error("hcu-unreachable");
  } finally {
    clearTimeout(timer);
    (session as HcuSession | null)?.close();
  }
}
