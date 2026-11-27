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
 * manifest file (`test_all.json`) lists in the chosen domains, minus the spec's exclusion list
 * (empty today; each entry needs a reason code decided before any run). There is no Myco
 * placement filter: under the lead's 13:55Z ruling every task runs in its benchmark's own
 * environment, so the apps a task needs and its getters only feed the requirements report.
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
  /** Domains imported whole, in this order. */
  readonly domains: readonly string[];
  /**
   * Listed task ids left out, each with a reason code. Decided before any run, from the task
   * files alone; never for difficulty or outcome. Empty for both subsets today.
   */
  readonly exclusions: Readonly<Record<string, string>>;
  /** The environment the benchmark's own harness runs every task in. */
  readonly environment: HarnessEnvironment;
  /** The selection rule, in words, copied into the manifest. */
  readonly selectionRule: string;
}

/**
 * Where a task runs under the lead's 13:55Z ruling: the benchmark's OWN environment, action
 * server and evaluator. There is no Myco placement any more (no namespace desktop, no HCU).
 */
export type HarnessEnvironment = "osworld-desktopenv" | "waa-windows-arena";

export const OSWORLD_OFFICE_V1: SubsetSpec = {
  taskSetVersion: "osworld-office-v1",
  benchmark: "osworld",
  examplesRoot: "evaluation_examples",
  metricsDir: "desktop_env/evaluators/metrics",
  metricsPackage: "desktop_env.evaluators.metrics",
  domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress"],
  exclusions: {},
  environment: "osworld-desktopenv",
  selectionRule:
    "Every task id listed in evaluation_examples/test_all.json at the pinned commit under libreoffice_calc, libreoffice_writer and libreoffice_impress, run in OSWorld's own DesktopEnv (its provider and in-VM controller). No task is dropped for difficulty, feasibility, evaluator type, the apps it needs or the getters its evaluator uses; the exclusion list is empty and any entry must be decided before any run, with a reason code, never for difficulty or outcome.",
};

/** Phase 2 (deferred, not dropped): imported for the record, not pre-registered. */
export const WAA_OFFICE_V1: SubsetSpec = {
  taskSetVersion: "waa-office-v1",
  benchmark: "waa",
  examplesRoot: "src/win-arena-container/client/evaluation_examples_windows",
  metricsDir: "src/win-arena-container/client/desktop_env/evaluators/metrics",
  metricsPackage: "desktop_env.evaluators.metrics",
  domains: ["libreoffice_calc", "libreoffice_writer", "notepad", "file_explorer"],
  exclusions: {},
  environment: "waa-windows-arena",
  selectionRule:
    "Every task id listed in evaluation_examples_windows/test_all.json under libreoffice_calc, libreoffice_writer, notepad and file_explorer (WAA's office apps are LibreOffice on Windows; it has no Microsoft Office tasks), run in WAA's own Windows 11 image, in-VM server and evaluators. No task is dropped for difficulty, feasibility or evaluator type. Phase 2: deferred, not dropped.",
};

/**
 * What a task needs from its benchmark's own harness, as codes. Informational: none of these
 * selects or drops a task. `docs/benchmark/upstream/requirements.md` explains each code.
 */
export interface TaskRequirements {
  readonly environment: HarnessEnvironment;
  /** Upstream getter types the evaluator calls (result and expected), sorted, unique. */
  readonly getters: readonly string[];
  /** Upstream config (setup) step types, sorted, unique. */
  readonly setup: readonly string[];
  /** Upstream postconfig step types, run by the upstream evaluate path, sorted, unique. */
  readonly postconfig: readonly string[];
  /** Sorted codes. */
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
  readonly requirements: TaskRequirements;
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
    /** Tasks whose evaluator is upstream's `infeasible` (graded on the agent's FAIL action). */
    readonly infeasible: number;
    /** Listed ids left out by `exclusions` (always 0 today). */
    readonly excluded: number;
  };
  readonly environment: HarnessEnvironment;
  /** Listed ids left out, with reason codes (see SubsetSpec.exclusions). */
  readonly exclusions: Readonly<Record<string, string>>;
  /** Every evaluator file any task needs, path -> SHA-256 at the pin. */
  readonly evaluatorFiles: Readonly<Record<string, string>>;
  /** SHA-256 of the rendered `tasks.jsonl`. */
  readonly tasksSha256: string;
}

export class ImportError extends Error {}

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Getters that read a constant from the task file (no guest, no download). */
const CONSTANT_GETTERS = new Set(["rule", "rules", "rule_relativeTime"]);

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

const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

function stepTypes(v: unknown): string[] {
  return asList(v as unknown[]).map((s) => {
    const type = s && typeof s === "object" ? (s as Record<string, unknown>).type : undefined;
    return typeof type === "string" ? type : "(none)";
  });
}

/**
 * What the task needs from its benchmark's own harness. Informational only: it never selects
 * or drops a task (the ruling: OSWorld's image has the apps, its controller serves the getters
 * and its evaluate path runs the postconfig).
 */
function requirementsOf(spec: SubsetSpec, task: Record<string, unknown>): TaskRequirements {
  const ev = (task.evaluator ?? {}) as Record<string, unknown>;
  const getters = uniqSorted(
    [...getterTypes(ev.result), ...getterTypes(ev.expected)].filter((g) => g !== "(none)"),
  );
  const setup = uniqSorted(stepTypes(task.config));
  const postconfig = uniqSorted(stepTypes(ev.postconfig));
  const needs = new Set<string>();
  if (setup.includes("download")) needs.add("SEED_ASSETS_LICENSE_UNCLEAR");
  if (getters.includes("cloud_file")) needs.add("GOLD_ASSETS_LICENSE_UNCLEAR");
  if (postconfig.length > 0) needs.add("POSTCONFIG_RUN_BY_UPSTREAM_EVALUATE");
  if (getters.some((g) => !CONSTANT_GETTERS.has(g) && g !== "cloud_file"))
    needs.add("GETTERS_SERVED_BY_UPSTREAM_CONTROLLER");
  if (task.proxy === true) needs.add("NETWORK_PROXY");
  if (asList(ev.func as string | string[]).includes("infeasible"))
    needs.add("INFEASIBLE_TASK_GRADED_ON_AGENT_FAIL_ACTION");
  return {
    environment: spec.environment,
    getters,
    setup,
    postconfig,
    needs: [...needs].sort(),
  };
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
  let excluded = 0;
  const listedIds = new Set<string>();
  for (const domain of spec.domains) {
    const ids = listed[domain];
    if (!Array.isArray(ids)) throw new ImportError(`DOMAIN_NOT_LISTED ${domain}`);
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
      if (listedIds.has(id)) throw new ImportError(`DUPLICATE_TASK_ID ${id}`);
      listedIds.add(id);
      if (Object.hasOwn(spec.exclusions, id)) {
        excluded += 1;
        continue;
      }

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
        requirements: requirementsOf(spec, task),
      });
    }
  }

  for (const id of Object.keys(spec.exclusions))
    if (!listedIds.has(id)) throw new ImportError(`EXCLUSION_NOT_LISTED ${id}`);
  const tasksJsonl = `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`;
  const perDomain: Record<string, number> = {};
  let infeasible = 0;
  for (const t of tasks) {
    perDomain[t.domain] = (perDomain[t.domain] ?? 0) + 1;
    if (t.evaluator.funcs.includes("infeasible")) infeasible += 1;
  }
  const manifest: UpstreamManifest = {
    schema: UPSTREAM_MANIFEST_SCHEMA,
    taskSetVersion: spec.taskSetVersion,
    upstream: pin,
    selectionRule: spec.selectionRule,
    metricsDir: spec.metricsDir,
    metricsPackage: spec.metricsPackage,
    counts: { total: tasks.length, perDomain, infeasible, excluded },
    environment: spec.environment,
    exclusions: spec.exclusions,
    evaluatorFiles: Object.fromEntries([...evaluatorFiles].sort(([a], [b]) => (a < b ? -1 : 1))),
    tasksSha256: sha256Hex(tasksJsonl),
  };
  return { manifest, tasks, tasksJsonl };
}
