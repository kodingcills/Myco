/**
 * The routing lint (TIF-98, part 2): every module that writes OUTWARD-BOUND dataset, episode
 * or bundle output must route through `src/leak-guard/serialize.ts` and make no raw fs write
 * of its own. Parsed with the TypeScript compiler API (an AST check, not a grep), so an
 * aliased import (`writeFileSync as w`), a namespace import (`fs.writeFileSync`) or a
 * `node:fs/promises` write is still a raw write.
 *
 * A module is an outward writer when it makes a raw fs write AND any of:
 *   (a) it lives in an outward area: `src/dataset/`, `src/proof/`, `src/bundle/`, or its file
 *       name says export/bundle (`src/episode/export.ts`);
 *   (b) it defines a function named `export*`, `bundle*` or `publish*` (`exportRun`);
 *   (c) it names an outward artifact file in a string literal (`bundle.json`,
 *       `records.jsonl`, `dataset*.json[l]`). `manifest.json` is not one: local run dirs,
 *       the episode store and grader runs all write one, and none of them leave the machine.
 *
 * `PENDING` lists the writers that do not route yet, each with its TO FILE switch-over; an
 * entry that no longer needs to be there (routed, or not a writer any more) fails as stale,
 * so the list only shrinks. Entries for files not yet on main (`expected`) pre-register an
 * open PR's writer so its merge does not turn main red.
 */
import { readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import ts from "typescript";

export const HELPER = "src/leak-guard/serialize.ts";

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const WRITE_APIS = new Set([
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "createWriteStream",
  "copyFileSync",
  "copyFile",
  "cpSync",
  "cp",
  "renameSync",
  "rename",
  "linkSync",
  "symlinkSync",
]);
const OUTWARD_AREA = /^src\/(?:dataset|proof|bundle)\//;
const OUTWARD_NAME = /(?:^|[-_.])(?:export|bundle)s?(?:[-_.]|$)/i;
const OUTWARD_FN = /^(?:export|bundle|publish)(?:[A-Z_]|$)/;
const OUTWARD_FILE = /^(?:bundle\.json|records\.jsonl|dataset[\w.-]*\.jsonl?)$/;

export interface ModuleFacts {
  readonly file: string;
  readonly rawWrites: number;
  readonly importsHelper: boolean;
  readonly reasons: readonly string[];
}

/** AST facts for one module. `file` is repo-relative with `/`. */
export function analyse(file: string, source: string): ModuleFacts {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Set<string>(); // local names bound to an fs write API
  const namespaces = new Set<string>(); // local names bound to the fs module
  let importsHelper = false;
  const reasons: string[] = [];
  if (OUTWARD_AREA.test(file)) reasons.push("area");
  if (OUTWARD_NAME.test(basename(file, ".ts"))) reasons.push("name");

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (target === HELPER) importsHelper = true;
    }
    if (!FS_MODULES.has(spec)) continue;
    const clause = st.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) namespaces.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
    if (nb !== undefined && ts.isNamedImports(nb))
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (WRITE_APIS.has(imported)) named.add(el.name.text);
      }
  }

  let rawWrites = 0;
  const visit = (node: ts.Node, inOutwardFn: boolean) => {
    let here = inOutwardFn;
    const fnName =
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        ? node.name?.getText(sf)
        : ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? node.name.getText(sf)
          : undefined;
    if (fnName !== undefined && OUTWARD_FN.test(fnName)) here = true;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRaw =
        (ts.isIdentifier(callee) && named.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          WRITE_APIS.has(callee.name.text) &&
          ((ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)) ||
            (ts.isPropertyAccessExpression(callee.expression) &&
              callee.expression.name.text === "promises" &&
              ts.isIdentifier(callee.expression.expression) &&
              namespaces.has(callee.expression.expression.text))));
      if (isRaw) {
        rawWrites++;
        if (here) reasons.push("function");
      }
    }
    if (ts.isStringLiteralLike(node) && OUTWARD_FILE.test(node.text)) reasons.push("artifact");
    ts.forEachChild(node, (c) => visit(c, here));
  };
  visit(sf, false);
  return { file, rawWrites, importsHelper, reasons: [...new Set(reasons)] };
}

export const isOutwardWriter = (m: ModuleFacts) =>
  m.file !== HELPER && m.rawWrites > 0 && m.reasons.length > 0;
export const isRouted = (m: ModuleFacts) => m.importsHelper && m.rawWrites === 0;

export interface Pending {
  /** The TO FILE switch-over (the PR or follow-up that moves it onto the helper). */
  readonly toFile: string;
  /** Set when the file is not on main yet (an open PR adds it). */
  readonly expected?: string;
}

/**
 * Outward writers that do not route through the helper yet. Do not add a NEW writer here:
 * route it through `src/leak-guard/serialize.ts`. Each entry is a TO FILE on TIF-98.
 */
export const PENDING: Readonly<Record<string, Pending>> = {
  "src/episode/export.ts": {
    toFile:
      "#556 closes the episode export (src/episode/closed.ts); once merged, port FIELD_TREATMENT to a ClosedSchema and write through writeOutward/writeOutwardBlob",
  },
  "src/dataset/export.ts": {
    toFile:
      "#559 closes track U's dataset export (src/dataset/closed.ts); once merged, write records/manifest/episodes through writeOutward",
  },
  "src/proof/cli.ts": {
    toFile:
      "#553 Q3 replayable proof bundle (src/proof/closed.ts); once merged, write bundles through writeOutward",
    expected: "#553",
  },
  "src/pilot/runner.ts": {
    toFile:
      "exportRun writes arm.jsonl / faulted-attempts.jsonl / docs/*.csv raw; route through a ClosedSchema for BenchmarkArmRow",
  },
  "src/foundry/hidden-split/evidence.ts": {
    toFile:
      "collectEvidence writes bundle.json / screen.json / trace.jsonl raw (Tier 2 hidden split); route through a ClosedSchema",
  },
};

export interface RoutingProblem {
  readonly file: string;
  readonly problem: "unrouted" | "stale-pending";
}

export function routingProblems(
  modules: readonly ModuleFacts[],
  pending: Readonly<Record<string, Pending>> = PENDING,
): RoutingProblem[] {
  const out: RoutingProblem[] = [];
  const byFile = new Map(modules.map((m) => [m.file, m]));
  for (const m of modules)
    if (isOutwardWriter(m) && !isRouted(m) && !(m.file in pending))
      out.push({ file: m.file, problem: "unrouted" });
  for (const [file, p] of Object.entries(pending)) {
    const m = byFile.get(file);
    if (m === undefined) {
      if (p.expected === undefined) out.push({ file, problem: "stale-pending" });
      continue;
    }
    if (!isOutwardWriter(m) || isRouted(m)) out.push({ file, problem: "stale-pending" });
  }
  return out;
}

/** Every `src/**\/*.ts` module, analysed. */
export function analyseTree(repoRoot: string, files: readonly string[]): ModuleFacts[] {
  return files
    .filter((f) => f.startsWith("src/") && f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => analyse(f, readFileSync(join(repoRoot, f), "utf8")));
}
