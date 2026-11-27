/**
 * Benchmark site (workstream 3, track G): the only way a number reaches the site's results
 * table. A number is shown only when it was RECOMPUTED AT BUILD TIME, by the existing M2
 * evidence check (`checkPack`, `src/m2/evidence.ts`) and the evidence-provenance check
 * (`packProvenanceErrors`, `src/m2/provenance.ts`), from a result pack that is
 *
 *  1. described by a closed manifest (`result.json`, schema `myco.benchmark.site-result/1`)
 *     that pins every other file of the pack by SHA-256, with no file missing, extra,
 *     symlinked or differing;
 *  2. committed: every file, `result.json` included, is the blob at the repository's HEAD,
 *     unchanged in the working tree (`isCommitted`, injected so tests can use a temp repo);
 *  3. an evidence pack: `checkPack` is ok (schemas, ledger consistency, attempt ledger and
 *     anchor, process checks), every arm row's planner is an evidence planner (simulated and
 *     experiment rows are refused), and its task set is a published one;
 *  4. of kind `evidence`, unless the caller allows test fixtures (tests only; the build CLI
 *     never does). A test-fixture pack renders under a "TEST FIXTURE" banner, never as a result.
 *
 * The numbers the site renders are read from that recomputation only; the pack's own files
 * carry no summary numbers, and `result.json` admits none. `VerifiedResult` objects exist only
 * through `verifyResultPack`: the renderer refuses any other object (`assertVerified`), so a
 * hand-built or edited result can never be rendered.
 *
 * Layout of one result pack (`<resultsRoot>/<id>/`):
 *   result.json                    the manifest (not listed in its own `files`)
 *   pack/                          one M2 evidence pack (schemas/m2-evidence.ts layout)
 *   attempt-anchors/pack.jsonl     the pack's external attempt anchor (`anchorPathFor`)
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkPack, type PackResult, readPack } from "../../m2/evidence.ts";
import { packProvenanceErrors } from "../../m2/provenance.ts";
import { PUBLISHED_TASK_SETS } from "../published-tasks.ts";

export const SITE_RESULT_SCHEMA = "myco.benchmark.site-result/1";
export const RESULT_MANIFEST = "result.json";
export const PACK_DIR = "pack";

export type ResultKind = "evidence" | "test-fixture";

/** Whether `relPath` (relative to the repository root) is committed at HEAD, unchanged. */
export type CommittedCheck = (absPath: string) => boolean;

export interface VerifyOptions {
  readonly isCommitted: CommittedCheck;
  /** Tests only: accept a `test-fixture` pack (rendered under a TEST FIXTURE banner). */
  readonly allowTestFixture?: boolean;
}

export interface VerifiedResult {
  readonly id: string;
  readonly kind: ResultKind;
  /** SHA-256 of `result.json`'s bytes: the pack's digest, shown beside its numbers. */
  readonly manifestSha256: string;
  readonly taskSetVersion: string;
  readonly check: PackResult;
}

export class ResultPackRefused extends Error {
  constructor(
    readonly id: string,
    readonly reasons: readonly string[],
  ) {
    super(`result pack ${id} refused: ${reasons.join("; ")}`);
    this.name = "ResultPackRefused";
  }
}

const VERIFIED = new WeakSet<object>();

/** Throws unless `r` came from `verifyResultPack` unchanged (it is frozen, deeply). */
export function assertVerified(r: unknown): asserts r is VerifiedResult {
  if (r === null || typeof r !== "object" || !VERIFIED.has(r))
    throw new Error("refused: a result that did not come from verifyResultPack is never rendered");
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** Every file under `dir`, as `/`-separated paths relative to it; symlinks reported apart. */
function walk(dir: string, base = dir, files: string[] = [], links: string[] = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(base, abs).split(sep).join("/");
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) links.push(rel);
    else if (st.isDirectory()) walk(abs, base, files, links);
    else if (st.isFile()) files.push(rel);
    else links.push(rel);
  }
  return { files, links };
}

function manifestErrors(m: unknown, id: string): string[] {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return ["manifest-not-object"];
  const o = m as Record<string, unknown>;
  const errors: string[] = [];
  const allowed = new Set(["schema", "id", "kind", "files"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) errors.push("manifest-unknown-field");
  if (o.schema !== SITE_RESULT_SCHEMA) errors.push("manifest-schema");
  if (o.id !== id) errors.push("manifest-id-not-directory");
  if (o.kind !== "evidence" && o.kind !== "test-fixture") errors.push("manifest-kind");
  const f = o.files;
  if (f === null || typeof f !== "object" || Array.isArray(f)) errors.push("manifest-files");
  else
    for (const [p, d] of Object.entries(f))
      if (typeof d !== "string" || !HEX64.test(d) || p.length === 0)
        errors.push("manifest-file-digest-malformed");
  return [...new Set(errors)];
}

/**
 * Verify one result pack directory and recompute its numbers. Throws `ResultPackRefused`
 * (reason codes and pack-relative paths only, never file content) on any failure.
 */
export function verifyResultPack(dir: string, id: string, opts: VerifyOptions): VerifiedResult {
  const refuse = (reasons: string[]): never => {
    throw new ResultPackRefused(id, reasons);
  };
  if (!ID.test(id)) refuse(["id-not-a-slug"]);
  const manifestPath = join(dir, RESULT_MANIFEST);
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) refuse(["manifest-missing"]);
  const manifestBytes = readFileSync(manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    refuse(["manifest-not-json"]);
  }
  const mErr = manifestErrors(manifest, id);
  if (mErr.length > 0) refuse(mErr);
  const m = manifest as { kind: ResultKind; files: Record<string, string> };
  if (m.kind === "test-fixture" && opts.allowTestFixture !== true)
    refuse(["test-fixture-outside-tests"]);

  // 1. Digests: the files on disk are exactly the pinned files, byte for byte.
  const errors: string[] = [];
  const { files, links } = walk(dir);
  for (const l of links) errors.push(`not-a-regular-file ${l}`);
  const onDisk = new Set(files.filter((f) => f !== RESULT_MANIFEST));
  for (const f of onDisk)
    if (!Object.hasOwn(m.files, f)) errors.push(`file-not-in-manifest ${f}`);
    else if (sha256(readFileSync(join(dir, f))) !== m.files[f]) errors.push(`digest-mismatch ${f}`);
  for (const f of Object.keys(m.files)) if (!onDisk.has(f)) errors.push(`file-missing ${f}`);
  if (!Object.keys(m.files).some((f) => f.startsWith(`${PACK_DIR}/`))) errors.push("no-pack");
  if (errors.length > 0) refuse(errors);

  // 2. Committed: every file is HEAD's blob, unchanged.
  for (const f of [RESULT_MANIFEST, ...onDisk])
    if (!opts.isCommitted(join(dir, f))) errors.push(`not-committed ${f}`);
  if (errors.length > 0) refuse(errors);

  // 3. Recompute with the existing evidence check. Published packs carry no run directories.
  const packDir = join(dir, PACK_DIR);
  const input = readPack(packDir, () => ({ ok: false, detail: "runs-not-published" }));
  const check = checkPack(input);
  if (!check.ok) errors.push(`evidence-check-failed (${check.errors.length} error(s))`);
  const prov = packProvenanceErrors(packDir, input.arm);
  if (prov.length > 0 || check.benchmark.provenance !== "evidence")
    errors.push("not-evidence-provenance");
  const version = check.benchmark.taskSetVersion;
  if (version === null || !Object.hasOwn(PUBLISHED_TASK_SETS, version))
    errors.push("task-set-not-published");
  if (errors.length > 0) refuse(errors);

  const result: VerifiedResult = deepFreeze({
    id,
    kind: m.kind,
    manifestSha256: sha256(manifestBytes),
    taskSetVersion: version as string,
    check,
  });
  VERIFIED.add(result);
  return result;
}

/**
 * Every result pack under `root` (each subdirectory is one; plain files such as a README are
 * ignored). A missing root is no packs. Any refused pack fails the whole build: a refusal is
 * never silently dropped from the table.
 */
export function verifyResultsRoot(root: string, opts: VerifyOptions): VerifiedResult[] {
  if (!existsSync(root)) return [];
  const out: VerifiedResult[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new ResultPackRefused(name, ["not-a-regular-file"]);
    if (st.isDirectory()) out.push(verifyResultPack(abs, name, opts));
  }
  return out;
}
