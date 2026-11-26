/**
 * Track L (safe parallelism) — the trial pool: N isolated, disposable desktops at once,
 * each trial gated by its own vault and its own gate, with contamination checked.
 *
 * Per trial, in order (each step fails closed):
 *
 *  1. Claim the run id by its case-folded form (`RunIdRegistry`, in-process and on disk).
 *  2. Create a fresh desktop in an empty private root (`DesktopBackend.create`), asking
 *     it to hide the run root (other trials, vaults, evidence, locks). A backend that
 *     cannot (`hostDirsHidden !== true`, e.g. `linux-plain`) says so, and its trial is
 *     never counted (`shared-host-dirs`).
 *  3. Check the desktop's isolation report against the operator's requirements. A
 *     shortfall destroys the desktop before anything is sealed: the trial is `isolation`.
 *  4. Plant the trial's marker (a random nonce only the harness and this trial know) in
 *     its workspace and env, and lay down the task's fixture.
 *  5. Run the existing gated path unchanged (`runGatedTrial`): launch audit, seal into a
 *     vault of this trial only (own root, own key, the desktop's root as the agent root),
 *     the gate bound to `{ runId, receipt }`, the agent, stop, capture, verdict. The vault
 *     seals the pool's oracle snapshot (read once before the first trial,
 *     `snapshotOracleSources`), and reads every file without blocking; a seal that did not
 *     hash the snapshot's bytes withholds the count (`oracle-source`).
 *  6. Scan the desktop's private tree for every OTHER trial's marker, then destroy it and
 *     check the destroy report (no process left, root removed).
 *  7. Write the trial's evidence (record, agent output) to its own evidence root.
 *
 * Every file the harness writes (marker, fixture, MCP config, evidence, pool report) goes
 * through `writeHarnessFile`: exclusive, no-follow, non-blocking create in a dir that is
 * still its own realpath, off the event loop with a hard timeout. A planted FIFO (or
 * anything else) at a target is refused with a code (`evidence-refused`), never written to.
 *
 * After every trial: scan each trial's evidence root and vault dir for other trials'
 * markers. A trial counts as verified only when the gate said `verified` AND no
 * disqualifier applies (isolation, a backend that leaves other trials' roots writable
 * (`shared-host-dirs`: the marker scan cannot catch a hostile writer that simply does not
 * write its own marker), contamination in either direction, missing own marker,
 * incomplete scan, failed teardown, cap breach, timeout, agent error). A verdict is never
 * raised by anything here; it can only be withheld.
 *
 * Scripted agents are `simulated`: a pool report from them is marked so and never counts
 * as evidence (it has no ledger row and no cost; R7 does not apply).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { GateResult } from "../gate/api.ts";
import type { TaskRegistry } from "../gate/gate.ts";
import { runGatedTrial } from "../gate/gated-trial.ts";
import { GATE_TOOL, handleLine, SERVER_NAME } from "../gate/mcp-server.ts";
import { type AgentLaunchPlan, mcpConfigJson } from "../integrity/launch.ts";
import { rtSessionIdFor } from "../integrity/surface.ts";
import { readRegularNoBlock } from "../integrity/nonblocking-read.ts";
import { newVaultKey, VaultError, VerdictVault } from "../integrity/vault.ts";
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
  /**
   * Absolute paths of the oracle's sources. The pool reads each ONCE, before the first
   * trial, into a snapshot under the run root (`snapshotOracleSources`), and every trial's
   * vault seals and checks the snapshot copies: these paths are never read again during
   * the pool, so an agent that replaces one (with a FIFO, say) cannot reach the harness.
   */
  readonly oracleSources: readonly string[];
  /** Called after a desktop exists, before the agent: test hook (barriers, probes). */
  readonly onDesktop?: (runId: string, desktop: TrialDesktop) => Promise<void> | void;
}

export type Disqualifier =
  | "run-id"
  | "isolation"
  | "shared-host-dirs"
  | "contaminated"
  | "leaked"
  | "own-marker-missing"
  | "scan-incomplete"
  | "teardown"
  | "resource-cap"
  | "timeout"
  | "agent-error"
  | "capture-refused"
  | "evidence-refused"
  | "oracle-source"
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
  /** The oracle sources as read once before the first trial: path and sha256. */
  readonly oracleSources: readonly { readonly source: string; readonly sha256: string }[];
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

/**
 * The pre-open `lstat` the scan and the capture use. A test may pass one that lies (a FIFO
 * reported as a regular file) to stand in, deterministically, for a file the trial swaps
 * between the `lstat` and the `open`: what is then opened must still never block.
 */
export type LstatProbe = (path: string) => Stats;

/** Which markers occur in the regular files under `dir` (symlinks are not followed). */
export function scanTree(
  dir: string,
  markers: ReadonlyMap<string, string>,
  lstat: LstatProbe = lstatSync,
): ScanResult {
  const found = new Set<string>();
  let budget = SCAN_LIMIT_BYTES;
  let complete = true;
  const walk = (path: string) => {
    let st: Stats;
    try {
      st = lstat(path);
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
    // The trial's processes may still run: the file can be swapped for a FIFO after the
    // lstat. Open without blocking, re-check on the fd, and read at most what was budgeted.
    let fd: number;
    try {
      fd = openNoBlock(path);
    } catch {
      complete = false;
      return;
    }
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.size > st.size + budget) {
        complete = false;
        return;
      }
      const buf = Buffer.alloc(fst.size);
      let off = 0;
      while (off < buf.length) {
        const n = readSync(fd, buf, off, buf.length - off, off);
        if (n <= 0) break;
        off += n;
      }
      scanBytes(buf.subarray(0, off), markers, found);
    } catch {
      complete = false;
    } finally {
      closeSync(fd);
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

/** Why a capture was refused; every code fails the trial closed (`capture-refused`). */
export type CaptureRefusal =
  | "missing"
  | "outside-workspace"
  | "symlink"
  | "not-regular"
  | "hard-linked"
  | "too-large";

export class CaptureRefused extends Error {
  constructor(
    readonly code: CaptureRefusal,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CaptureRefused";
  }
}

/** A saved state file larger than this is refused, never read (no unbounded read). */
export const CAPTURE_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Open `path` for reading without ever blocking: `O_NONBLOCK` makes opening a FIFO return
 * at once (it would otherwise wait for a writer forever, freezing the whole event loop),
 * and `O_NOFOLLOW` refuses a symlink at the last component. The caller must `fstat` the fd
 * and refuse anything but a regular file BEFORE reading it.
 */
export function openNoBlock(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}

/**
 * Read `rel` from the trial's workspace for the vault, refusing anything but a regular
 * file with one link that really lives in that workspace. The agent owns its workspace,
 * so it could plant a symlink (or a hard link) to another trial's saved file, or to a
 * host file it wrote with the right content; following it would let one trial be
 * verified on another's bytes. It could also plant a FIFO, a socket or a directory, or a
 * huge sparse file, to hang or exhaust the harness. `workspaceReal` is the workspace's
 * realpath taken by the harness BEFORE the agent ran.
 *
 * - `lstat` refuses a non-regular file (FIFO, socket, device, dir, symlink) before any
 *   open; the open is still `O_NONBLOCK | O_NOFOLLOW`, because the agent's processes may
 *   still be running and can swap the file between the `lstat` and the `open`;
 * - the realpath check refuses a symlinked (or swapped) parent;
 * - `fstat` on the open fd re-checks regular file, `nlink === 1` (no hard link) and the
 *   size cap, so what is read is what was checked.
 *
 * Nothing here can block: every refusal is immediate and carries a code.
 */
export function captureRegularFile(
  workspaceReal: string,
  rel: string,
  lstat: LstatProbe = lstatSync,
): Buffer {
  const path = join(workspaceReal, rel);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(path));
  } catch {
    throw new CaptureRefused("missing", "state file's directory is missing");
  }
  if (realParent !== dirname(path))
    throw new CaptureRefused(
      "outside-workspace",
      "state file's directory is outside the workspace",
    );
  let pre: Stats;
  try {
    pre = lstat(path);
  } catch {
    throw new CaptureRefused("missing", "state file is missing");
  }
  if (pre.isSymbolicLink()) throw new CaptureRefused("symlink", "state file is a symlink");
  if (!pre.isFile()) throw new CaptureRefused("not-regular", "state file is not a regular file");
  let fd: number;
  try {
    fd = openNoBlock(path);
  } catch {
    throw new CaptureRefused("symlink", "state file vanished or became a symlink");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CaptureRefused("not-regular", "state file is not a regular file");
    if (st.nlink !== 1)
      throw new CaptureRefused("hard-linked", "state file has more than one link");
    if (st.size > CAPTURE_LIMIT_BYTES)
      throw new CaptureRefused("too-large", `state file is over ${CAPTURE_LIMIT_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------
// harness writes
// ---------------------------------------------------------------------------------------

/** Why a harness write was refused; every code fails the trial (or the pool) closed. */
export type HarnessWriteRefusal = "outside-dir" | "exists" | "not-regular" | "open" | "timeout";
// "not-regular" is used by the pool report's replace step only.

export class HarnessWriteRefused extends Error {
  constructor(
    readonly code: HarnessWriteRefusal,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} (${path})`);
    this.name = "HarnessWriteRefused";
  }
}

/** A harness write that has not finished in this long is abandoned and refused. */
export const HARNESS_WRITE_TIMEOUT_MS = 10_000;

/**
 * Write a file the harness owns (marker, fixture, MCP config, agent output, record, pool
 * report) into a dir an agent may be able to reach. On `linux-plain` every such dir is
 * reachable by every trial, and a plain `writeFileSync` on a FIFO planted there blocks
 * the whole event loop forever (round-3 B1): every trial, timeout and watchdog freezes.
 *
 * - `dirReal` must still be its own realpath (the harness took it before any agent ran),
 *   so a dir swapped for a symlink is refused rather than written through;
 * - the file is created `O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK`: every harness file
 *   is written exactly once, so ANY pre-existing entry (FIFO, socket, symlink, dir, a
 *   regular file an agent planted) is refused at once (`exists`), and nothing is ever
 *   opened that could block (`O_EXCL` means this call created the file: it is a fresh
 *   regular file, so no `fstat` re-check is needed);
 * - the whole write runs off the event loop (libuv threadpool) and is raced against a
 *   hard timeout, so even a write that somehow stalls cannot freeze the pool.
 */
export async function writeHarnessFile(
  dirReal: string,
  name: string,
  data: string | Uint8Array,
  timeoutMs: number = HARNESS_WRITE_TIMEOUT_MS,
): Promise<void> {
  const path = join(dirReal, name);
  if (dirname(path) !== dirReal)
    throw new HarnessWriteRefused("outside-dir", path, "name must be a single component");
  let real: string;
  try {
    real = realpathSync(dirReal);
  } catch {
    throw new HarnessWriteRefused("outside-dir", path, "target dir is missing");
  }
  if (real !== dirReal)
    throw new HarnessWriteRefused("outside-dir", path, "target dir was swapped");
  const write = async (): Promise<void> => {
    let fh: Awaited<ReturnType<typeof openAsync>>;
    try {
      fh = await openAsync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new HarnessWriteRefused(
        code === "EEXIST" ? "exists" : "open",
        path,
        `cannot create (${code ?? "error"})`,
      );
    }
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close().catch(() => {});
    }
  };
  const writing = write();
  writing.catch(() => {}); // a write abandoned at the timeout must not crash the process later
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      writing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HarnessWriteRefused("timeout", path, `not written in ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------
// oracle sources
// ---------------------------------------------------------------------------------------

/** An oracle source larger than this is refused at snapshot time (sources are small). */
export const ORACLE_SOURCE_LIMIT_BYTES = 16 * 1024 * 1024;
/** A trial's `seal.json` larger than this is not read back (manifests are small). */
const SEAL_READ_LIMIT_BYTES = 1024 * 1024;

export interface OracleSnapshot {
  /** The path the operator named (never read again during the pool). */
  readonly source: string;
  /** The pool's copy, which every trial's vault seals and checks. */
  readonly path: string;
  readonly sha256: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Read each oracle source ONCE, before any trial starts, and copy it into a fresh dir under
 * the run root (#541 R3-1). On `linux-plain` an agent can replace any host path its uid can
 * write, the repo checkout included; a plain read of a FIFO there freezes the whole pool.
 *
 * - each source is read with `readRegularNoBlock` (no blocking open, no symlink, regular
 *   file only, at most `ORACLE_SOURCE_LIMIT_BYTES`); a refusal refuses the pool, with a code,
 *   before anything runs;
 * - the copies are written with `writeHarnessFile` (exclusive, no-follow, non-blocking) into
 *   a dir with an unguessable name, and their sha256 are kept in harness memory;
 * - the operator's paths are never read again during the pool.
 *
 * The snapshot dir is under the run root, so on `linux-plain` it is still reachable by a
 * same-uid agent (declared). That cannot hang the pool: the vault reads it without blocking
 * (`readRegularNoBlock`), and `sealMatchesSnapshot` withholds the count of any trial whose
 * seal did not hash exactly these bytes.
 */
export async function snapshotOracleSources(
  sources: readonly string[],
  runRootReal: string,
): Promise<OracleSnapshot[]> {
  const problems: string[] = [];
  const read: { source: string; bytes: Buffer }[] = [];
  for (const source of sources) {
    if (!isAbsolute(source)) {
      problems.push(`oracle source ${JSON.stringify(source)}: not-absolute`);
      continue;
    }
    const r = readRegularNoBlock(source, { maxBytes: ORACLE_SOURCE_LIMIT_BYTES });
    if (!r.ok) problems.push(`oracle source ${JSON.stringify(source)}: ${r.code}`);
    else read.push({ source, bytes: r.bytes });
  }
  if (problems.length > 0) throw new PoolRefused(problems);
  const dir = join(runRootReal, `oracle-${randomBytes(12).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  const out: OracleSnapshot[] = [];
  for (const [i, { source, bytes }] of read.entries()) {
    const name = `${i}-${basename(source)}`;
    await writeHarnessFile(dir, name, bytes);
    out.push({ source, path: join(dir, name), sha256: sha256Hex(bytes) });
  }
  return out;
}

/**
 * Whether the trial's seal hashed exactly the snapshot's bytes. Reads the vault's
 * `seal.json` without blocking, checks it is the file the receipt names (its sha256 is the
 * receipt's `sealDigest`), and compares its oracle sources to the snapshot. Any refusal or
 * difference is `false`: the trial is not counted (`oracle-source`). The gate already
 * refuses a verdict when a source changed between seal and verdict; this closes the window
 * before the seal (another trial replacing a snapshot copy before this trial sealed).
 */
export function sealMatchesSnapshot(
  sealPath: string,
  sealDigest: string,
  snapshot: readonly OracleSnapshot[],
): boolean {
  const r = readRegularNoBlock(sealPath, { maxBytes: SEAL_READ_LIMIT_BYTES });
  if (!r.ok || sha256Hex(r.bytes) !== sealDigest) return false;
  let sources: unknown;
  try {
    sources = (JSON.parse(r.bytes.toString("utf8")) as { oracle?: { sources?: unknown } }).oracle
      ?.sources;
  } catch {
    return false;
  }
  if (sources === null || typeof sources !== "object") return false;
  const got = sources as Record<string, unknown>;
  if (Object.keys(got).length !== snapshot.length) return false;
  return snapshot.every((s) => got[s.path] === s.sha256);
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
  // Harness writes go through realpaths taken before any agent runs (writeHarnessFile).
  const runRootReal = realpathSync(runRoot);
  const evidenceReal = join(runRootReal, "evidence");
  // Read once, before any trial: the operator's paths are never read again (#541 R3-1).
  const oracle = await snapshotOracleSources(opts.oracleSources, runRootReal);
  const oracleSources = oracle.map((o) => o.path);
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
      // An operator may accept weak isolation to run trials at all (best-effort), but a
      // trial another trial could have written is never counted: its gate verdict may rest
      // on bytes this trial did not save. Not configurable.
      if (desktop.isolation.hostDirsHidden !== true) w.disqualifiers.add("shared-host-dirs");
      const task = opts.tasks.get(spec.taskId);
      if (!task) throw new Error("task vanished");
      const calc = task.spec as CalcSpec;
      // The dirs the harness writes into must really be inside the trial's own root (a
      // dir swapped for a symlink before this point would redirect every write).
      const rootReal = realpathSync(desktop.paths.root);
      const workspaceReal = realpathSync(desktop.paths.workspace);
      const homeReal = realpathSync(desktop.paths.home);
      for (const [what, real] of [
        ["workspace", workspaceReal],
        ["home", homeReal],
      ] as const)
        if (!real.startsWith(`${rootReal}/`))
          throw new HarnessWriteRefused("outside-dir", real, `trial ${what} is outside its root`);
      await writeHarnessFile(workspaceReal, MARKER_FILE, `${marker}\n`);
      await writeHarnessFile(workspaceReal, task.stateFile, generateFixture(calc.fixtureSeed).csv);
      await opts.onDesktop?.(spec.runId, desktop);

      const vault = new VerdictVault({
        root: join(dirs.vaults, spec.runId),
        key: newVaultKey(),
        agentRoots: [root],
      });
      const plan = trialPlan(spec.runId, join(homeReal, "mcp.json"));
      const evidenceDir = join(evidenceReal, spec.runId);
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
        oracleSources,
        transport: {
          async runAgent(audited, gate) {
            if (audited.mcpConfigPath !== join(homeReal, "mcp.json"))
              throw new Error("audited MCP config path moved");
            await writeHarnessFile(homeReal, "mcp.json", mcpConfigJson(audited));
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
      const sealPath = join(runRootReal, "vaults", spec.runId, spec.runId, "seal.json");
      if (!sealMatchesSnapshot(sealPath, outcome.receipt.sealDigest, oracle))
        w.disqualifiers.add("oracle-source");
      await writeHarnessFile(evidenceDir, "agent-output.txt", output);
      // Scan the live desktop tree before it is destroyed.
      const scan = scanTree(desktop.paths.root, markers);
      if (!scan.complete) w.disqualifiers.add("scan-incomplete");
      w.record.ownMarkerSeen = scan.found.has(spec.runId);
      for (const id of scan.found) if (id !== spec.runId) w.record.foreignMarkers.push(id);
    } catch (e) {
      if (e instanceof TrialTimeout) w.disqualifiers.add("timeout");
      else if (e instanceof HarnessWriteRefused) w.disqualifiers.add("evidence-refused");
      else if (e instanceof CaptureRefused) w.disqualifiers.add("capture-refused");
      else if (e instanceof TrialBreach) w.disqualifiers.add("resource-cap");
      else if (e instanceof VaultError && e.code === "not-regular")
        w.disqualifiers.add("oracle-source");
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
    const evidenceDir = join(evidenceReal, spec.runId);
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
    const evidenceDir = join(evidenceReal, spec.runId);
    try {
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    } catch {
      // Something planted there; writeHarnessFile below refuses it with a code.
    }
    // The record on disk is written as counted only if the write itself succeeds; a
    // refused write (anything planted at record.json, a swapped dir) withholds the count.
    let record = finalRecord(w);
    try {
      await writeHarnessFile(evidenceDir, "record.json", `${JSON.stringify(record, null, 2)}\n`);
    } catch (e) {
      if (!(e instanceof HarnessWriteRefused)) throw e;
      w.disqualifiers.add("evidence-refused");
      w.record.error = w.record.error ?? e.message;
      record = finalRecord(w);
    }
    records.push(record);
  }
  const report: PoolReport = {
    schema: POOL_SCHEMA,
    simulated: records.some((r) => r.simulated) || trials.some((t) => t.agent.simulated),
    backend: opts.backend.id,
    caps,
    requirements: opts.requirements,
    peakConcurrent: peak,
    wallMs: Date.now() - started,
    oracleSources: oracle.map((o) => ({ source: o.source, sha256: o.sha256 })),
    trials: records,
    verifiedCount: records.filter((r) => r.countedVerified).length,
    contaminatedCount: records.filter((r) => r.disqualifiers.includes("contaminated")).length,
  };
  await writePoolReport(runRootReal, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * The pool report may replace one from an earlier run in a reused run root, so it is not
 * created in place: it is written to a fresh, unguessable name (`writeHarnessFile`, never
 * blocking) and `rename`d over `pool-report.json`. `rename` never opens its target. A
 * target that is anything but a regular file (a planted FIFO, socket, symlink or dir) is
 * refused, and a refusal rejects the whole run (`HarnessWriteRefused`): no report, no count.
 */
async function writePoolReport(runRootReal: string, text: string): Promise<void> {
  const target = join(runRootReal, "pool-report.json");
  const tmp = `pool-report.${randomBytes(12).toString("hex")}.tmp`;
  await writeHarnessFile(runRootReal, tmp, text);
  try {
    let pre: ReturnType<typeof lstatSync> | undefined;
    try {
      pre = lstatSync(target);
    } catch {
      pre = undefined;
    }
    if (pre && !pre.isFile())
      throw new HarnessWriteRefused(
        "not-regular",
        target,
        "pool report target is not a regular file",
      );
    try {
      renameSync(join(runRootReal, tmp), target);
    } catch (e) {
      throw new HarnessWriteRefused(
        "open",
        target,
        `cannot replace (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
  } catch (e) {
    rmSync(join(runRootReal, tmp), { force: true });
    throw e;
  }
}

/** The record as reported: counted only when the gate verified and nothing disqualifies. */
function finalRecord(w: Working): TrialRecord {
  const disqualifiers = [...w.disqualifiers].sort();
  return {
    ...w.record,
    foreignMarkers: [...w.record.foreignMarkers].sort(),
    disqualifiers,
    countedVerified: countedVerified(w.record.gate, disqualifiers),
  };
}

/** The one count rule: the gate said verified AND accepted, and no disqualifier applies. */
export function countedVerified(
  gate: GateResult | null,
  disqualifiers: readonly Disqualifier[],
): boolean {
  return gate?.verdict === "verified" && gate.accepted === true && disqualifiers.length === 0;
}
