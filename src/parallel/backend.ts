/**
 * Track L (safe parallelism) — the disposable-desktop backend interface.
 *
 * A backend makes one isolated, disposable desktop per trial and destroys it afterwards.
 * The pool (`./pool.ts`) never trusts a backend's word alone: it checks the desktop's
 * `IsolationReport` against the operator's `IsolationRequirements` before the trial is
 * sealed, and it checks the `DestroyReport` after. Either check failing makes the trial
 * not-verified (fail closed).
 *
 * Backends:
 * - `linux-ns` / `linux-plain` (`./linux-backend.ts`): per-trial user+mount+net+pid
 *   namespaces with a private /tmp, private root and in-namespace Xvfb; or, where
 *   unprivileged namespaces are unavailable, a process group with a private root and
 *   TMPDIR only (which an operator requirement of `network: "required"` refuses).
 * - microVM (lands with U): implements `DesktopBackend` with `kind: "microvm"`. The pool
 *   needs nothing else from it. See docs/product/safe-parallelism.md §6 for the contract.
 */

/** How strongly a desktop is isolated, as the backend set it up (not as it hoped). */
export interface IsolationReport {
  readonly backend: string;
  readonly kind: "namespace" | "process" | "container" | "microvm" | "fake";
  /** The trial has a private root dir no other trial is given. */
  readonly privateRoot: boolean;
  /** Other trials' roots and the host's run, vault and evidence dirs are not visible inside. */
  readonly hostDirsHidden: boolean;
  /** "mount-ns": a private tmpfs on /tmp; "env": only TMPDIR points into the root. */
  readonly tmp: "mount-ns" | "env" | "vm";
  /** "netns": a network namespace with loopback only; "none": no network device at all. */
  readonly network: "netns" | "none" | "shared";
  /** All of the trial's processes die with the desktop (pid namespace, VM, or process group). */
  readonly processes: "pid-ns" | "process-group" | "vm";
  readonly display: { readonly kind: "xvfb" | "none" | "vm"; readonly id?: string };
}

export interface IsolationRequirements {
  /** "required": a trial without its own network namespace (or none) is refused. */
  readonly network: "required" | "best-effort";
  /** "required": a trial whose /tmp is shared with the host is refused. */
  readonly privateTmp: "required" | "best-effort";
  /** "required": a trial that can see other trials' roots is refused. */
  readonly hideHostDirs: "required" | "best-effort";
  readonly display: "xvfb" | "none";
}

export const STRICT_REQUIREMENTS: IsolationRequirements = {
  network: "required",
  privateTmp: "required",
  hideHostDirs: "required",
  display: "none",
};

/** Why `report` does not meet `req`, empty when it does. Every check fails closed. */
export function isolationShortfalls(
  report: IsolationReport | undefined,
  req: IsolationRequirements,
): string[] {
  if (!report || typeof report !== "object") return ["no isolation report"];
  const out: string[] = [];
  if (report.privateRoot !== true) out.push("no private root");
  if (
    report.processes !== "pid-ns" &&
    report.processes !== "process-group" &&
    report.processes !== "vm"
  )
    out.push("processes do not die with the desktop");
  if (req.network !== "best-effort" && report.network !== "netns" && report.network !== "none")
    out.push(`network ${String(report.network)}: a private network was required`);
  if (req.privateTmp !== "best-effort" && report.tmp !== "mount-ns" && report.tmp !== "vm")
    out.push(`tmp ${String(report.tmp)}: a private /tmp was required`);
  if (req.hideHostDirs !== "best-effort" && report.hostDirsHidden !== true)
    out.push("other trials' roots are visible: hidden host dirs were required");
  if (req.display === "xvfb" && report.display?.kind !== "xvfb" && report.display?.kind !== "vm")
    out.push(`display ${String(report.display?.kind)}: an Xvfb display was required`);
  return out;
}

export interface ExecOptions {
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  /** Extra env, merged over the desktop's own (HOME, TMPDIR, DISPLAY, …). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Host-side paths of one trial's private tree. Only the harness reads these directly. */
export interface TrialPaths {
  readonly root: string;
  readonly workspace: string;
  readonly tmp: string;
  readonly home: string;
}

export interface CapBreach {
  readonly cap: "memory" | "cpu";
  readonly observed: number;
  readonly limit: number;
}

export interface DestroyReport {
  /** No process of the desktop is left. */
  readonly processesGone: boolean;
  /** The trial's private root no longer exists on the host. */
  readonly rootRemoved: boolean;
  readonly detail?: string;
}

export interface TrialDesktop {
  readonly runId: string;
  readonly isolation: IsolationReport;
  readonly paths: TrialPaths;
  /** Run a command inside the desktop, under its isolation and caps. */
  exec(command: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Set when the watchdog killed the desktop for exceeding a cap. */
  breach(): CapBreach | undefined;
  /** Kill everything and remove the root. Idempotent. Never throws. */
  destroy(): Promise<DestroyReport>;
}

export interface TrialDesktopSpec {
  readonly runId: string;
  /** Empty host dir created by the pool for this trial only. */
  readonly root: string;
  /** Host dirs the desktop must not see (other trials' roots, vaults, evidence). */
  readonly hide: readonly string[];
  readonly memoryMbPerTrial: number;
  readonly cpuSecondsPerTrial: number;
  readonly display: "xvfb" | "none";
  /** Extra env every exec sees (the pool's per-trial marker). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface BackendProbe {
  readonly available: boolean;
  /** The isolation a desktop from this backend would get here. */
  readonly expected?: Omit<IsolationReport, "display">;
  readonly detail: string;
}

export interface DesktopBackend {
  readonly id: string;
  probe(): Promise<BackendProbe>;
  create(spec: TrialDesktopSpec): Promise<TrialDesktop>;
}
