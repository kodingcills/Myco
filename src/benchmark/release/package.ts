/**
 * Release packaging for the public false-completion package (track G, #613; #612 item N2).
 *
 * Builds the publishable bundle from a git commit, never from the working tree, so what is
 * published is what main holds, byte for byte, and nothing a checkout picked up (extended
 * attributes such as macOS `com.apple.provenance`, owners, stray files) can come along:
 *
 *  - ALLOWLIST ONLY. The repo files published are `RELEASE_REPO_FILES` and the files under
 *    `RELEASE_REPO_TREES`, plus the grader's import closure (`graderClosure`): the entry
 *    scripts and every module they import, followed through relative imports. An import that
 *    is neither `node:*` nor inside `GRADER_TREES` refuses the build, so the grader cannot
 *    silently grow a dependency on code the bundle does not carry.
 *  - DATASETS only through `readDataset`: the directory itself must be named `dataset` or
 *    `ds` (the run logs next to a dataset hold host paths, #612 N2), and every file in it must
 *    be a regular UTF-8 text file with a plain name. Symlinks, binaries and anything else
 *    refuse the build.
 *  - LEAK SCAN over every file's path and every line of its content (`scanFile`): an absolute
 *    host path, this machine's user or host name, a secret-shaped string or the planted canary
 *    (the track U scan, `src/dataset/hygiene.ts`), and every configured identity string
 *    (`src/export-guard` `heldEntries`, the rule the export surfaces share). One finding refuses
 *    the whole build. A finding names the file, the line number and the kind, never the text.
 *  - ARCHIVE (`ustarArchive`): a plain ustar file written from the bytes in memory. No pax or
 *    GNU extension headers (so no extended attributes can be expressed), empty owner and group
 *    names, uid and gid 0, mode 0644, one fixed mtime, entries in sorted order. The same commit
 *    and datasets give the same archive bytes on any machine.
 *  - SHA-256 of every file, in `release-manifest.json` and in `SHA256SUMS` (`sha256sum -c`).
 *
 * Imports nothing from the gate, the pilot or the evidence paths.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { type HygieneOptions, identityStrings, leaksIn } from "../../dataset/hygiene.ts";
import { heldEntries, type IdentityPair } from "../../export-guard/identity-words.ts";
import { assertFreshOut, destinationInside } from "../requests.ts";

export const RELEASE_SCHEMA = "myco.benchmark.release/1";
export const RELEASE_TASK_SET = "fc-v1";
/** Top-level directory of the archive. */
export const RELEASE_ROOT = `myco-false-completion-${RELEASE_TASK_SET}`;

/** Single repo files published as they are in the commit. */
export const RELEASE_REPO_FILES: readonly string[] = [
  "LICENSE",
  "docs/benchmark/public/README.md",
  "docs/benchmark/public/grading-protocol.md",
  "docs/benchmark/public/task-set-card.md",
];
/** Repo directories published whole (every blob under them in the commit). */
export const RELEASE_REPO_TREES: readonly string[] = [
  `benchmark/false-completion/${RELEASE_TASK_SET}/`,
];
/** The grader CLI and the standalone bundle verifier; their imports are followed. */
export const GRADER_ENTRIES: readonly string[] = [
  "scripts/benchmark-grade.ts",
  "scripts/benchmark-verify-bundle.ts",
];
/** Where a module of the grader's closure may live. Anything else refuses the build. */
export const GRADER_TREES: readonly string[] = ["scripts/", "src/benchmark/grade/", "schemas/"];
/** A dataset directory must have one of these names (#612 N2: never its run directory). */
export const DATASET_DIR_NAMES: readonly string[] = ["dataset", "ds"];

/** Files the packager writes itself (never read from the repo or a dataset). */
export const GENERATED = {
  packageJson: "package.json",
  readme: "RELEASE.md",
  requests: "reproduce-requests.jsonl",
  expected: "reproduce-expected.jsonl",
  docsDir: "reproduce/",
  manifest: "release-manifest.json",
  sums: "SHA256SUMS",
} as const;

export class ReleaseRefusal extends Error {
  constructor(readonly findings: readonly string[]) {
    super(`release refused: ${findings.length} finding(s)\n${findings.join("\n")}`);
    this.name = "ReleaseRefusal";
  }
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A file of the bundle: its path inside the bundle root and its bytes. */
export interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Read access to one commit. */
export interface CommitReader {
  readonly commit: string;
  /** Committer time, seconds since the epoch: the archive's one mtime. */
  readonly time: number;
  /** Every blob path at or under `pathspec` (a file or a directory ending in `/`), sorted. */
  list(pathspec: string): string[];
  read(path: string): Uint8Array;
}

/**
 * A reader over `ref` in the repository at `repoDir`, through git's plumbing (no shell). A
 * symlink or submodule entry under a requested path refuses the build: the bundle carries
 * regular files only.
 */
export function gitReader(repoDir: string, ref: string): CommitReader {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    .toString("utf8")
    .trim();
  const time = Number(git(["show", "-s", "--format=%ct", commit]).toString("utf8").trim());
  return {
    commit,
    time,
    list(pathspec) {
      const out = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", pathspec]).toString(
        "utf8",
      );
      const paths: string[] = [];
      for (const entry of out.split("\0")) {
        if (entry === "") continue;
        const m = /^(\d{6}) (\w+) [0-9a-f]+\t(.+)$/s.exec(entry);
        if (m === null) throw new ReleaseRefusal([`unreadable tree entry under ${pathspec}`]);
        const [, mode, type, path] = m as unknown as [string, string, string, string];
        if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
          throw new ReleaseRefusal([`${path}: not a regular file in ${commit.slice(0, 8)}`]);
        paths.push(path);
      }
      return paths.sort();
    },
    read(path) {
      return new Uint8Array(git(["cat-file", "blob", `${commit}:${path}`]));
    },
  };
}

const IMPORT_SPEC =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(|\brequire\s*\(/;

/** The module specifiers a source file imports (static imports and re-exports). */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPEC)].map((m) => m[1] as string);
}

/**
 * The grader's files: `entries` and everything they import, transitively. `node:*` imports
 * are fine; a relative import must resolve inside `GRADER_TREES`; anything else (a package,
 * a path outside those trees, a dynamic import or `require`) refuses the build.
 */
export function graderClosure(
  reader: Pick<CommitReader, "list" | "read">,
  entries: readonly string[] = GRADER_ENTRIES,
  trees: readonly string[] = GRADER_TREES,
): string[] {
  const seen = new Set<string>();
  const findings: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!trees.some((t) => path.startsWith(t))) {
      findings.push(`${path}: grader import outside the allowlisted trees`);
      continue;
    }
    if (reader.list(path).length !== 1) {
      findings.push(`${path}: grader module missing from the commit`);
      continue;
    }
    const source = new TextDecoder().decode(reader.read(path));
    if (DYNAMIC_IMPORT.test(source)) findings.push(`${path}: dynamic import or require`);
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        findings.push(`${path}: imports a package (only node: built-ins are allowed)`);
        continue;
      }
      queue.push(posix.normalize(posix.join(posix.dirname(path), spec)));
    }
  }
  if (findings.length > 0) throw new ReleaseRefusal(findings);
  return [...seen].sort();
}

/** Every allowlisted repo file of the commit (including the grader closure), sorted. */
export function repoFiles(reader: CommitReader): BundleFile[] {
  const paths = new Set<string>();
  const findings: string[] = [];
  for (const file of RELEASE_REPO_FILES) {
    if (reader.list(file).length !== 1) findings.push(`${file}: missing from the commit`);
    else paths.add(file);
  }
  for (const tree of RELEASE_REPO_TREES) {
    const found = reader.list(tree);
    if (found.length === 0) findings.push(`${tree}: missing from the commit`);
    for (const p of found) paths.add(p);
  }
  if (findings.length > 0) throw new ReleaseRefusal(findings);
  for (const p of graderClosure(reader)) paths.add(p);
  return [...paths].sort().map((path) => ({ path, bytes: reader.read(path) }));
}

/** Dataset names (the directory under `datasets/`). */
const DATASET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A path segment of a dataset file: plain characters, not hidden (no `.DS_Store`, no `._x`). */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/**
 * The files of one dataset directory, as `datasets/<name>/<relative path>`. Refuses (all
 * findings at once) a name outside `[a-z0-9-]`, a directory not named `dataset` or `ds`, a
 * symlink or other non-regular entry, a hidden or oddly named file, an empty directory, and
 * any file that is not UTF-8 text without NUL bytes. Bytes are read, never copied with their
 * metadata.
 */
export function readDataset(name: string, dir: string): BundleFile[] {
  const findings: string[] = [];
  const label = DATASET_NAME.test(name) ? `datasets/${name}` : "datasets/<name>";
  if (!DATASET_NAME.test(name)) findings.push("dataset name must match [a-z0-9][a-z0-9-]*");
  const top = lstatSync(dir, { throwIfNoEntry: false });
  if (top === undefined || !top.isDirectory()) {
    throw new ReleaseRefusal([...findings, `${label}: not a directory`]);
  }
  if (!DATASET_DIR_NAMES.includes(basename(dir))) {
    findings.push(`${label}: the directory must be named ${DATASET_DIR_NAMES.join(" or ")}`);
  }
  const out: BundleFile[] = [];
  const walk = (abs: string, rel: string[]) => {
    for (const entry of readdirSync(abs).sort()) {
      const relPath = [...rel, entry];
      const shown = SAFE_SEGMENT.test(entry) ? relPath.join("/") : [...rel, "<name>"].join("/");
      const where = `${label}/${shown}`;
      if (!SAFE_SEGMENT.test(entry)) {
        findings.push(`${where}: hidden or unsupported file name`);
        continue;
      }
      const st = lstatSync(join(abs, entry));
      if (st.isDirectory()) walk(join(abs, entry), relPath);
      else if (!st.isFile()) findings.push(`${where}: not a regular file`);
      else {
        const bytes = new Uint8Array(readFileSync(join(abs, entry)));
        if (!isText(bytes)) findings.push(`${where}: not UTF-8 text`);
        else out.push({ path: `${label}/${relPath.join("/")}`, bytes });
      }
    }
  };
  walk(dir, []);
  if (out.length === 0 && findings.length === 0) findings.push(`${label}: empty`);
  if (findings.length > 0) throw new ReleaseRefusal(findings);
  return out;
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** What the leak scan looks for. */
export interface ScanOptions {
  /** Track U scan options: identity file, planted identity, forbidden strings. */
  readonly hygiene?: HygieneOptions;
}

/**
 * Source lines of the grader's closure that the track U host-path pattern reads as a path
 * (regex literals such as `/[\\/]/`, JSON-pointer prefixes such as `#/$defs/`). Exempt from the
 * `host-path` kind ONLY, ONLY in `.ts` files, and ONLY as the exact trimmed line written here:
 * any edit to such a line drops the exemption and refuses the build until it is reviewed
 * again. Identity, secret and canary findings are never exempt. A test fails if an entry no
 * longer matches a line of the bundled grader (no stale exemptions).
 */
export const CODE_HOST_PATH_EXEMPT_LINES: ReadonlySet<string> = new Set([
  `pattern: "^(?![A-Za-z]:)(?![\\\\\\\\/])(?!.*(^|[\\\\\\\\/])\\\\.\\\\.([\\\\\\\\/]|$)).{1,512}$",`,
  "* (local `#/$defs/<name>` only), `$defs`, `type` (string or list), `enum`,",
  `if (!ref.startsWith("#/$defs/")) return undefined;`,
  `const name = ref.slice("#/$defs/".length);`,
  `if (isAbsolute(p) || p.split(/[\\\\/]/).includes("..")) {`,
  `const escapes = (rel: string) => rel === "" || isAbsolute(rel) || rel.split(/[\\\\/]/)[0] === "..";`,
  `if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {`,
  "const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);",
  "return /[yYdD]/.test(stripped);",
]);

/** Whole-string identity matches from this many folded characters (the episode/U rule). */
const IDENTITY_WHOLE_MIN = 3;

/**
 * The scan's identity entries: this machine's account and host name and each configured
 * identity string (`identityStrings`). Computed once per build.
 */
export function identityEntries(options: ScanOptions = {}): IdentityPair[] {
  return identityStrings(options.hygiene ?? {}).map(([kind, raw]) => [kind, raw] as const);
}

/**
 * Findings for one file: its path, then each line of its content. Each finding is
 * `<path>[:<line>] <kind>`; a path that itself leaks is shown as `<path>`. Never the text.
 */
export function scanFile(
  file: BundleFile,
  identities: readonly IdentityPair[],
  options: ScanOptions = {},
): string[] {
  const hygiene = options.hygiene ?? {};
  const kindsOf = (text: string): string[] => {
    const kinds = new Set<string>(leaksIn(text, hygiene));
    for (const i of heldEntries(text, identities, IDENTITY_WHOLE_MIN))
      kinds.add((identities[i] as IdentityPair)[0]);
    return [...kinds];
  };
  const out: string[] = [];
  const pathKinds = kindsOf(file.path);
  const shown = pathKinds.length > 0 ? "<path>" : file.path;
  for (const k of pathKinds) out.push(`${shown} ${k} (in the file name)`);
  if (!isText(file.bytes)) {
    out.push(`${shown} not UTF-8 text`);
    return out;
  }
  const lines = new TextDecoder().decode(file.bytes).split(/\r?\n/);
  const code = file.path.endsWith(".ts");
  for (const [i, line] of lines.entries()) {
    if (line === "") continue;
    const exempt = code && CODE_HOST_PATH_EXEMPT_LINES.has(line.trim());
    for (const k of kindsOf(line))
      if (!(exempt && k === "host-path")) out.push(`${shown}:${i + 1} ${k}`);
  }
  return out;
}

/** Scans every file; throws `ReleaseRefusal` with every finding if there is any. */
export function assertClean(files: readonly BundleFile[], options: ScanOptions = {}): void {
  const identities = identityEntries(options);
  const findings = files.flatMap((f) => scanFile(f, identities, options));
  if (findings.length > 0) throw new ReleaseRefusal(findings);
}

/** The published task row fields the reproduction set uses. */
interface ReproTask {
  readonly taskId: string;
  readonly satisfiable: boolean;
  readonly faultClass: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Record<string, string>;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
}

/** One reproduction request and the status the construction guarantees for it. */
export interface ReproCase {
  readonly request: Record<string, unknown>;
  readonly expectStatus: "pass" | "fail" | "ungradable";
  /** The document to write at `request.persistedFile`, or null for a missing document. */
  readonly document: Uint8Array | null;
}

/**
 * The intent applied to a pristine fixture: the one target cell set to the new value. Every
 * fc-v1 fixture is plain comma-separated text with no quoting, which this checks; a fixture or
 * value that needs quoting refuses the build rather than write a document the grader would
 * read differently.
 */
export function applyIntent(csv: string, intent: ReproTask["intent"]): string | null {
  if (/["\r]/.test(csv) || /[",\r\n]/.test(intent.newValue)) {
    throw new ReleaseRefusal([`fixture or value for ${intent.rowKey} needs CSV quoting`]);
  }
  const rows = csv
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => l.split(","));
  const col = (rows[0] as string[]).indexOf(intent.column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === intent.rowKey);
  if (col < 1 || row < 1) return null;
  (rows[row] as string[])[col] = intent.newValue;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/**
 * The grader reproduction set over every published task, each case's status known by
 * construction: per satisfiable task, the intent applied to the pristine fixture (`pass`);
 * per task, the pristine fixture unchanged (`fail`: the edit is missing; for an unsatisfiable
 * task, whose intent names no cell, that is its only document); and per fault class, one
 * request with no captured document (`ungradable`). Documents are CSV. `fixtures` maps a
 * bundle path to the fixture's bytes; `bundleDir` is the task bundle's directory in the bundle.
 */
export function reproductionCases(
  tasksJsonl: string,
  bundleDir: string,
  fixtures: ReadonlyMap<string, Uint8Array>,
): ReproCase[] {
  const tasks = tasksJsonl
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ReproTask);
  const pristineOf = (t: ReproTask): string => {
    const bytes = fixtures.get(`${bundleDir}${t.fixtureFile}`);
    if (bytes === undefined) throw new ReleaseRefusal([`${t.fixtureFile}: fixture not in bundle`]);
    return new TextDecoder().decode(bytes);
  };
  const one = (
    t: ReproTask,
    variant: "applied" | "pristine" | "missing",
    expectStatus: ReproCase["expectStatus"],
    doc: string | null,
  ): ReproCase => {
    const trialKey = `repro-${t.taskId}-${variant}`;
    return {
      request: {
        trialKey,
        taskId: t.taskId,
        fixtureSha256: t.fixtureSha256,
        fixtureFile: `${bundleDir}${t.fixtureFile}`,
        persistedFile: doc === null ? null : `${GENERATED.docsDir}${trialKey}.csv`,
        persistedFormat: "csv",
        intent: t.intent,
        columnTypes: t.columnTypes,
      },
      expectStatus,
      document: doc === null ? null : utf8(doc),
    };
  };
  const cases: ReproCase[] = [];
  for (const t of tasks) {
    const pristine = pristineOf(t);
    const applied = applyIntent(pristine, t.intent);
    if (t.satisfiable && (applied === null || applied === pristine)) {
      throw new ReleaseRefusal([`${t.taskId}: satisfiable task whose intent names no cell`]);
    }
    if (!t.satisfiable && applied !== null) {
      throw new ReleaseRefusal([`${t.taskId}: unsatisfiable task whose intent names a cell`]);
    }
    if (applied !== null) cases.push(one(t, "applied", "pass", applied));
    cases.push(one(t, "pristine", "fail", pristine));
  }
  for (const t of new Map(tasks.map((t) => [t.faultClass, t])).values()) {
    cases.push(one(t, "missing", "ungradable", null));
  }
  return cases;
}

/** The release manifest: every file's SHA-256 (itself and `SHA256SUMS` excluded). */
export function releaseManifest(
  files: readonly BundleFile[],
  meta: { commit: string; graderVersion: string; datasets: readonly string[] },
): BundleFile {
  const sorted = [...files].sort((a, b) => cmp(a.path, b.path));
  const manifest = {
    schema: RELEASE_SCHEMA,
    taskSetVersion: RELEASE_TASK_SET,
    graderVersion: meta.graderVersion,
    sourceCommit: meta.commit,
    license: "Apache-2.0",
    datasets: [...meta.datasets].sort(),
    files: Object.fromEntries(sorted.map((f) => [f.path, sha256Hex(f.bytes)])),
  };
  return { path: GENERATED.manifest, bytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`) };
}

/** `SHA256SUMS` over every file (`<hex>  <path>`, the format `sha256sum -c` reads). */
export function sha256Sums(files: readonly BundleFile[]): BundleFile {
  const lines = [...files]
    .sort((a, b) => cmp(a.path, b.path))
    .map((f) => `${sha256Hex(f.bytes)}  ${f.path}\n`);
  return { path: GENERATED.sums, bytes: utf8(lines.join("")) };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A ustar archive of `files` under `root/`, sorted by path. Every header has mode 0644, uid
 * and gid 0, EMPTY owner and group names, `mtime`, type `0` (regular file); there are no
 * directory, pax (`x`/`g`) or GNU (`L`/`K`) entries, so nothing beyond name, size and these
 * fixed fields can be stored. Ends with two zero blocks, padded to a 10240-byte record.
 */
export function ustarArchive(root: string, files: readonly BundleFile[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => cmp(a.path, b.path))) {
    const header = Buffer.alloc(512, 0);
    const [prefix, name] = splitName(`${root}/${f.path}`);
    header.write(name, 0, 100, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${f.bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write(`${Math.max(0, Math.floor(mtime)).toString(8).padStart(11, "0")}\0`, 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    // uname (265..296) and gname (297..328) stay zero: no owner names.
    header.write("0000000\0", 329, "ascii");
    header.write("0000000\0", 337, "ascii");
    header.write(prefix, 345, 155, "ascii");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(header, Buffer.from(f.bytes));
    const pad = (512 - (f.bytes.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const body = Buffer.concat(parts);
  const record = 10240;
  return Buffer.concat([body, Buffer.alloc((record - (body.length % record)) % record, 0)]);
}

/** Splits a path into ustar (prefix, name): name at most 100 bytes, prefix at most 155. */
function splitName(path: string): [string, string] {
  if (!/^[\x21-\x7e]+$/.test(path)) throw new ReleaseRefusal([`non-ASCII archive path`]);
  if (path.length <= 100) return ["", path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name.length <= 100 && prefix.length <= 155) return [prefix, name];
    if (name.length > 100) break;
  }
  throw new ReleaseRefusal([`archive path too long for ustar (${path.length} bytes)`]);
}

/** The release's own README: what it holds and how to reproduce the grader from it alone. */
export const RELEASE_README = `# Myco false-completion benchmark, ${RELEASE_TASK_SET}: release bundle

Built by \`scripts/benchmark-release-package.ts\` from the commit named in
\`release-manifest.json\` (\`sourceCommit\`). Apache-2.0 (\`LICENSE\`). There is no ranking
and no leaderboard here: this bundle holds the task set, the independent grader and the
grading protocol, and nothing it holds is a result.

| Path | What |
|---|---|
| \`benchmark/false-completion/${RELEASE_TASK_SET}/\` | The task set: tasks, fixtures, its own manifest and README |
| \`docs/benchmark/public/\` | The task-set card and the grading protocol |
| \`scripts/benchmark-grade.ts\`, \`src/benchmark/grade/\`, \`schemas/\` | The independent grader (Node built-ins only) |
| \`scripts/benchmark-verify-bundle.ts\` | Checks the task set against its manifest |
| \`reproduce-requests.jsonl\`, \`reproduce/\`, \`reproduce-expected.jsonl\` | Grader reproduction set: every task with the intent applied (pass) and untouched (fail), and one missing document per fault class (ungradable) |
| \`datasets/\` | Cleared datasets, when the release carries any |
| \`release-manifest.json\`, \`SHA256SUMS\` | SHA-256 of every file |

## Reproduce the grader from this bundle alone

Node 24 or later, nothing else: no clone, no \`node_modules\`, no network. From this directory:

\`\`\`sh
sha256sum -c SHA256SUMS
node scripts/benchmark-verify-bundle.ts benchmark/false-completion/${RELEASE_TASK_SET}
node scripts/benchmark-grade.ts reproduce-requests.jsonl > regraded.jsonl
cmp regraded.jsonl reproduce-expected.jsonl
\`\`\`

On macOS use \`shasum -a 256 -c SHA256SUMS\`. Each command exits 0 when the bundle is intact and
the grader reproduces. CI runs these on Linux against a freshly built archive, unpacked in an
empty directory (\`scripts/benchmark-release-repro.sh\`).
`;

export interface DatasetSource {
  readonly name: string;
  readonly dir: string;
}

export interface BuildOptions {
  readonly repoDir: string;
  readonly ref: string;
  /** Must not exist (or be an empty plain directory). */
  readonly outDir: string;
  readonly datasets?: readonly DatasetSource[];
  readonly scan?: ScanOptions;
}

export interface BuildResult {
  readonly commit: string;
  /** Archive file name inside `outDir`. */
  readonly archive: string;
  readonly archiveSha256: string;
  readonly fileCount: number;
  readonly datasets: readonly string[];
}

const TASK_BUNDLE = RELEASE_REPO_TREES[0] as string;

/**
 * Builds the release into `outDir`: the bundle tree `outDir/<RELEASE_ROOT>/`, the archive
 * `outDir/<RELEASE_ROOT>.tar` and its `.sha256`. Order: collect (allowlist and closure),
 * scan everything, write the tree, run the bundled verifier and grader from the tree with a
 * bare environment (the expected grade rows are the grader's own output, and each row's
 * status must be the one the construction guarantees), then write the manifest, the sums and
 * the archive. The archive is built from the bytes in memory, never re-read from disk.
 */
export function buildRelease(options: BuildOptions): BuildResult {
  const reader = gitReader(options.repoDir, options.ref);
  const repo = repoFiles(reader);
  const datasets = options.datasets ?? [];
  const names = datasets.map((d) => d.name);
  if (new Set(names).size !== names.length) throw new ReleaseRefusal(["duplicate dataset name"]);
  const datasetFiles = datasets.flatMap((d) => readDataset(d.name, d.dir));

  const taskManifest = repo.find((f) => f.path === `${TASK_BUNDLE}manifest.json`);
  const tasks = repo.find((f) => f.path === `${TASK_BUNDLE}tasks.jsonl`);
  if (taskManifest === undefined || tasks === undefined)
    throw new ReleaseRefusal([`${TASK_BUNDLE}: no manifest.json or tasks.jsonl`]);
  const graderVersion = String(
    (JSON.parse(new TextDecoder().decode(taskManifest.bytes)) as { graderVersion?: unknown })
      .graderVersion,
  );
  const cases = reproductionCases(
    new TextDecoder().decode(tasks.bytes),
    TASK_BUNDLE,
    new Map(repo.map((f) => [f.path, f.bytes])),
  );

  const generated: BundleFile[] = [
    {
      path: GENERATED.packageJson,
      bytes: utf8(
        `${JSON.stringify({ name: RELEASE_ROOT, private: true, type: "module", license: "Apache-2.0" }, null, 2)}\n`,
      ),
    },
    { path: GENERATED.readme, bytes: utf8(RELEASE_README) },
    {
      path: GENERATED.requests,
      bytes: utf8(cases.map((c) => `${JSON.stringify(c.request)}\n`).join("")),
    },
    ...cases.flatMap((c) =>
      c.document === null ? [] : [{ path: String(c.request.persistedFile), bytes: c.document }],
    ),
  ];
  const content = [...repo, ...datasetFiles, ...generated];
  const paths = content.map((f) => f.path);
  if (new Set(paths).size !== paths.length) throw new ReleaseRefusal(["duplicate bundle path"]);
  assertClean(content, options.scan);

  assertFreshOut(options.outDir);
  mkdirSync(options.outDir, { recursive: true });
  const tree = join(options.outDir, RELEASE_ROOT);
  mkdirSync(tree);
  const write = (f: BundleFile) =>
    writeFileSync(destinationInside(tree, f.path), f.bytes, { flag: "wx" });
  for (const f of content) write(f);

  // The bundled code, run from the tree alone: bare environment, the tree as cwd.
  const run = (args: string[]) =>
    execFileSync(process.execPath, args, {
      cwd: tree,
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  run(["scripts/benchmark-verify-bundle.ts", TASK_BUNDLE.replace(/\/$/, "")]);
  const regraded = run(["scripts/benchmark-grade.ts", GENERATED.requests]).toString("utf8");
  const rows = regraded
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { trialKey: string; status: string; graderVersion: string });
  const findings: string[] = [];
  if (rows.length !== cases.length)
    findings.push(`grader wrote ${rows.length} rows for ${cases.length} requests`);
  for (const [i, c] of cases.entries()) {
    const row = rows[i];
    if (row === undefined || row.trialKey !== c.request.trialKey || row.status !== c.expectStatus)
      findings.push(
        `${String(c.request.trialKey)}: grader gave ${row?.status} (construction: ${c.expectStatus})`,
      );
    else if (row.graderVersion !== graderVersion)
      findings.push(`${String(c.request.trialKey)}: grader version differs from the task set's`);
  }
  if (findings.length > 0) throw new ReleaseRefusal(findings);
  const expected: BundleFile = { path: GENERATED.expected, bytes: utf8(regraded) };

  const withExpected = [...content, expected];
  const manifest = releaseManifest(withExpected, {
    commit: reader.commit,
    graderVersion,
    datasets: names,
  });
  const sums = sha256Sums([...withExpected, manifest]);
  const all = [...withExpected, manifest, sums];
  assertClean([expected, manifest, sums], options.scan);
  for (const f of [expected, manifest, sums]) write(f);

  const archiveBytes = ustarArchive(RELEASE_ROOT, all, reader.time);
  const archive = `${RELEASE_ROOT}.tar`;
  const archiveSha256 = sha256Hex(archiveBytes);
  writeFileSync(join(options.outDir, archive), archiveBytes, { flag: "wx" });
  writeFileSync(join(options.outDir, `${archive}.sha256`), `${archiveSha256}  ${archive}\n`, {
    flag: "wx",
  });
  return { commit: reader.commit, archive, archiveSha256, fileCount: all.length, datasets: names };
}
