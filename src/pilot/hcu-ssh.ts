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
 * HCU through the arm's own client (`connectHcuGui`: the `GUI` tool must be served), and get
 * ONE screenshot that succeeds (a valid PNG/JPEG image; HCU attached to no interactive desktop
 * cannot produce one), allowing a bounded warm-up on a freshly booted guest: at most
 * `HCU_WARMUP_ATTEMPTS` (3) screenshots, `HCU_WARMUP_SPACING_MS` (10 s) apart. All attempts
 * failing, anything else failing, or the bound passing, rejects. The caller turns a rejection
 * into a harness fault; no HCU text is carried, and each attempt is logged as a code.
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

/** The pre-agent probe's bound: connect, initialise and the warm-up screenshots. */
export const HCU_PROBE_TIMEOUT_MS = 60_000;

/**
 * The pre-agent probe's screenshot WARM-UP (VM-owner findings on #733, lead ruling 15:44Z): on
 * a freshly booted guest HCU's first GUI screenshot can time out inside HCU's Windows runtime,
 * and a retry seconds later succeeds. So the probe takes at most `HCU_WARMUP_ATTEMPTS`
 * screenshots, `HCU_WARMUP_SPACING_MS` apart, and passes on the first that succeeds; only when
 * all of them fail does it reject. Fixed harness constants: no config field, flag or argument
 * changes them, and the agent has no path to the probe at all. The whole warm-up stays inside
 * `HCU_PROBE_TIMEOUT_MS`.
 */
export const HCU_WARMUP_ATTEMPTS = 3;
export const HCU_WARMUP_SPACING_MS = 10_000;

/** The probe's harness-log lines. Codes only: never HCU's text. */
export const HCU_PROBE_LOG = {
  connectFailed: "hcu-probe: connect failed",
  timeout: "hcu-probe: bound passed",
  attempt: (n: number, outcome: "ok" | "failed") =>
    `hcu-probe: warm-up screenshot ${n}/${HCU_WARMUP_ATTEMPTS} ${outcome}`,
} as const;

/** What the caller injects: the harness log, and (tests only) the clock for the spacing. */
export interface HcuProbeHooks {
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 * The pre-agent HCU check: open, initialise (GUI tool served), then the bounded warm-up: at
 * most `HCU_WARMUP_ATTEMPTS` screenshots, `HCU_WARMUP_SPACING_MS` apart (no wait after the
 * last). Resolves only once one screenshot succeeded; rejects when every attempt failed, when
 * the open or initialise failed (no retry: that is not a warm-up), or when `timeoutMs` passes
 * (the bound covers the whole warm-up). Each attempt is logged as a code. The session is
 * always closed. The rejection carries no HCU text.
 */
export async function probeHcuDesktop(
  open: () => HcuSession,
  timeoutMs: number = HCU_PROBE_TIMEOUT_MS,
  hooks: HcuProbeHooks = {},
): Promise<void> {
  const log = hooks.log ?? (() => {});
  const sleep = hooks.sleep ?? realSleep;
  let session: HcuSession | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("hcu-probe-timeout"));
    }, timeoutMs);
  });
  const warmUp = async () => {
    let gui: Awaited<ReturnType<typeof connectHcuGui>>;
    try {
      session = open();
      gui = await connectHcuGui(session.mcp);
    } catch (error) {
      if (!expired) log(HCU_PROBE_LOG.connectFailed);
      throw error;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await gui.screenshot();
      } catch {
        if (expired) throw new Error("hcu-probe-timeout");
        log(HCU_PROBE_LOG.attempt(attempt, "failed"));
        if (attempt >= HCU_WARMUP_ATTEMPTS) throw new Error("hcu-warmup-exhausted");
        await sleep(HCU_WARMUP_SPACING_MS);
        if (expired) throw new Error("hcu-probe-timeout");
        continue;
      }
      if (expired) throw new Error("hcu-probe-timeout");
      log(HCU_PROBE_LOG.attempt(attempt, "ok"));
      return;
    }
  };
  try {
    await Promise.race([warmUp(), bound]);
  } catch {
    if (expired) log(HCU_PROBE_LOG.timeout);
    throw new Error("hcu-unreachable");
  } finally {
    clearTimeout(timer);
    (session as HcuSession | null)?.close();
  }
}
