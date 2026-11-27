/**
 * Plugin registration and invocation (capability track T, `myco.plugin/1`).
 *
 * Registration (`registerPlugin`):
 *  1. load the closed manifest (`myco-plugin.json`) and hash the plugin directory;
 *  2. for an oracle plugin, run the R5 oracle mutation self-test (`src/oracle-selftest`)
 *     out-of-process: the plugin's own cases, plus read corruptions the HOST derives from
 *     every correct document (truncations, flipped bytes, a missing file), so a plugin cannot
 *     pick only the damage it happens to catch;
 *  3. refuse the plugin unless the self-test passes for EVERY claimed class and the sandbox
 *     answered every self-test document within its caps (an over-claim is a refusal).
 * Only a registration object issued here is accepted later (a WeakSet, not a shape check),
 * and every call re-hashes the plugin directory: an edited plugin is `PLUGIN_CHANGED`.
 *
 * Results carry plugin provenance and are labelled `r1Evidence: false` /
 * `evidenceClass: "plugin-experiment"`: a plugin verdict never counts as R1 evidence unless
 * the lead rules otherwise, and it is not a `myco.benchmark.arm-row/1` row.
 *
 * Plugins are NOT wired into `myco.gate/v1`: the gate request, its oracle and its fail-closed
 * rules are unchanged. Wiring a plugin into the gate is a separate, reviewed change.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type OracleReport, runSelfTest, type SelfTestRow } from "../../oracle-selftest/run.ts";
import type {
  CorruptionClass,
  OracleUnderTest,
  OracleVerdict,
  SavedDocument,
  SelfTestCase,
} from "../../oracle-selftest/types.ts";
import {
  MAX_SELFTEST_OUTPUT_BYTES,
  type OracleStatus,
  PLUGIN_SPEC,
  type PluginManifest,
  type PluginState,
  parseIntent,
  parseManifest,
  type WireDocument,
} from "../sdk/protocol.ts";
import { runInSandbox, type SandboxTarget } from "./sandbox.ts";

export const MANIFEST_FILE = "myco-plugin.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_TREE_FILES = 256;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export interface PluginProvenance {
  readonly source: "plugin";
  readonly spec: typeof PLUGIN_SPEC;
  readonly plugin: string;
  readonly version: string;
  readonly app: string;
  readonly manifestSha256: string;
  readonly treeSha256: string;
}

export interface PluginRegistration {
  readonly provenance: PluginProvenance;
  readonly manifest: PluginManifest;
  readonly dir: string;
  /** The R5 self-test the plugin passed (null for a reader-only plugin). */
  readonly selftest: OracleReport | null;
  readonly selftestRows: readonly SelfTestRow[];
}

export const REFUSAL_CODES = [
  "PLUGIN_DIR_INVALID",
  "MANIFEST_INVALID",
  "SELFTEST_CASES_FAULT",
  "SELFTEST_CASES_INVALID",
  "SELFTEST_HARNESS_FAULT",
  "SELFTEST_FAILED",
  "PLUGIN_CHANGED",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type RegistrationResult =
  | { readonly ok: true; readonly registration: PluginRegistration }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      /** Operator-facing detail (host side only; never sent to an agent). */
      readonly reasons: readonly string[];
      readonly selftest: OracleReport | null;
    };

/** Every result says where it came from and that it is not R1 evidence. */
interface Labelled {
  /** `host` when the sandbox or the host refused (a `PLUGIN_*` code), else `plugin`. */
  readonly codeSource: "plugin" | "host";
  readonly provenance: PluginProvenance | null;
  readonly r1Evidence: false;
  readonly evidenceClass: "plugin-experiment";
}
export interface PluginVerdict extends Labelled {
  readonly status: OracleStatus;
  readonly code: string;
}
export interface PluginReading extends Labelled {
  readonly status: "ok" | "uncertain";
  readonly code: string;
  readonly state: PluginState | null;
}

const ISSUED = new WeakSet<PluginRegistration>();

class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly reasons: readonly string[],
  ) {
    super(code);
  }
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * SHA-256 over every regular file under `dir` (sorted relative path + file hash). Symlinks
 * and special files are refused, so the hash covers exactly what the child can read.
 */
export function treeSha256(dir: string): string {
  const entries: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Refusal("PLUGIN_DIR_INVALID", [`symlink: ${name}`]);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        total += st.size;
        if (entries.length >= MAX_TREE_FILES || total > MAX_TREE_BYTES)
          throw new Refusal("PLUGIN_DIR_INVALID", ["plugin directory exceeds its size bound"]);
        entries.push(`${relative(dir, p).split(sep).join("/")}\0${sha256(readFileSync(p))}`);
      } else throw new Refusal("PLUGIN_DIR_INVALID", [`not a regular file: ${name}`]);
    }
  };
  walk(dir);
  return sha256(entries.join("\n"));
}

function loadManifest(dir: string): { manifest: PluginManifest; manifestSha256: string } {
  const path = join(dir, MANIFEST_FILE);
  let raw: Buffer;
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a file");
    raw = readFileSync(path);
  } catch {
    throw new Refusal("MANIFEST_INVALID", [`${MANIFEST_FILE} is missing`]);
  }
  if (raw.length > MAX_MANIFEST_BYTES)
    throw new Refusal("MANIFEST_INVALID", [`${MANIFEST_FILE} exceeds ${MAX_MANIFEST_BYTES} bytes`]);
  try {
    const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
    return { manifest, manifestSha256: sha256(JSON.stringify(manifest)) };
  } catch (e) {
    throw new Refusal("MANIFEST_INVALID", [(e as Error).message]);
  }
}

function targetOf(dir: string, manifest: PluginManifest): SandboxTarget {
  const entry = join(dir, ...manifest.entry.split("/"));
  try {
    if (!lstatSync(entry).isFile()) throw new Error("not a file");
  } catch {
    throw new Refusal("MANIFEST_INVALID", ["manifest.entry is not a file in the plugin directory"]);
  }
  return { dir, entry, caps: manifest.caps };
}

/** The basename of a captured file, whatever separator the capture used. */
function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? "";
}

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i <= 0 ? "" : fileName.slice(i).toLowerCase();
}

type HostOutcome =
  | { readonly ok: true; readonly status: OracleStatus; readonly code: string }
  | { readonly ok: false; readonly code: string };

/** Checks every bound the host owns, then runs the oracle in the sandbox. Never throws. */
function callOracle(
  target: SandboxTarget,
  manifest: PluginManifest,
  doc: SavedDocument,
  intent: unknown,
): HostOutcome {
  const fileName = baseName(doc.fileName);
  if (!FILE_NAME.test(fileName)) return { ok: false, code: "PLUGIN_FILENAME_INVALID" };
  if (!manifest.formats.some((f) => f.ext === extOf(fileName)))
    return { ok: false, code: "PLUGIN_FORMAT_UNCLAIMED" };
  if (doc.bytes !== null && doc.bytes.length > manifest.caps.maxInputBytes)
    return { ok: false, code: "PLUGIN_INPUT_TOO_LARGE" };
  let wireIntent: ReturnType<typeof parseIntent>;
  try {
    wireIntent = parseIntent(intent, "intent");
  } catch {
    return { ok: false, code: "PLUGIN_INTENT_INVALID" };
  }
  const r = runInSandbox(target, {
    spec: PLUGIN_SPEC,
    op: "verify",
    doc: {
      fileName,
      bytesB64: doc.bytes === null ? null : Buffer.from(doc.bytes).toString("base64"),
    },
    intent: wireIntent,
  });
  if (!r.ok) return r;
  if (r.response.op !== "verify") return { ok: false, code: "PLUGIN_MALFORMED_OUTPUT" };
  return { ok: true, status: r.response.status, code: r.response.code };
}

function fromWire(doc: WireDocument): SavedDocument {
  return {
    fileName: doc.fileName,
    bytes: doc.bytesB64 === null ? null : new Uint8Array(Buffer.from(doc.bytesB64, "base64")),
  };
}

/**
 * Read corruptions the host derives from a correct document, independent of the plugin:
 * three truncations, three single-byte flips, and a missing file.
 */
export function hostCorruptions(
  correct: SavedDocument,
): { cls: CorruptionClass; doc: SavedDocument }[] {
  const bytes = correct.bytes;
  if (bytes === null || bytes.length === 0) return [];
  const n = bytes.length;
  const out: { cls: CorruptionClass; doc: SavedDocument }[] = [];
  for (const at of new Set([n - 1, Math.floor(n / 2), Math.floor(n / 4)]))
    out.push({ cls: "truncated", doc: { fileName: correct.fileName, bytes: bytes.slice(0, at) } });
  for (const at of new Set([Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])) {
    const flipped = bytes.slice();
    flipped[at] = (flipped[at] as number) ^ 0x01;
    out.push({ cls: "corrupt-byte", doc: { fileName: correct.fileName, bytes: flipped } });
  }
  out.push({ cls: "missing-file", doc: { fileName: correct.fileName, bytes: null } });
  return out;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** Ask the plugin for its own self-test cases (the default registration path). */
function pluginCases(target: SandboxTarget): SelfTestCase<unknown>[] {
  const got = runInSandbox(
    target,
    { spec: PLUGIN_SPEC, op: "selftest-cases" },
    // Self-test cases carry whole documents, so this one call has its own ceiling rather
    // than the manifest's verdict cap; the kernel file-size limit follows it (8 MiB + one
    // block on disk at most, E3 on #558).
    { maxOutputBytes: MAX_SELFTEST_OUTPUT_BYTES },
  );
  if (!got.ok) throw new Refusal("SELFTEST_CASES_FAULT", [got.code]);
  if (got.response.op !== "selftest-cases")
    throw new Refusal("SELFTEST_CASES_FAULT", ["PLUGIN_MALFORMED_OUTPUT"]);
  return got.response.cases.map((c) => ({
    id: c.id,
    intent: c.intent,
    correct: fromWire(c.correct),
    corruptions: c.corruptions.map((x) => ({ cls: x.cls, doc: fromWire(x.doc) })),
  }));
}

export interface RegisterOptions {
  /**
   * Self-test cases the HOST supplies (track C, agent-written checks: the cases come from the
   * R5 subjects of the task family, never from the check's author). When given, the plugin's
   * `selftestCases` hook is not called. Host read corruptions are added to every case either way.
   */
  readonly hostCases?: readonly SelfTestCase<unknown>[];
}

export function registerPlugin(pluginDir: string, opts: RegisterOptions = {}): RegistrationResult {
  let selftest: OracleReport | null = null;
  try {
    let dir: string;
    try {
      dir = realpathSync(pluginDir);
      if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Refusal("PLUGIN_DIR_INVALID", ["plugin directory does not exist"]);
    }
    const treeBefore = treeSha256(dir);
    const { manifest, manifestSha256 } = loadManifest(dir);
    const target = targetOf(dir, manifest);

    let rows: SelfTestRow[] = [];
    if (manifest.kinds.includes("oracle")) {
      const supplied = opts.hostCases ?? pluginCases(target);
      if (supplied.length === 0)
        throw new Refusal("SELFTEST_CASES_INVALID", ["no self-test cases"]);
      const cases: SelfTestCase<unknown>[] = supplied.map((c) => {
        if (!manifest.formats.some((f) => f.ext === extOf(c.correct.fileName)))
          throw new Refusal("SELFTEST_CASES_INVALID", [
            `case ${c.id}: ${c.correct.fileName} is not a format the manifest declares`,
          ]);
        return {
          id: c.id,
          intent: c.intent,
          correct: c.correct,
          corruptions: [...c.corruptions, ...hostCorruptions(c.correct)],
        };
      });
      const faults: string[] = [];
      const oracle: OracleUnderTest<unknown> = {
        name: `plugin:${manifest.name}`,
        version: manifest.version,
        claims: new Set<CorruptionClass>(manifest.claims),
        verify(doc, intent): OracleVerdict {
          const r = callOracle(target, manifest, doc, intent);
          if (r.ok) return { status: r.status, code: r.code };
          faults.push(r.code);
          return { status: "uncertain", code: r.code };
        },
      };
      const run = runSelfTest(oracle, cases);
      rows = run.rows;
      selftest = run.report;
      if (!run.report.pass) throw new Refusal("SELFTEST_FAILED", run.report.reasons);
      // A catch the sandbox made (a timeout, a crash) is not a catch the plugin made.
      if (faults.length > 0)
        throw new Refusal("SELFTEST_HARNESS_FAULT", [...new Set(faults)].sort());
    }
    if (treeSha256(dir) !== treeBefore)
      throw new Refusal("PLUGIN_CHANGED", ["plugin directory changed during registration"]);

    const registration: PluginRegistration = deepFreeze({
      provenance: {
        source: "plugin",
        spec: PLUGIN_SPEC,
        plugin: manifest.name,
        version: manifest.version,
        app: manifest.app,
        manifestSha256,
        treeSha256: treeBefore,
      },
      manifest,
      dir,
      selftest,
      selftestRows: rows,
    });
    ISSUED.add(registration);
    return { ok: true, registration };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, reasons: e.reasons, selftest };
    return { ok: false, code: "PLUGIN_DIR_INVALID", reasons: ["unreadable plugin"], selftest };
  }
}

const LABEL = { r1Evidence: false, evidenceClass: "plugin-experiment" } as const;

/** The checks every call makes before the plugin runs; a string is a host refusal code. */
function admit(
  reg: PluginRegistration,
  kind: "oracle" | "reader",
): { target: SandboxTarget } | string {
  if (!ISSUED.has(reg)) return "PLUGIN_NOT_REGISTERED";
  if (!reg.manifest.kinds.includes(kind)) return "PLUGIN_KIND_UNCLAIMED";
  try {
    if (treeSha256(reg.dir) !== reg.provenance.treeSha256) return "PLUGIN_CHANGED";
    return { target: targetOf(reg.dir, reg.manifest) };
  } catch {
    return "PLUGIN_CHANGED";
  }
}

/**
 * Run a registered oracle over one trial's captured document. Never throws; every failure is
 * `uncertain` with a code. `doc.fileName` may be a capture path: only its basename is sent.
 */
export function runPluginOracle(
  reg: PluginRegistration,
  doc: SavedDocument,
  intent: unknown,
): PluginVerdict {
  const provenance = ISSUED.has(reg) ? reg.provenance : null;
  const admitted = admit(reg, "oracle");
  if (typeof admitted === "string")
    return { status: "uncertain", code: admitted, codeSource: "host", provenance, ...LABEL };
  const r = callOracle(admitted.target, reg.manifest, doc, intent);
  return r.ok
    ? { status: r.status, code: r.code, codeSource: "plugin", provenance, ...LABEL }
    : { status: "uncertain", code: r.code, codeSource: "host", provenance, ...LABEL };
}

/** Run a registered state reader over one captured document. Never throws. */
export function runPluginReader(reg: PluginRegistration, doc: SavedDocument): PluginReading {
  const provenance = ISSUED.has(reg) ? reg.provenance : null;
  const host = (code: string): PluginReading => ({
    status: "uncertain",
    code,
    state: null,
    codeSource: "host",
    provenance,
    ...LABEL,
  });
  const admitted = admit(reg, "reader");
  if (typeof admitted === "string") return host(admitted);
  const fileName = baseName(doc.fileName);
  if (!FILE_NAME.test(fileName)) return host("PLUGIN_FILENAME_INVALID");
  if (!reg.manifest.formats.some((f) => f.ext === extOf(fileName)))
    return host("PLUGIN_FORMAT_UNCLAIMED");
  if (doc.bytes !== null && doc.bytes.length > reg.manifest.caps.maxInputBytes)
    return host("PLUGIN_INPUT_TOO_LARGE");
  const r = runInSandbox(admitted.target, {
    spec: PLUGIN_SPEC,
    op: "read",
    doc: {
      fileName,
      bytesB64: doc.bytes === null ? null : Buffer.from(doc.bytes).toString("base64"),
    },
  });
  if (!r.ok) return host(r.code);
  if (r.response.op !== "read") return host("PLUGIN_MALFORMED_OUTPUT");
  return {
    status: r.response.status,
    code: r.response.code,
    state: r.response.state,
    codeSource: "plugin",
    provenance,
    ...LABEL,
  };
}
