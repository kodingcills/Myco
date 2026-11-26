/**
 * TIF-266 (M2-03, scorecard row R4) — the verdict vault.
 *
 * The problem: a verdict is only independent if the agent being judged cannot write what
 * the oracle reads (ADR-0002, ADR-0005). In M2 the agent is Claude Code, so "the agent
 * cannot write it" has to be a property of the harness, not a convention.
 *
 * The design makes tampering unable to produce `verified`, rather than only detecting it:
 *
 * 1. **Seal before the agent starts.** The harness writes the ground truth (the intent
 *    parameters the expected value is computed from), the pristine fixtures, and the oracle's
 *    source hashes into a host-side vault run directory. The manifest is MAC'd with a key
 *    the agent never sees, and its digest (the receipt) stays in harness memory.
 * 2. **Capture after the agent stops.** Only after `markAgentStopped` may the harness copy
 *    the persisted output (and the evidence artifacts, for audit) into the vault. Capture
 *    before stop is refused.
 * 3. **The oracle reads only vault copies, read once.** `openVerdictInputs` reads every
 *    sealed and captured file exactly once, hashes those bytes, and hands *those same
 *    bytes* to the oracle. A file swapped after the check cannot reach the oracle (no
 *    check-then-reread window). The oracle never sees `result.json`, `trace.jsonl`, the
 *    ledger or screenshots: those are captured for audit only, so a forged claim cannot
 *    raise a verdict.
 * 4. **Any failed check is `uncertain`** with an `integrity:<code>` reason (see
 *    `gatedVerdict`). Never `verified`, never `refuted`: a tampered run is "could not
 *    look", which is ADR-0002's meaning of `uncertain`.
 *
 * Seam for TIF-265 (the gate API): the gate calls `vault.checkIntegrity(runId, receipt)`
 * for a yes/no, or `gatedVerdict(vault, runId, receipt, oracle)` to run its oracle on
 * the vault's inputs. The gate must take only a run id from the agent, never an intent or
 * an expected value: those come from the seal. See docs/architecture/verdict-integrity.md.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VAULT_FORMAT_VERSION = 1;

export type IntegrityViolationCode =
  | "vault-reachable"
  | "vault-permissions"
  | "seal-missing"
  | "seal-malformed"
  | "seal-signature"
  | "receipt-missing"
  | "receipt-malformed"
  | "receipt-mismatch"
  | "run-not-bound"
  | "sealed-file-missing"
  | "sealed-file-not-regular"
  | "sealed-file-writable"
  | "sealed-file-hash"
  | "oracle-source-missing"
  | "oracle-source-hash"
  | "agent-not-stopped"
  | "stop-signature"
  | "capture-missing"
  | "capture-signature"
  | "captured-file-missing"
  | "captured-file-not-regular"
  | "captured-file-writable"
  | "captured-file-hash"
  | "unexpected-file";

export interface IntegrityViolation {
  readonly code: IntegrityViolationCode;
  readonly path?: string;
  readonly detail: string;
}

export type IntegrityResult =
  | { readonly ok: true; readonly runId: string; readonly sealDigest: string }
  | { readonly ok: false; readonly runId: string; readonly violations: IntegrityViolation[] };

/** What the harness seals before the agent starts. */
export interface SealInput {
  /**
   * Everything the expected value is computed from (for calc-record-edit: the intent
   * params). JSON-serialisable. The gate builds the oracle's intent from this, never from
   * an argument the agent supplies.
   */
  readonly groundTruth: unknown;
  /** Pristine fixtures by safe relative name, e.g. `fixture.csv`. */
  readonly fixtures: Readonly<Record<string, Uint8Array>>;
  /** Oracle identity and the absolute host paths of its source files. */
  readonly oracle: { readonly id: string; readonly sourceFiles: readonly string[] };
}

/** Held in harness memory from seal to verdict; the agent never sees it. */
export interface SealReceipt {
  readonly runId: string;
  readonly sealDigest: string;
}

/**
 * The one named opt-out from the receipt check, for an offline audit of a committed vault
 * after the harness process (and its receipts) are gone, e.g. the M2-11 recomputation.
 * `gatedVerdict` does not accept it: a gate always has the calling trial's receipt.
 */
export const AUDIT_WITHOUT_RECEIPT: unique symbol = Symbol("myco.integrity.audit-without-receipt");
export type ReceiptOrAudit = SealReceipt | typeof AUDIT_WITHOUT_RECEIPT;

/**
 * Captured after the agent stops. `persisted/` entries are the oracle's input; every other
 * entry (evidence artifacts: `result.json`, `trace.jsonl`, screenshots, ledger excerpts) is
 * hash-checked for audit but is never handed to the oracle.
 */
export type CaptureInput = Readonly<Record<string, Uint8Array>>;

/** The only inputs an oracle may read, all from the vault and all hash-verified. */
export interface VerdictInputs {
  readonly runId: string;
  /** sha256 of the `seal.json` these inputs were checked against. */
  readonly sealDigest: string;
  readonly groundTruth: unknown;
  readonly fixtures: Readonly<Record<string, Uint8Array>>;
  /** Captured `persisted/<name>` entries, keyed by `<name>`. */
  readonly persisted: Readonly<Record<string, Uint8Array>>;
}

export type VerdictInputsResult =
  | { readonly ok: true; readonly inputs: VerdictInputs }
  | { readonly ok: false; readonly violations: IntegrityViolation[] };

interface SealManifest {
  version: number;
  runId: string;
  sealedAt: string;
  files: Record<string, string>;
  oracle: { id: string; sources: Record<string, string> };
}
interface StopManifest {
  version: number;
  runId: string;
  stoppedAt: string;
  sealDigest: string;
}
interface CaptureManifest {
  version: number;
  runId: string;
  capturedAt: string;
  stopDigest: string;
  files: Record<string, string>;
}

const SEAL = "seal.json";
const STOP = "stop.json";
const CAPTURE = "capture.json";
const SEALED = "sealed";
const CAPTURED = "captured";
const GROUND_TRUTH = `${SEALED}/ground-truth.json`;
const FIXTURES = `${SEALED}/fixtures`;
const PERSISTED_PREFIX = "persisted/";

export class VaultError extends Error {
  constructor(
    readonly code:
      | "bad-run-id"
      | "bad-name"
      | "exists"
      | "reachable"
      | "permissions"
      | "not-sealed"
      | "not-stopped"
      | "already-captured",
    message: string,
  ) {
    super(`verdict vault: ${code}: ${message}`);
  }
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function safeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId.includes(".."))
    throw new VaultError("bad-run-id", JSON.stringify(runId));
}

/** A relative name made of plain segments: no absolute paths, `..`, `.` or empty parts. */
function safeName(name: string): void {
  const parts = name.split("/");
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.includes("\\") ||
    name.includes("\0") ||
    parts.some((p) => p === "" || p === "." || p === "..")
  )
    throw new VaultError("bad-name", JSON.stringify(name));
}

/** True when `child` is `parent` or inside it (both already resolved). */
function within(child: string, parent: string): boolean {
  // macOS and Windows volumes are case-insensitive by default: compare folded, so a root
  // that differs only in case is still treated as the same place (refusing more, never less).
  const fold = process.platform === "darwin" || process.platform === "win32";
  const rel = fold ? relative(parent.toLowerCase(), child.toLowerCase()) : relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve through symlinks for the longest existing prefix, so `/var` vs `/private/var` agree. */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(head.slice(parent.length).replace(/^[/\\]/, ""));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

function macOf(key: Uint8Array, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Canonical JSON: sorted keys, so a digest does not depend on insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A fresh 32-byte vault key. Keep it in the harness process; never write it where the agent reaches. */
export function newVaultKey(): Uint8Array {
  return randomBytes(32);
}

export interface VaultOptions {
  /** Host directory for vault run dirs. Must not be inside any agent-reachable root. */
  readonly root: string;
  /** MAC key; see `newVaultKey`. At least 32 bytes. */
  readonly key: Uint8Array;
  /**
   * Host paths any agent tool can read or write (from `agentReachableHostRoots` in
   * `./surface.ts`, plus the run's working directories). The vault must be disjoint from
   * every one of them, in both directions.
   */
  readonly agentRoots: readonly string[];
}

type Signed<T> = T & { mac: string };

export class VerdictVault {
  private readonly root: string;
  private readonly key: Uint8Array;
  private readonly agentRoots: readonly string[];

  constructor(opts: VaultOptions) {
    if (opts.key.length < 32)
      throw new VaultError("permissions", "vault key shorter than 32 bytes");
    this.key = opts.key;
    this.root = realish(opts.root);
    this.agentRoots = opts.agentRoots.map(realish);
    const clash = this.reachability();
    if (clash) throw new VaultError("reachable", clash);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  /** Why the vault is reachable from an agent root, or undefined when it is not. */
  private reachability(): string | undefined {
    for (const agentRoot of this.agentRoots) {
      if (within(this.root, agentRoot))
        return `vault ${this.root} is inside agent-reachable root ${agentRoot}`;
      if (within(agentRoot, this.root))
        return `agent-reachable root ${agentRoot} is inside vault ${this.root}`;
    }
    return undefined;
  }

  private runDir(runId: string): string {
    safeRunId(runId);
    return join(this.root, runId);
  }

  private sign<T extends object>(body: T): Signed<T> {
    return { ...body, mac: macOf(this.key, canonical(body)) };
  }

  private writeSealed(dir: string, rel: string, bytes: Uint8Array | string): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o400, flag: "wx" });
    chmodSync(path, 0o400);
  }

  /** Seal a run's ground truth, fixtures and oracle identity. Call before the agent starts. */
  seal(runId: string, input: SealInput): SealReceipt {
    const dir = this.runDir(runId);
    if (existsSync(dir)) throw new VaultError("exists", `run ${runId} is already sealed`);
    const files: Record<string, string> = {};
    const gtBytes = `${canonical(input.groundTruth)}\n`;
    const fixtureEntries = Object.entries(input.fixtures);
    for (const [name] of fixtureEntries) safeName(name);
    const sources: Record<string, string> = {};
    for (const path of input.oracle.sourceFiles) {
      if (!isAbsolute(path))
        throw new VaultError("bad-name", `oracle source ${path} is not absolute`);
      sources[path] = sha256(readFileSync(path));
    }
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    this.writeSealed(dir, GROUND_TRUTH, gtBytes);
    files[GROUND_TRUTH] = sha256(gtBytes);
    for (const [name, bytes] of fixtureEntries) {
      const rel = `${FIXTURES}/${name}`;
      this.writeSealed(dir, rel, bytes);
      files[rel] = sha256(bytes);
    }
    const manifest = this.sign<SealManifest>({
      version: VAULT_FORMAT_VERSION,
      runId,
      sealedAt: new Date().toISOString(),
      files,
      oracle: { id: input.oracle.id, sources },
    });
    const text = `${canonical(manifest)}\n`;
    this.writeSealed(dir, SEAL, text);
    return { runId, sealDigest: sha256(text) };
  }

  /** Record that the agent has stopped. Capture is refused until this is written. */
  markAgentStopped(runId: string): void {
    const dir = this.runDir(runId);
    const seal = this.readSigned<SealManifest>(dir, SEAL);
    if (!seal.ok) throw new VaultError("not-sealed", seal.violation.detail);
    const body: StopManifest = {
      version: VAULT_FORMAT_VERSION,
      runId,
      stoppedAt: new Date().toISOString(),
      sealDigest: sha256(seal.text),
    };
    this.writeSealed(dir, STOP, `${canonical(this.sign(body))}\n`);
  }

  /**
   * Copy host-side artifacts into the vault. Only after `markAgentStopped`. Persisted
   * output goes under `persisted/<name>`; anything else is evidence kept for audit.
   */
  capture(runId: string, artifacts: CaptureInput): void {
    const dir = this.runDir(runId);
    const stop = this.readSigned<StopManifest>(dir, STOP);
    if (!stop.ok)
      throw new VaultError(
        "not-stopped",
        `capture before the agent stopped: ${stop.violation.detail}`,
      );
    if (existsSync(join(dir, CAPTURE)))
      throw new VaultError("already-captured", `run ${runId} was already captured`);
    const files: Record<string, string> = {};
    for (const [name] of Object.entries(artifacts)) safeName(name);
    for (const [name, bytes] of Object.entries(artifacts)) {
      const rel = `${CAPTURED}/${name}`;
      this.writeSealed(dir, rel, bytes);
      files[rel] = sha256(bytes);
    }
    const body: CaptureManifest = {
      version: VAULT_FORMAT_VERSION,
      runId,
      capturedAt: new Date().toISOString(),
      stopDigest: sha256(stop.text),
      files,
    };
    this.writeSealed(dir, CAPTURE, `${canonical(this.sign(body))}\n`);
  }

  /**
   * `ok` or every violation found. The TIF-265 gate's yes/no call. `receipt` is required:
   * pass the calling trial's receipt, or `AUDIT_WITHOUT_RECEIPT` for an offline audit.
   */
  checkIntegrity(runId: string, receipt: ReceiptOrAudit): IntegrityResult {
    const opened = this.openVerdictInputs(runId, receipt);
    if (opened.ok) return { ok: true, runId, sealDigest: opened.inputs.sealDigest };
    return { ok: false, runId, violations: opened.violations };
  }

  /**
   * Read every vault file once, check it, and return the checked bytes. The oracle must
   * use these bytes and nothing else.
   */
  openVerdictInputs(runId: string, receipt: ReceiptOrAudit): VerdictInputsResult {
    const violations: IntegrityViolation[] = [];
    // A JS caller (or a cast) can still pass nothing: that is a refusal, not an audit.
    const audit = receipt === AUDIT_WITHOUT_RECEIPT;
    if (
      !audit &&
      (receipt === null ||
        typeof receipt !== "object" ||
        typeof receipt.runId !== "string" ||
        typeof receipt.sealDigest !== "string")
    )
      violations.push({
        code: "receipt-missing",
        detail: "no seal receipt for this trial: pass the calling trial's receipt",
      });
    let dir: string;
    try {
      dir = this.runDir(runId);
    } catch (e) {
      return { ok: false, violations: [{ code: "seal-missing", detail: String(e) }] };
    }

    const reach = this.reachability();
    if (reach) violations.push({ code: "vault-reachable", detail: reach });
    for (const d of [this.root, dir]) {
      if (!existsSync(d)) continue;
      const st = lstatSync(d);
      if (!st.isDirectory() || (st.mode & 0o077) !== 0)
        violations.push({
          code: "vault-permissions",
          path: d,
          detail: `vault dir must be a 0700 directory, got mode ${(st.mode & 0o777).toString(8)}`,
        });
    }

    // 1. Seal manifest: signature, then receipt.
    const seal = this.readSigned<SealManifest>(dir, SEAL);
    if (!seal.ok) {
      violations.push(seal.violation);
      return { ok: false, violations };
    }
    if (seal.body.runId !== runId)
      violations.push({ code: "seal-malformed", detail: `seal names run ${seal.body.runId}` });
    const sealDigest = sha256(seal.text);
    if (
      !audit &&
      violations.every((v) => v.code !== "receipt-missing") &&
      typeof receipt === "object" &&
      (receipt.runId !== runId || !sameHex(receipt.sealDigest, sealDigest))
    )
      violations.push({
        code: "receipt-mismatch",
        detail: "seal manifest differs from the receipt held since seal time",
      });

    // 2. Sealed files: present, regular, read-only, matching hash. Read once.
    const sealedBytes = new Map<string, Buffer>();
    for (const [rel, want] of Object.entries(seal.body.files)) {
      const got = this.readChecked(dir, rel, want, "sealed", violations);
      if (got) sealedBytes.set(rel, got);
    }

    // 3. Oracle sources unchanged since seal.
    for (const [path, want] of Object.entries(seal.body.oracle.sources)) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        violations.push({
          code: "oracle-source-missing",
          path,
          detail: "oracle source unreadable",
        });
        continue;
      }
      if (sha256(bytes) !== want)
        violations.push({
          code: "oracle-source-hash",
          path,
          detail: "oracle source changed since seal",
        });
    }

    // 4. Stop marker, bound to this seal.
    const stop = this.readSigned<StopManifest>(dir, STOP);
    if (!stop.ok) {
      violations.push(
        stop.violation.code === "seal-missing"
          ? { code: "agent-not-stopped", detail: "no stop marker: the agent may still be running" }
          : { ...stop.violation, code: "stop-signature" },
      );
    } else if (!sameHex(stop.body.sealDigest, sealDigest)) {
      violations.push({
        code: "stop-signature",
        detail: "stop marker is bound to a different seal",
      });
    }

    // 5. Capture manifest, bound to this stop marker; captured files read once.
    const capturedBytes = new Map<string, Buffer>();
    const capture = this.readSigned<CaptureManifest>(dir, CAPTURE);
    if (!capture.ok) {
      violations.push(
        capture.violation.code === "seal-missing"
          ? { code: "capture-missing", detail: "nothing captured after the agent stopped" }
          : { ...capture.violation, code: "capture-signature" },
      );
    } else {
      if (!stop.ok || !sameHex(capture.body.stopDigest, sha256(stop.text)))
        violations.push({
          code: "capture-signature",
          detail: "capture is not bound to this run's stop marker (captured before stop?)",
        });
      for (const [rel, want] of Object.entries(capture.body.files)) {
        const got = this.readChecked(dir, rel, want, "captured", violations);
        if (got) capturedBytes.set(rel, got);
      }
    }

    // 6. No file in the run dir that no manifest accounts for (a dropped result.json,
    //    an extra "fixture", a planted symlink).
    const expected = new Set<string>([SEAL, STOP, CAPTURE, ...Object.keys(seal.body.files)]);
    if (capture.ok) for (const rel of Object.keys(capture.body.files)) expected.add(rel);
    for (const rel of listTree(dir))
      if (!expected.has(rel))
        violations.push({ code: "unexpected-file", path: rel, detail: "file not in any manifest" });

    if (violations.length > 0) return { ok: false, violations };

    const gt = sealedBytes.get(GROUND_TRUTH);
    if (!gt)
      return {
        ok: false,
        violations: [
          { code: "sealed-file-missing", path: GROUND_TRUTH, detail: "no ground truth sealed" },
        ],
      };
    const fixtures: Record<string, Uint8Array> = {};
    for (const [rel, bytes] of sealedBytes)
      if (rel.startsWith(`${FIXTURES}/`)) fixtures[rel.slice(FIXTURES.length + 1)] = bytes;
    const persisted: Record<string, Uint8Array> = {};
    for (const [rel, bytes] of capturedBytes) {
      const name = rel.slice(CAPTURED.length + 1);
      if (name.startsWith(PERSISTED_PREFIX)) persisted[name.slice(PERSISTED_PREFIX.length)] = bytes;
    }
    return {
      ok: true,
      inputs: {
        runId,
        sealDigest,
        groundTruth: JSON.parse(gt.toString("utf8")),
        fixtures,
        persisted,
      },
    };
  }

  private readSigned<T extends { runId: string }>(
    dir: string,
    rel: string,
  ): { ok: true; body: T; text: string } | { ok: false; violation: IntegrityViolation } {
    const path = join(dir, rel);
    let text: string;
    try {
      const st = lstatSync(path);
      if (!st.isFile())
        return {
          ok: false,
          violation: {
            code: "seal-malformed",
            path: rel,
            detail: "manifest is not a regular file",
          },
        };
      text = readFileSync(path, "utf8");
    } catch {
      return {
        ok: false,
        violation: { code: "seal-missing", path: rel, detail: `${rel} missing` },
      };
    }
    let parsed: Signed<T>;
    try {
      parsed = JSON.parse(text) as Signed<T>;
    } catch {
      return {
        ok: false,
        violation: { code: "seal-malformed", path: rel, detail: `${rel} is not JSON` },
      };
    }
    const { mac, ...body } = parsed;
    if (typeof mac !== "string" || !sameHex(mac, macOf(this.key, canonical(body))))
      return {
        ok: false,
        violation: { code: "seal-signature", path: rel, detail: `${rel} MAC does not verify` },
      };
    return { ok: true, body: body as unknown as T, text };
  }

  private readChecked(
    dir: string,
    rel: string,
    want: string,
    kind: "sealed" | "captured",
    out: IntegrityViolation[],
  ): Buffer | undefined {
    const path = join(dir, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      out.push({ code: `${kind}-file-missing`, path: rel, detail: "missing" });
      return undefined;
    }
    if (!st.isFile() || st.nlink !== 1) {
      out.push({
        code: `${kind}-file-not-regular`,
        path: rel,
        detail: "not a regular single-link file",
      });
      return undefined;
    }
    if ((st.mode & 0o222) !== 0)
      out.push({
        code: `${kind}-file-writable`,
        path: rel,
        detail: `mode ${(st.mode & 0o777).toString(8)}`,
      });
    const bytes = readFileSync(path);
    if (sha256(bytes) !== want) {
      out.push({
        code: `${kind}-file-hash`,
        path: rel,
        detail: "content differs from its manifest hash",
      });
      return undefined;
    }
    return bytes;
  }
}

/** Every non-directory entry under `dir`, as `/`-joined relative paths. Symlinks are listed, not followed. */
function listTree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(dir, rel));
    else out.push(rel);
  }
  return out;
}
