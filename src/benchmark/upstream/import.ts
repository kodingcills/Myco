/**
 * Public-benchmark importer (#675, #682): builds Myco task sets from the pinned upstream
 * OSWorld and WindowsAgentArena (WAA) checkouts, using their own task definitions and their
 * own evaluator code as ground truth.
 *
 * What it keeps verbatim: the upstream task id (Myco's `taskId` IS the upstream id), the
 * instruction string, the domain, and the raw bytes of each task file (pinned by SHA-256 in
 * the manifest). Nothing here rewrites a task or an evaluator: the manifest records where
 * each evaluator function lives at the pinned commit and the SHA-256 of every evaluator file
 * it needs, so the grader (`./evaluate.ts`) refuses to run an evaluator whose bytes moved.
 *
 * What it does not do: fetch or vendor per-task file assets. Their licensing is unclear
 * (docs/benchmark/upstream/README.md §1); each asset URL is recorded with
 * `license: "unclear"` and nothing downloads it.
 *
 * Selection rule (stated before any results, no difficulty filter): every task the upstream
 * manifest file (`test_all.json`) lists in the chosen domains; for OSWorld's `multi_apps`,
 * every listed task whose `related_apps` names a LibreOffice app. Nothing else is dropped.
 *
 * Pure: reads through a `UpstreamReader`, so tests run it on a synthetic tree. It imports
 * nothing from the gate, the grader or the task generators.
 */
import { createHash } from "node:crypto";

export const UPSTREAM_TASK_SCHEMA = "myco.upstream.task/1";
export const UPSTREAM_MANIFEST_SCHEMA = "myco.upstream.taskset/1";

export interface UpstreamReader {
  /** Bytes of a file, path relative to the checkout root (posix separators). */
  readFile(rel: string): Uint8Array;
  /** Names (not paths) of the entries in a directory relative to the checkout root. */
  listDir(rel: string): string[];
  exists(rel: string): boolean;
}

export interface UpstreamPin {
  readonly name: "OSWorld" | "WindowsAgentArena";
  readonly repo: string;
  readonly commit: string;
  readonly license: string;
  /** Path of the license file in the checkout, and its SHA-256 at the pin. */
  readonly licenseFile: string;
  readonly licenseSha256: string;
}

export interface SubsetSpec {
  readonly taskSetVersion: string;
  readonly benchmark: "osworld" | "waa";
  /** Directory holding `test_all.json` and `examples/<domain>/`, relative to the root. */
  readonly examplesRoot: string;
  /** Directory holding the evaluator metric modules, relative to the root. */
  readonly metricsDir: string;
  /** Python package the metric modules import each other through. */
  readonly metricsPackage: string;
  /** Domains imported whole. */
  readonly domains: readonly string[];
  /** Domains imported only for tasks that name a LibreOffice app. */
  readonly officeFilteredDomains: readonly string[];
  /** The selection rule, in words, copied into the manifest. */
  readonly selectionRule: string;
}

export const OSWORLD_OFFICE_V1: SubsetSpec = {
  taskSetVersion: "osworld-office-v1",
  benchmark: "osworld",
  examplesRoot: "evaluation_examples",
  metricsDir: "desktop_env/evaluators/metrics",
  metricsPackage: "desktop_env.evaluators.metrics",
  domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress"],
  officeFilteredDomains: ["multi_apps"],
  selectionRule:
    "Every task id listed in evaluation_examples/test_all.json under libreoffice_calc, libreoffice_writer and libreoffice_impress, plus every multi_apps task listed there whose related_apps names a LibreOffice app (calc, writer or impress). No task is dropped for difficulty, feasibility, evaluator type or placement.",
};

export const WAA_OFFICE_V1: SubsetSpec = {
  taskSetVersion: "waa-office-v1",
  benchmark: "waa",
  examplesRoot: "src/win-arena-container/client/evaluation_examples_windows",
  metricsDir: "src/win-arena-container/client/desktop_env/evaluators/metrics",
  metricsPackage: "desktop_env.evaluators.metrics",
  domains: ["libreoffice_calc", "libreoffice_writer", "notepad", "file_explorer"],
  officeFilteredDomains: [],
  selectionRule:
    "Every task id listed in evaluation_examples_windows/test_all.json under libreoffice_calc, libreoffice_writer, notepad and file_explorer (WAA's office apps are LibreOffice on Windows; it has no Microsoft Office tasks). No task is dropped for difficulty, feasibility, evaluator type or placement.",
};

export type PlacementTarget =
  | "linux-namespace-desktop"
  | "linux-needs-other-app"
  | "linux-needs-guest-probe"
  | "windows-vm";

export interface Placement {
  readonly target: PlacementTarget;
  /** Codes, sorted; `docs/benchmark/upstream/placement.md` explains each. */
  readonly reasons: readonly string[];
  /** What the run harness must provide on top of the desktop, sorted codes. */
  readonly needs: readonly string[];
}

export interface UpstreamAsset {
  readonly role: "config" | "expected";
  readonly url: string;
  readonly license: "unclear";
}

export interface UpstreamTask {
  readonly schema: typeof UPSTREAM_TASK_SCHEMA;
  readonly taskSetVersion: string;
  /** The upstream id, verbatim. */
  readonly taskId: string;
  /** The task file's own `id` field, verbatim, present only when its spelling differs. */
  readonly idField?: string;
  readonly benchmark: "osworld" | "waa";
  readonly domain: string;
  /** The upstream instruction, verbatim. */
  readonly instruction: string;
  readonly relatedApps: readonly string[];
  /** Task file path in the checkout and the SHA-256 of its raw bytes at the pin. */
  readonly taskFile: string;
  readonly taskFileSha256: string;
  readonly evaluator: {
    /** Upstream metric function names in order (`infeasible` is upstream's special case). */
    readonly funcs: readonly string[];
    readonly conj: "and" | "or";
    /** Metric files the functions are defined in, plus their in-package imports. */
    readonly files: readonly string[];
    /** Metric module (file stem under the metrics dir) per function; "" for infeasible. */
    readonly modules: readonly string[];
    readonly resultTypes: readonly string[];
    readonly expectedTypes: readonly string[];
  };
  readonly assets: readonly UpstreamAsset[];
  readonly placement: Placement;
}

export interface UpstreamManifest {
  readonly schema: typeof UPSTREAM_MANIFEST_SCHEMA;
  readonly taskSetVersion: string;
  readonly upstream: UpstreamPin;
  readonly selectionRule: string;
  /** Metric modules directory and the Python package they import each other through. */
  readonly metricsDir: string;
  readonly metricsPackage: string;
  readonly counts: {
    readonly total: number;
    readonly perDomain: Readonly<Record<string, number>>;
    readonly perPlacement: Readonly<Record<string, number>>;
  };
  /** Every evaluator file any task needs, path -> SHA-256 at the pin. */
  readonly evaluatorFiles: Readonly<Record<string, string>>;
  /** SHA-256 of the rendered `tasks.jsonl`. */
  readonly tasksSha256: string;
}

export class ImportError extends Error {}

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const decoder = new TextDecoder("utf-8", { fatal: true });

const LIBREOFFICE = /libreoffice|\bcalc\b|writer|impress/;
const normalizeApp = (a: string) =>
  a
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
const isOfficeApp = (a: string) => LIBREOFFICE.test(normalizeApp(a));

/** Apps the Linux namespace desktop provides (src/desktops REGISTERED_APPS: LibreOffice only). */
const LINUX_DESKTOP_APPS =
  /^(libreoffice( (calc|writer|impress))?|calc|writer|impress|os|terminal)$/;

/** Getters that read a captured file or a constant: gradable on the host from captured bytes. */
const FILE_GETTERS = new Set([
  "vm_file",
  "cloud_file",
  "local_file",
  "rule",
  "rules",
  "rule_relativeTime",
]);

function asList<T>(v: T | readonly T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? [...(v as T[])] : [v as T];
}

function getterTypes(v: unknown): string[] {
  return asList(v as Record<string, unknown> | Record<string, unknown>[]).map((g) => {
    const type = g && typeof g === "object" ? (g as Record<string, unknown>).type : undefined;
    return typeof type === "string" ? type : "(none)";
  });
}

/** Collect every URL a task downloads or compares against. */
function assetsOf(task: Record<string, unknown>): UpstreamAsset[] {
  const out: UpstreamAsset[] = [];
  for (const step of asList(task.config as Record<string, unknown>[])) {
    if (step?.type !== "download") continue;
    const params = step.parameters as { files?: { url?: unknown }[] } | undefined;
    for (const f of params?.files ?? [])
      if (typeof f.url === "string") out.push({ role: "config", url: f.url, license: "unclear" });
  }
  const ev = (task.evaluator ?? {}) as Record<string, unknown>;
  for (const g of asList(ev.expected as Record<string, unknown>[])) {
    if (g?.type === "cloud_file")
      for (const p of asList(g.path as string | string[]))
        if (typeof p === "string") out.push({ role: "expected", url: p, license: "unclear" });
  }
  return out;
}

/** Map metric function name -> defining module file, by scanning `def name(` at top level. */
function indexMetrics(reader: UpstreamReader, metricsDir: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const name of reader.listDir(metricsDir).sort()) {
    if (!name.endsWith(".py") || name === "__init__.py") continue;
    const rel = `${metricsDir}/${name}`;
    const text = decoder.decode(reader.readFile(rel));
    for (const m of text.matchAll(/^def ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
      const fn = m[1] as string;
      if (!index.has(fn)) index.set(fn, rel);
    }
  }
  return index;
}

/** A metric file plus every sibling module it imports through the metrics package. */
function metricClosure(
  reader: UpstreamReader,
  spec: SubsetSpec,
  file: string,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = decoder.decode(reader.readFile(file));
  const pkg = spec.metricsPackage.replace(/\./g, "\\.");
  const re = new RegExp(`^\\s*from\\s+(?:${pkg}\\.|\\.)([A-Za-z_][A-Za-z0-9_]*)\\s+import`, "gm");
  for (const m of text.matchAll(re)) {
    const dep = `${spec.metricsDir}/${m[1]}.py`;
    if (reader.exists(dep)) metricClosure(reader, spec, dep, seen);
  }
  return seen;
}

function place(spec: SubsetSpec, task: Record<string, unknown>, apps: string[]): Placement {
  const ev = (task.evaluator ?? {}) as Record<string, unknown>;
  const getters = [...getterTypes(ev.result), ...getterTypes(ev.expected)];
  const reasons = new Set<string>();
  const needs = new Set<string>();
  const funcs = asList(ev.func as string | string[]);
  if (asList(task.config as unknown[]).some((s) => (s as { type?: string })?.type === "download"))
    needs.add("SEED_ASSETS_LICENSE_UNCLEAR");
  if (asList(ev.postconfig as unknown[]).length > 0) needs.add("POSTCONFIG_EXECUTOR");
  if (task.proxy === true) needs.add("NETWORK_PROXY");
  if (funcs.includes("infeasible")) reasons.add("INFEASIBLE_TASK_GRADED_ON_AGENT_FAIL_ACTION");

  if (spec.benchmark === "waa") {
    reasons.add("WAA_WINDOWS_IMAGE");
    if (JSON.stringify(task).includes("C:\\\\")) reasons.add("WINDOWS_PATHS");
    const domain = String(task.snapshot ?? "");
    if (domain === "notepad" || domain === "file_explorer") reasons.add("WINDOWS_ONLY_APP");
    return { target: "windows-vm", reasons: [...reasons].sort(), needs: [...needs].sort() };
  }

  const otherApps = apps.map(normalizeApp).filter((a) => !LINUX_DESKTOP_APPS.test(a));
  const probes = getters.filter((g) => !FILE_GETTERS.has(g) && g !== "(none)");
  let target: PlacementTarget = "linux-namespace-desktop";
  if (otherApps.length > 0) {
    target = "linux-needs-other-app";
    for (const a of otherApps) reasons.add(`APP_NOT_ON_DESKTOP:${a.replace(/\s+/g, "_")}`);
  } else if (probes.length > 0) {
    target = "linux-needs-guest-probe";
    for (const g of probes) reasons.add(`GUEST_PROBE_GETTER:${g}`);
  } else {
    reasons.add("LIBREOFFICE_ONLY_FILE_GRADED");
  }
  return { target, reasons: [...reasons].sort(), needs: [...needs].sort() };
}

function readJson(reader: UpstreamReader, rel: string): unknown {
  try {
    return JSON.parse(decoder.decode(reader.readFile(rel)));
  } catch {
    throw new ImportError(`UNREADABLE_JSON ${rel}`);
  }
}

export function importSubset(
  reader: UpstreamReader,
  spec: SubsetSpec,
  pin: UpstreamPin,
): { manifest: UpstreamManifest; tasks: UpstreamTask[]; tasksJsonl: string } {
  if (sha256Hex(reader.readFile(pin.licenseFile)) !== pin.licenseSha256)
    throw new ImportError("LICENSE_CHANGED");
  const listed = readJson(reader, `${spec.examplesRoot}/test_all.json`) as Record<string, unknown>;
  const metricIndex = indexMetrics(reader, spec.metricsDir);
  const tasks: UpstreamTask[] = [];
  const evaluatorFiles = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const domain of [...spec.domains, ...spec.officeFilteredDomains]) {
    const ids = listed[domain];
    if (!Array.isArray(ids)) throw new ImportError(`DOMAIN_NOT_LISTED ${domain}`);
    const filtered = spec.officeFilteredDomains.includes(domain);
    for (const id of ids) {
      if (typeof id !== "string" || !/^[A-Za-z0-9-]+$/.test(id))
        throw new ImportError(`BAD_TASK_ID ${domain}`);
      const taskFile = `${spec.examplesRoot}/examples/${domain}/${id}.json`;
      if (!reader.exists(taskFile)) throw new ImportError(`TASK_FILE_MISSING ${taskFile}`);
      const raw = reader.readFile(taskFile);
      const task = readJson(reader, taskFile) as Record<string, unknown>;
      // Upstream quirk (WAA @ pin): two task files spell the `-WOS` suffix `-wos` inside the
      // file. The id the upstream runner selects by is the listed one (file name and
      // test_all.json); the in-file spelling is kept verbatim as `idField`.
      if (typeof task.id !== "string" || task.id.toLowerCase() !== id.toLowerCase())
        throw new ImportError(`TASK_ID_MISMATCH ${taskFile}`);
      if (typeof task.instruction !== "string") throw new ImportError(`NO_INSTRUCTION ${taskFile}`);
      const apps = asList(task.related_apps as string[]).filter(
        (a): a is string => typeof a === "string",
      );
      if (filtered && !apps.some(isOfficeApp)) continue;
      if (seenIds.has(id)) throw new ImportError(`DUPLICATE_TASK_ID ${id}`);
      seenIds.add(id);

      const ev = (task.evaluator ?? {}) as Record<string, unknown>;
      const funcs = asList(ev.func as string | string[]);
      if (funcs.length === 0 || funcs.some((f) => typeof f !== "string"))
        throw new ImportError(`NO_EVALUATOR_FUNC ${taskFile}`);
      const files = new Set<string>();
      const modules: string[] = [];
      for (const fn of funcs) {
        if (fn === "infeasible") {
          modules.push("");
          continue;
        }
        const file = metricIndex.get(fn);
        if (file === undefined) throw new ImportError(`EVALUATOR_FUNC_NOT_FOUND ${fn}`);
        modules.push(file.slice(spec.metricsDir.length + 1, -".py".length));
        for (const f of metricClosure(reader, spec, file)) files.add(f);
      }
      for (const f of files) evaluatorFiles.set(f, sha256Hex(reader.readFile(f)));
      const conj = ev.conj === "or" ? "or" : "and";

      tasks.push({
        schema: UPSTREAM_TASK_SCHEMA,
        taskSetVersion: spec.taskSetVersion,
        taskId: id,
        ...(task.id !== id ? { idField: task.id } : {}),
        benchmark: spec.benchmark,
        domain,
        instruction: task.instruction,
        relatedApps: apps,
        taskFile,
        taskFileSha256: sha256Hex(raw),
        evaluator: {
          funcs,
          modules,
          conj,
          files: [...files].sort(),
          resultTypes: getterTypes(ev.result),
          expectedTypes: getterTypes(ev.expected),
        },
        assets: assetsOf(task),
        placement: place(spec, task, apps),
      });
    }
  }

  const tasksJsonl = `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`;
  const perDomain: Record<string, number> = {};
  const perPlacement: Record<string, number> = {};
  for (const t of tasks) {
    perDomain[t.domain] = (perDomain[t.domain] ?? 0) + 1;
    perPlacement[t.placement.target] = (perPlacement[t.placement.target] ?? 0) + 1;
  }
  const manifest: UpstreamManifest = {
    schema: UPSTREAM_MANIFEST_SCHEMA,
    taskSetVersion: spec.taskSetVersion,
    upstream: pin,
    selectionRule: spec.selectionRule,
    metricsDir: spec.metricsDir,
    metricsPackage: spec.metricsPackage,
    counts: { total: tasks.length, perDomain, perPlacement },
    evaluatorFiles: Object.fromEntries([...evaluatorFiles].sort(([a], [b]) => (a < b ? -1 : 1))),
    tasksSha256: sha256Hex(tasksJsonl),
  };
  return { manifest, tasks, tasksJsonl };
}
