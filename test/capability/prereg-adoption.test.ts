/**
 * Repo-wide (GitHub #652): every capability pre-registration's analysis entry point calls the
 * shared capability-analysis guard before any decision.
 *
 * For each `docs/product/capability-prereg/<track>-v<k>/prereg.json` it reads the analysis
 * entry point (`analysis.script`, a path or `{ path }`), walks its relative imports with the
 * TypeScript AST, and requires that
 *  - the walk reaches `src/capability/analysis-guard.ts`;
 *  - some reached module calls `guardCapabilityAnalysis(...)` and `guardedVerdict(...)`,
 *    imported from the guard (so the verdict goes through the guard);
 *  - the pre-registration pins the guard by its current SHA-256 under `analysis.modules`, so
 *    the pre-registration hash covers it.
 * A pre-registration with no identifiable entry point fails: a new track's analysis cannot
 * land without adopting the guard. The detector is itself tested on fixtures.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CAPABILITY_ANALYSIS_GUARD_PATH } from "../../src/capability/analysis-guard.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PREREG_DIR = "docs/product/capability-prereg";
const REQUIRED_CALLS = ["guardCapabilityAnalysis", "guardedVerdict"] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with one pre-registration's adoption of the guard; empty when it adopts it. */
function adoptionProblems(root: string, preregPath: string): string[] {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, preregPath), "utf8"));
  } catch {
    return ["prereg.json does not parse"];
  }
  const analysis = isObj(raw) ? raw.analysis : undefined;
  const script = isObj(analysis) ? analysis.script : undefined;
  const entry = typeof script === "string" ? script : isObj(script) ? script.path : undefined;
  if (typeof entry !== "string" || entry.length === 0)
    return ["no analysis entry point (analysis.script)"];
  const entryFull = resolve(root, entry);
  if (!existsSync(entryFull)) return [`the entry point ${entry} does not exist`];

  const guardFull = resolve(root, CAPABILITY_ANALYSIS_GUARD_PATH);
  const seen = new Set<string>();
  const calls = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    if (file === guardFull) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    // Local names bound to the guard's exports in this module.
    const fromGuard = new Map<string, string>();
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        const target = resolve(dirname(file), node.moduleSpecifier.text);
        if (
          target === guardFull &&
          ts.isImportDeclaration(node) &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        )
          for (const el of node.importClause.namedBindings.elements)
            fromGuard.set(el.name.text, (el.propertyName ?? el.name).text);
        visit(target);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const imported = fromGuard.get(node.expression.text);
        if (imported !== undefined) calls.add(imported);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entryFull);

  if (!seen.has(guardFull))
    problems.push(`${entry} does not reach ${CAPABILITY_ANALYSIS_GUARD_PATH}`);
  for (const name of REQUIRED_CALLS)
    if (!calls.has(name)) problems.push(`no module reached from ${entry} calls ${name}()`);

  const modules = isObj(analysis) && Array.isArray(analysis.modules) ? analysis.modules : [];
  const pin = modules.find((m) => isObj(m) && m.path === CAPABILITY_ANALYSIS_GUARD_PATH);
  const actual = existsSync(guardFull)
    ? createHash("sha256").update(readFileSync(guardFull)).digest("hex")
    : null;
  if (!isObj(pin)) problems.push("analysis.modules does not pin the guard");
  else if (pin.sha256 !== actual) problems.push("analysis.modules pins another guard SHA-256");
  return problems;
}

const preregs = readdirSync(join(ROOT, PREREG_DIR), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `${PREREG_DIR}/${d.name}/prereg.json`)
  .filter((p) => existsSync(join(ROOT, p)));

describe("every capability pre-registration's analysis calls the shared guard (#652)", () => {
  it("finds the pre-registrations on main (j-v1 and k-v1 at least)", () => {
    expect(preregs).toEqual(
      expect.arrayContaining([`${PREREG_DIR}/j-v1/prereg.json`, `${PREREG_DIR}/k-v1/prereg.json`]),
    );
  });

  for (const p of preregs)
    it(`${p}: the entry point calls the guard, and the guard is pinned`, () => {
      expect(adoptionProblems(ROOT, p)).toEqual([]);
    });
});

describe("the adoption detector", () => {
  const guardSrc = readFileSync(join(ROOT, CAPABILITY_ANALYSIS_GUARD_PATH));
  const guardSha = createHash("sha256").update(guardSrc).digest("hex");
  function fixture(files: Record<string, string>, analysis: unknown): [string, string] {
    const root = mkdtempSync(join(tmpdir(), "guard-adoption-"));
    const put = (path: string, text: string | Buffer) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put(CAPABILITY_ANALYSIS_GUARD_PATH, guardSrc);
    for (const [path, text] of Object.entries(files)) put(path, text);
    const prereg = `${PREREG_DIR}/x-v1/prereg.json`;
    put(prereg, JSON.stringify({ analysis }));
    return [root, prereg];
  }
  const pinned = (script: unknown) => ({
    script,
    modules: [{ path: CAPABILITY_ANALYSIS_GUARD_PATH, sha256: guardSha }],
  });
  const imp = (from: string) =>
    `import { guardCapabilityAnalysis, guardedVerdict } from "${from}";\n`;
  const CALLS =
    "const g = guardCapabilityAnalysis(x);\nexport const v = guardedVerdict(g, true);\n";
  const rel = (from: string) =>
    `./${relative(dirname(from), CAPABILITY_ANALYSIS_GUARD_PATH)}`.replace("./../", "../");

  it("accepts an entry point that calls both, directly or through an imported module", () => {
    const a = "src/x/analysis.ts";
    expect(adoptionProblems(...fixture({ [a]: imp(rel(a)) + CALLS }, pinned(a)))).toEqual([]);
    const s = "scripts/x.ts";
    expect(
      adoptionProblems(
        ...fixture(
          { [a]: imp(rel(a)) + CALLS, [s]: 'import { v } from "../src/x/analysis.ts";\n' },
          pinned({ path: s }),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects an entry point that never reaches the guard", () => {
    const a = "src/x/analysis.ts";
    expect(adoptionProblems(...fixture({ [a]: "export const v = 1;\n" }, pinned(a)))).toEqual([
      `${a} does not reach ${CAPABILITY_ANALYSIS_GUARD_PATH}`,
      `no module reached from ${a} calls guardCapabilityAnalysis()`,
      `no module reached from ${a} calls guardedVerdict()`,
    ]);
  });

  it("rejects an entry point that imports the guard but never calls it", () => {
    const a = "src/x/analysis.ts";
    const text = `${imp(rel(a))}export const keep = [guardCapabilityAnalysis, guardedVerdict];\n`;
    expect(adoptionProblems(...fixture({ [a]: text }, pinned(a)))).toEqual([
      `no module reached from ${a} calls guardCapabilityAnalysis()`,
      `no module reached from ${a} calls guardedVerdict()`,
    ]);
  });

  it("rejects a same-named local function that is not the guard's", () => {
    const a = "src/x/analysis.ts";
    const text = `function guardCapabilityAnalysis(x: unknown) { return x; }\nfunction guardedVerdict(..._a: unknown[]) { return "shown"; }\n${CALLS}`;
    expect(adoptionProblems(...fixture({ [a]: text }, pinned(a))).length).toBeGreaterThan(0);
  });

  it("rejects a guard that is not pinned, or pinned at another SHA-256", () => {
    const a = "src/x/analysis.ts";
    const files = { [a]: imp(rel(a)) + CALLS };
    expect(adoptionProblems(...fixture(files, { script: a }))).toEqual([
      "analysis.modules does not pin the guard",
    ]);
    expect(
      adoptionProblems(
        ...fixture(files, {
          script: a,
          modules: [{ path: CAPABILITY_ANALYSIS_GUARD_PATH, sha256: "0".repeat(64) }],
        }),
      ),
    ).toEqual(["analysis.modules pins another guard SHA-256"]);
  });

  it("rejects a pre-registration with no entry point, or a missing one", () => {
    expect(adoptionProblems(...fixture({}, { modules: [] }))).toEqual([
      "no analysis entry point (analysis.script)",
    ]);
    expect(adoptionProblems(...fixture({}, pinned("src/x/gone.ts")))).toEqual([
      "the entry point src/x/gone.ts does not exist",
    ]);
  });
});
