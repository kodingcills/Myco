/**
 * Track L (safe parallelism) — the trial pool: N isolated, disposable desktops at once,
 * each trial gated by its own vault and its own gate, with contamination checked.
 *
 * Per trial, in order (each step fails closed):
 *
 *  1. Claim the run id by its case-folded form (`RunIdRegistry`, in-process and on disk).
 *  2. Create a fresh desktop in an empty private root (`DesktopBackend.create`), hiding
 *     the run root (other trials, vaults, evidence, locks) from it.
 *  3. Check the desktop's isolation report against the operator's requirements. A
 *     shortfall destroys the desktop before anything is sealed: the trial is `isolation`.
 *  4. Plant the trial's marker (a random nonce only the harness and this trial know) in
 *     its workspace and env, and lay down the task's fixture.
 *  5. Run the existing gated path unchanged (`runGatedTrial`): launch audit, seal into a
 *     vault of this trial only (own root, own key, the desktop's root as the agent root),
 *     the gate bound to `{ runId, receipt }`, the agent, stop, capture, verdict.
 *  6. Scan the desktop's private tree for every OTHER trial's marker, then destroy it and
 *     check the destroy report (no process left, root removed).
 *  7. Write the trial's evidence (record, agent output) to its own evidence root.
 *
 * After every trial: scan each trial's evidence root and vault dir for other trials'
 * markers. A trial counts as verified only when the gate said `verified` AND no
 * disqualifier applies (isolation, contamination in either direction, missing own marker,
 * incomplete scan, failed teardown, cap breach, timeout, agent error). A verdict is never
 * raised by anything here; it can only be withheld.
 *
 * Scripted agents are `simulated`: a pool report from them is marked so and never counts
 * as evidence (it has no ledger row and no cost; R7 does not apply).
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GateResult } from "../gate/api.ts";
import type { TaskRegistry } from "../gate/gate.ts";
import { runGatedTrial } from "../gate/gated-trial.ts";
import { GATE_TOOL, handleLine, SERVER_NAME } from "../gate/mcp-server.ts";
import { type AgentLaunchPlan, mcpConfigJson } from "../integrity/launch.ts";
import { rtSessionIdFor } from "../integrity/surface.ts";
import { newVaultKey, VerdictVault } from "../integrity/vault.ts";
import { generateFixture } from "../tasks/fixture.ts";
import type { AgentContext, CalcSpec, ScriptedDesktopAgent } from "./agents.ts";
import {
  type CapBreach,
  type DesktopBackend,
  type DestroyReport,
  type IsolationReport,
  type IsolationRequirements,
  isolationShortfalls,
  type TrialDesktop,
} from "./backend.ts";
import { type ResourceCaps, type ResourceCapsInput, resolveCaps } from "./caps.ts";
import { assertDistinctFolded, RunIdError, RunIdRegistry } from "./runid.ts";

export const POOL_SCHEMA = "myco.parallel-pool/1";
export const MARKER_FILE = ".myco-trial-marker";
export const MARKER_ENV = "MYCO_TRIAL_MARKER";
/** A trial tree larger than this is not fully scanned, which disqualifies the trial. */
export const SCAN_LIMIT_BYTES = 64 * 1024 * 1024;

export interface TrialSpec {
  readonly runId: string;
  readonly taskId: string;
  readonly agent: ScriptedDesktopAgent;
}

export interface PoolOptions {
  readonly backend: DesktopBackend;
  readonly caps: ResourceCapsInput;
  readonly requirements: IsolationRequirements;
  /** Host dir for this pool's trials, vaults, evidence and locks. */
  readonly runRoot: string;
  /** Shared lock dir for cross-process run-id claims; defaults to `<runRoot>/locks`. */
  readonly lockDir?: string;
  /**
   * More host dirs to hide from every desktop (a namespace backend mounts an empty tmpfs
   * over each), e.g. the operator's home. The run root and lock dir are always hidden.
   */
  readonly extraHide?: readonly string[];
  readonly tasks: TaskRegistry;
  /** Absolute paths of the oracle's sources, hashed at seal. */
  readonly oracleSources: readonly string[];
  /** Called after a desktop exists, before the agent: test hook (barriers, probes). */
  readonly onDesktop?: (runId: string, desktop: TrialDesktop) => Promise<void> | void;
}

export type Disqualifier =
  | "run-id"
  | "isolation"
  | "contaminated"
  | "leaked"
  | "own-marker-missing"
  | "scan-incomplete"
  | "teardown"
  | "resource-cap"
  | "timeout"
  | "agent-error"
  | "capture-refused"
  | "harness-error";

export interface TrialRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly agent: string;
  readonly simulated: boolean;
  readonly isolation: IsolationReport | null;
  readonly isolationShortfalls: readonly string[];
  /** The gate's own verdict for this trial (from the sealed capture), when it decided. */
  readonly gate: GateResult | null;
  /** What the agent saw when it called the gate mid-run (always before capture). */
  readonly agentSaw: GateResult | null;
  readonly claim: string | null;
  /** Run ids whose markers were found in THIS trial's workspace, evidence or vault. */
  readonly foreignMarkers: readonly string[];
  readonly ownMarkerSeen: boolean;
  readonly destroy: DestroyReport | null;
  readonly breach: CapBreach | null;
  readonly disqualifiers: readonly Disqualifier[];
  /** Gate verdict `verified` and no disqualifier. The only count a report may use. */
  readonly countedVerified: boolean;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly error?: string;
}

export interface PoolReport {
  readonly schema: typeof POOL_SCHEMA;
  /** True when any agent was scripted: never evidence, never a ledger row. */
  readonly simulated: boolean;
  readonly backend: string;
  readonly caps: ResourceCaps;
  readonly requirements: IsolationRequirements;
  readonly peakConcurrent: number;
  readonly wallMs: number;
  readonly trials: readonly TrialRecord[];
  readonly verifiedCount: number;
  readonly contaminatedCount: number;
}

export class PoolRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`pool refused: ${problems.join("; ")}`);
    this.name = "PoolRefused";
  }
}

/** The audited launch plan of a gated trial: the gate tool and a pinned myco-rt only. */
export function trialPlan(runId: string, mcpConfigPath: string): AgentLaunchPlan {
  return {
    argv: [
      "-p",
      "edit the record, save, then call the gate",
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ["mcp__myco-rt__observe", "mcp__myco-rt__act", `mcp__${SERVER_NAME}__${GATE_TOOL}`].join(","),
    ],
    mcpServers: {
      "myco-rt": {
        command: "myco-rt-mcp",
        args: [],
        env: { MYCO_RT_SESSION_ID: rtSessionIdFor(runId) },
      },
      [SERVER_NAME]: { command: "myco-gate", args: ["mcp"], env: {} },
    },
    mcpConfigPath,
  };
}

// ---------------------------------------------------------------------------------------
// marker scanning
// ---------------------------------------------------------------------------------------

interface ScanResult {
  readonly found: Set<string>;
  readonly complete: boolean;
}

/** Which markers occur in the regular files under `dir` (symlinks are not followed). */
export function scanTree(dir: string, markers: ReadonlyMap<string, string>): ScanResult {
  const found = new Set<string>();
  let budget = SCAN_LIMIT_BYTES;
  let complete = true;
  const walk = (path: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      scanBytes(Buffer.from(path), markers, found);
      return;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        complete = false;
        return;
      }
      for (const name of names) {
        scanBytes(Buffer.from(name), markers, found);
        walk(join(path, name));
      }
      return;
    }
    if (!st.isFile()) return;
    budget -= st.size;
    if (budget < 0) {
      complete = false;
      return;
    }
    try {
      scanBytes(readFileSync(path), markers, found);
    } catch {
      complete = false;
    }
  };
  walk(dir);
  return { found, complete };
}

export function scanBytes(
  bytes: Uint8Array,
  markers: ReadonlyMap<string, string>,
  found: Set<string>,
): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [runId, marker] of markers) if (buf.includes(marker)) found.add(runId);
}

// ---------------------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------------------

export class CaptureRefused extends Error {}

/**
 * Read `rel` from the trial's workspace for the vault, refusing anything but a regular
 * file with one link that really lives in that workspace. The agent owns its workspace,
 * so it could plant a symlink (or a hard link) to another trial's saved file, or to a
 * host file it wrote with the right content; following it would let one trial be
 * verified on another's bytes. `workspaceReal` is the workspace's realpath taken by the
 * harness BEFORE the agent ran. `O_NOFOLLOW` refuses a symlink at the last component, the
 * realpath check refuses a symlinked (or swapped) parent, and `nlink === 1` refuses a
 * hard link.
 */
export function captureRegularFile(workspaceReal: string, rel: string): Buffer {
  const path = join(workspaceReal, rel);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(path));
  } catch {
    throw new CaptureRefused("state file's directory is missing");
  }
  if (realParent !== dirname(path))
    throw new CaptureRefused("state file's directory is outside the workspace");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new CaptureRefused("state file is missing or a symlink");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CaptureRefused("state file is not a regular file");
    if (st.nlink !== 1) throw new CaptureRefused("state file has more than one link");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------
// the pool
// ---------------------------------------------------------------------------------------

class TrialTimeout extends Error {}
class TrialBreach extends Error {}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Working {
  record: Mutable<Omit<TrialRecord, "disqualifiers" | "countedVerified" | "foreignMarkers">> & {
    foreignMarkers: string[];
  };
  disqualifiers: Set<Disqualifier>;
}

export async function runPool(
  opts: PoolOptions,
  trials: readonly TrialSpec[],
): Promise<PoolReport> {
  const capsResult = resolveCaps(opts.caps);
  if (!capsResult.ok) throw new PoolRefused([...capsResult.problems]);
  const caps = capsResult.caps;
  try {
    assertDistinctFolded(trials.map((t) => t.runId));
  } catch (e) {
    throw new PoolRefused([e instanceof Error ? e.message : String(e)]);
  }
  for (const t of trials)
    if (!opts.tasks.get(t.taskId))
      throw new PoolRefused([`unknown task ${JSON.stringify(t.taskId)}`]);
  const probe = await opts.backend.probe();
  if (!probe.available) throw new PoolRefused([`backend unavailable: ${probe.detail}`]);

  const runRoot = resolve(opts.runRoot);
  const dirs = {
    trials: join(runRoot, "trials"),
    vaults: join(runRoot, "vaults"),
    evidence: join(runRoot, "evidence"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const registry = new RunIdRegistry(opts.lockDir ?? join(runRoot, "locks"));
  const hide = [
    ...new Set([
      runRoot,
      ...(opts.lockDir ? [resolve(opts.lockDir)] : []),
      ...(opts.extraHide ?? []).map((d) => resolve(d)),
    ]),
  ];
  for (const d of hide)
    if (d === "/" || !d.startsWith("/"))
      throw new PoolRefused([
        `cannot hide ${JSON.stringify(d)}: an absolute dir below / is needed`,
      ]);

  // Every trial's marker, known only to the harness (and, once planted, to that trial).
  const markers = new Map<string, string>(
    trials.map((t) => [t.runId, `MYCO-L-MARK-${randomBytes(16).toString("hex")}`]),
  );
  const working = new Map<string, Working>();
  let active = 0;
  let peak = 0;
  let next = 0;
  const started = Date.now();

  const runOne = async (spec: TrialSpec): Promise<void> => {
    const t0 = Date.now();
    const w: Working = {
      record: {
        runId: spec.runId,
        taskId: spec.taskId,
        agent: spec.agent.id,
        simulated: spec.agent.simulated === true,
        isolation: null,
        isolationShortfalls: [],
        gate: null,
        agentSaw: null,
        claim: null,
        foreignMarkers: [],
        ownMarkerSeen: false,
        destroy: null,
        breach: null,
        startedAt: t0,
        elapsedMs: 0,
      },
      disqualifiers: new Set(),
    };
    working.set(spec.runId, w);
    const marker = markers.get(spec.runId) as string;
    let claim: ReturnType<RunIdRegistry["claim"]> | undefined;
    let desktop: TrialDesktop | undefined;
    let phase: "setup" | "agent" = "setup";
    try {
      try {
        claim = registry.claim(spec.runId);
      } catch (e) {
        w.disqualifiers.add("run-id");
        w.record.error = e instanceof RunIdError ? e.message : String(e);
        return;
      }
      const root = join(dirs.trials, spec.runId);
      mkdirSync(root, { mode: 0o700 }); // throws if a trial dir already exists: never reused
      desktop = await opts.backend.create({
        runId: spec.runId,
        root,
        hide,
        memoryMbPerTrial: caps.memoryMbPerTrial,
        cpuSecondsPerTrial: caps.cpuSecondsPerTrial,
        display: opts.requirements.display,
        env: { [MARKER_ENV]: marker },
      });
      w.record.isolation = desktop.isolation;
      const shortfalls = isolationShortfalls(desktop.isolation, opts.requirements);
      w.record.isolationShortfalls = shortfalls;
      if (shortfalls.length > 0) {
        w.disqualifiers.add("isolation");
        return;
      }
      const task = opts.tasks.get(spec.taskId);
      if (!task) throw new Error("task vanished");
      const calc = task.spec as CalcSpec;
      const workspaceReal = realpathSync(desktop.paths.workspace);
      writeFileSync(join(desktop.paths.workspace, MARKER_FILE), `${marker}\n`);
      writeFileSync(
        join(desktop.paths.workspace, task.stateFile),
        generateFixture(calc.fixtureSeed).csv,
      );
      await opts.onDesktop?.(spec.runId, desktop);

      const vault = new VerdictVault({
        root: join(dirs.vaults, spec.runId),
        key: newVaultKey(),
        agentRoots: [root],
      });
      const plan = trialPlan(spec.runId, join(desktop.paths.home, "mcp.json"));
      const evidenceDir = join(dirs.evidence, spec.runId);
      mkdirSync(evidenceDir, { mode: 0o700 });
      const live = desktop;
      let output = "";
      phase = "agent";
      const outcome = await runGatedTrial({
        vault,
        runId: spec.runId,
        taskId: spec.taskId,
        tasks: opts.tasks,
        plan,
        oracleSources: opts.oracleSources,
        transport: {
          async runAgent(audited, gate) {
            writeFileSync(audited.mcpConfigPath, mcpConfigJson(audited));
            const ctx: AgentContext = {
              desktop: live,
              taskId: spec.taskId,
              runId: spec.runId,
              stateFile: task.stateFile,
              spec: calc,
              async callGate(claimText) {
                const line = await handleLine(
                  gate,
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: {
                      name: GATE_TOOL,
                      arguments: { taskId: spec.taskId, runId: spec.runId, claim: claimText },
                    },
                  }),
                );
                const result = (
                  JSON.parse(line ?? "{}") as { result?: { structuredContent?: GateResult } }
                ).result?.structuredContent;
                if (!result) throw new Error("gate returned no result");
                w.record.agentSaw = result;
                return result;
              },
            };
            const run = spec.agent.run(ctx);
            run.catch(() => {});
            let timer: ReturnType<typeof setTimeout> | undefined;
            let poll: ReturnType<typeof setInterval> | undefined;
            try {
              const done = await Promise.race([
                run,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new TrialTimeout("trial timed out")),
                    caps.trialTimeoutMs,
                  );
                  poll = setInterval(() => {
                    const b = live.breach();
                    if (b) reject(new TrialBreach(`${b.cap} cap exceeded`));
                  }, 100);
                }),
              ]);
              w.record.claim = done.claim;
              output = done.output;
            } finally {
              if (timer) clearTimeout(timer);
              if (poll) clearInterval(poll);
            }
            const b = live.breach();
            if (b) throw new TrialBreach(`${b.cap} cap exceeded`);
          },
          async captureAfterStop() {
            return {
              [`persisted/${task.stateFile}`]: captureRegularFile(workspaceReal, task.stateFile),
              "result.json": Buffer.from(JSON.stringify({ claim: w.record.claim })),
            };
          },
        },
      });
      if (outcome.status === "refused") {
        w.disqualifiers.add("harness-error");
        w.record.error = "launch audit refused the trial plan";
        return;
      }
      w.record.gate = outcome.result;
      writeFileSync(join(evidenceDir, "agent-output.txt"), output);
      // Scan the live desktop tree before it is destroyed.
      const scan = scanTree(desktop.paths.root, markers);
      if (!scan.complete) w.disqualifiers.add("scan-incomplete");
      w.record.ownMarkerSeen = scan.found.has(spec.runId);
      for (const id of scan.found) if (id !== spec.runId) w.record.foreignMarkers.push(id);
    } catch (e) {
      if (e instanceof TrialTimeout) w.disqualifiers.add("timeout");
      else if (e instanceof CaptureRefused) w.disqualifiers.add("capture-refused");
      else if (e instanceof TrialBreach) w.disqualifiers.add("resource-cap");
      else if (desktop?.breach()) w.disqualifiers.add("resource-cap");
      else w.disqualifiers.add(phase === "setup" ? "harness-error" : "agent-error");
      w.record.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (desktop) {
        const b = desktop.breach();
        if (b) {
          w.record.breach = b;
          w.disqualifiers.add("resource-cap");
        }
        const report = await desktop.destroy();
        w.record.destroy = report;
        if (!report.processesGone || !report.rootRemoved) w.disqualifiers.add("teardown");
      }
      claim?.release();
      w.record.elapsedMs = Date.now() - t0;
    }
  };

  const worker = async () => {
    for (;;) {
      const i = next++;
      const spec = trials[i];
      if (!spec) return;
      active++;
      peak = Math.max(peak, active);
      try {
        if (active > caps.maxConcurrent) throw new Error("concurrency cap breached");
        await runOne(spec);
      } finally {
        active--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(caps.maxConcurrent, trials.length) }, worker));

  // Final pass: every trial's retained evidence and vault, against every other marker.
  const records: TrialRecord[] = [];
  for (const spec of trials) {
    const w = working.get(spec.runId) as Working;
    const evidenceDir = join(dirs.evidence, spec.runId);
    for (const where of [evidenceDir, join(dirs.vaults, spec.runId)]) {
      const scan = scanTree(where, markers);
      if (!scan.complete) w.disqualifiers.add("scan-incomplete");
      for (const id of scan.found)
        if (id !== spec.runId && !w.record.foreignMarkers.includes(id))
          w.record.foreignMarkers.push(id);
    }
    const gateText = JSON.stringify([w.record.gate, w.record.agentSaw, w.record.claim]);
    const inGate = new Set<string>();
    scanBytes(Buffer.from(gateText), markers, inGate);
    for (const id of inGate)
      if (id !== spec.runId && !w.record.foreignMarkers.includes(id))
        w.record.foreignMarkers.push(id);
  }
  for (const spec of trials) {
    const w = working.get(spec.runId) as Working;
    if (w.record.foreignMarkers.length > 0) w.disqualifiers.add("contaminated");
    for (const other of working.values())
      if (other !== w && other.record.foreignMarkers.includes(spec.runId))
        w.disqualifiers.add("leaked");
    if (w.record.gate && !w.record.ownMarkerSeen) w.disqualifiers.add("own-marker-missing");
    const disqualifiers = [...w.disqualifiers].sort();
    const record: TrialRecord = {
      ...w.record,
      foreignMarkers: [...w.record.foreignMarkers].sort(),
      disqualifiers,
      countedVerified:
        w.record.gate?.verdict === "verified" &&
        w.record.gate.accepted === true &&
        disqualifiers.length === 0,
    };
    records.push(record);
    const evidenceDir = join(dirs.evidence, spec.runId);
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(evidenceDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  }
  const report: PoolReport = {
    schema: POOL_SCHEMA,
    simulated: records.some((r) => r.simulated) || trials.some((t) => t.agent.simulated),
    backend: opts.backend.id,
    caps,
    requirements: opts.requirements,
    peakConcurrent: peak,
    wallMs: Date.now() - started,
    trials: records,
    verifiedCount: records.filter((r) => r.countedVerified).length,
    contaminatedCount: records.filter((r) => r.disqualifiers.includes("contaminated")).length,
  };
  writeFileSync(join(runRoot, "pool-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
