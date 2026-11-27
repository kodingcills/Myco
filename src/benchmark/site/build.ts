/**
 * Benchmark site (workstream 3, track G): build the static site from the benchmark package.
 *
 *  - pages: overview (`docs/benchmark/public/README.md`), the fc-v1 task set (its card plus every
 *    task, read from the SHA-256-pinned `tasks.jsonl`), the grading protocol, the grader (version
 *    and module digests) and the results table (`results.ts`: verified, recomputed packs only);
 *  - `SHA256SUMS` over every page (`sha256sum -c` format);
 *  - a leak scan over every output line before anything is written: the dataset leak scan
 *    (`src/dataset/hygiene.ts` `leaksIn`: host paths, this machine's user and host names, the
 *    canary, secret-shaped strings) and the `src/export-guard` identity rule (`heldEntries`) over
 *    the strings of an optional identity file. A finding names the file, line and kind, never the
 *    matched text, and refuses the build.
 *
 * Deterministic: the same repository content gives byte-identical output (no clock, no host
 * data, sorted inputs). Nothing is published or deployed: the CLI writes a local directory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type HostIdentity, leaksIn } from "../../dataset/hygiene.ts";
import {
  heldEntries,
  IDENTITY_WORD_MIN_CHARS,
  type IdentityPair,
} from "../../export-guard/identity-words.ts";
import { GRADER_VERSION } from "../grade/grade.ts";
import { publishedTasks } from "../published-tasks.ts";
import { TASK_SET_VERSION } from "../task-types.ts";
import { renderMarkdown } from "./markdown.ts";
import { docPage, graderPage, resultsPage, taskSetPage } from "./render.ts";
import { type CommittedCheck, verifyResultsRoot } from "./results.ts";

export const PUBLIC_DOCS = "docs/benchmark/public";
export const RESULTS_ROOT = "benchmark/false-completion/results";

/** Public-doc links the site maps to its own pages; any other link renders as text. */
const LINKS: Readonly<Record<string, string>> = {
  "README.md": "index.html",
  "task-set-card.md": "task-set.html",
  "grading-protocol.md": "protocol.html",
};
const resolveLink = (href: string): string | null => {
  const [path, hash] = href.split("#", 2);
  if (path === "" && hash !== undefined) return `#${hash}`;
  const to = path === undefined ? undefined : LINKS[path];
  if (to === undefined) return null;
  return hash === undefined ? to : `${to}#${hash}`;
};

export interface BuildOptions {
  readonly repoRoot: string;
  /** Result packs; default `<repoRoot>/benchmark/false-completion/results`. */
  readonly resultsRoot?: string;
  readonly isCommitted: CommittedCheck;
  /** Tests only. */
  readonly allowTestFixture?: boolean;
  /** Identity strings (one per line, `#` comments) that must not appear in the output. */
  readonly identityFile?: string;
  /** The machine identity to scan for instead of this machine's (tests). */
  readonly identity?: HostIdentity;
}

export class SiteBuildRefused extends Error {
  constructor(readonly findings: readonly string[]) {
    super(`site build refused: ${findings.join("; ")}`);
    this.name = "SiteBuildRefused";
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function filesUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => `${dir}/${d.name}`)
    .sort();
}

function identityEntries(file: string | undefined): IdentityPair[] {
  if (file === undefined) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= IDENTITY_WORD_MIN_CHARS && !l.startsWith("#"))
    .map((l) => ["identity", l] as const);
}

/** Leak findings over the site's files: `file:line:kind`, never the matched text. */
export function scanSite(
  files: ReadonlyMap<string, string>,
  opts: Pick<BuildOptions, "identityFile" | "identity"> = {},
): string[] {
  const entries = identityEntries(opts.identityFile);
  const findings: string[] = [];
  for (const [name, text] of files)
    text.split("\n").forEach((line, i) => {
      const kinds = new Set<string>(
        leaksIn(line, opts.identity === undefined ? {} : { identity: opts.identity }),
      );
      if (heldEntries(line, entries, IDENTITY_WORD_MIN_CHARS).length > 0) kinds.add("identity");
      for (const k of kinds) findings.push(`${name}:${i + 1}:${k}`);
    });
  return findings;
}

/** Build every file of the site in memory. Throws on a refused pack or a leak finding. */
export function buildSite(opts: BuildOptions): Map<string, string> {
  const root = opts.repoRoot;
  const doc = (name: string) =>
    renderMarkdown(readFileSync(join(root, PUBLIC_DOCS, name), "utf8"), resolveLink);
  const tasks = publishedTasks(TASK_SET_VERSION, root);
  if (tasks === undefined) throw new Error(`task set ${TASK_SET_VERSION} is not published`);
  const results = verifyResultsRoot(opts.resultsRoot ?? join(root, RESULTS_ROOT), {
    isCommitted: opts.isCommitted,
    ...(opts.allowTestFixture === true ? { allowTestFixture: true } : {}),
  });
  const graderFiles = [
    ...filesUnder(root, "src/benchmark/grade"),
    "scripts/benchmark-grade.ts",
    "scripts/benchmark-verify-bundle.ts",
  ];
  const files = new Map<string, string>([
    ["index.html", docPage("index.html", doc("README.md"))],
    ["task-set.html", taskSetPage(doc("task-set-card.md"), TASK_SET_VERSION, tasks)],
    ["protocol.html", docPage("protocol.html", doc("grading-protocol.md"))],
    [
      "grader.html",
      graderPage(
        GRADER_VERSION,
        graderFiles.map((p) => ({ path: p, sha256: sha256(readFileSync(join(root, p))) })),
      ),
    ],
    ["results.html", resultsPage(results)],
  ]);
  const sums = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, text]) => `${sha256(text)}  ${name}\n`)
    .join("");
  files.set("SHA256SUMS", sums);
  const findings = scanSite(files, opts);
  if (findings.length > 0) throw new SiteBuildRefused(findings);
  return files;
}

/** Write a built site into `out`, which must not exist or be empty. */
export function writeSite(out: string, files: ReadonlyMap<string, string>): void {
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error("refused: the output directory is not empty");
  mkdirSync(out, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(out, name), text);
}

/**
 * The committed check for a git checkout: a file counts only when it is the blob recorded at
 * HEAD and the working-tree bytes hash to that blob (so an uncommitted, staged or edited file
 * is refused). One `git ls-tree` call, made on first use.
 */
export function gitCommittedCheck(repoRoot: string): CommittedCheck {
  let blobs: Map<string, string> | null = null;
  const load = () => {
    const r = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const map = new Map<string, string>();
    if (r.status === 0)
      for (const entry of r.stdout.split("\0")) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
        if (m?.[1] !== undefined && m[2] !== undefined) map.set(m[2], m[1]);
      }
    return map;
  };
  return (absPath: string) => {
    blobs ??= load();
    const rel = relative(repoRoot, absPath).split(sep).join("/");
    const id = blobs.get(rel);
    if (id === undefined) return false;
    const bytes = readFileSync(absPath);
    const algo = id.length === 64 ? "sha256" : "sha1";
    const ours = createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return ours === id;
  };
}
