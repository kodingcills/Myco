/**
 * TIF-268: what the live hcu+shell harness may reach.
 *
 * The arm library (`src/baseline/hcu-shell/`) has its own stricter boundary
 * (`test/baseline/hcu-shell/import-boundary.test.ts`). The live harness is the M2-12 wrapper:
 * it legitimately reaches the task's ground truth (the arm's internal judge) and the guest.
 * It must still never share code with TIF-267's independent grader (`src/benchmark/grade/`),
 * never reach Myco's gate (`src/gate/`), and never reach the Anthropic key loader
 * (`secret-file.ts`). (C1's `planner.ts` IS reached, for its prompt constants via the merged
 * `decision.ts`; that no code path calls its API or reads a key is `no-api-key.test.ts`.) The
 * planner module is held tighter still: it reaches no ground truth.
 * Type-only imports are skipped: they are erased and share no runtime code.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Erased at compile time: shares no runtime code (`import type`, `export type`). */
function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return (
    clause.name === undefined &&
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((e) => e.isTypeOnly)
  );
}

/** `./x.js` in a TS import names `./x.ts`. */
const onDisk = (path: string) =>
  existsSync(path) ? path : path.endsWith(".js") ? `${path.slice(0, -3)}.ts` : `${path}.ts`;

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith(".json")) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !typeOnly(node)
      ) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) visit(onDisk(resolve(dirname(file), spec)));
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return [...seen];
}

const LIVE_FORBIDDEN = [
  /\/src\/benchmark\/grade\//,
  /\/src\/gate\//,
  /\/src\/baseline\/secret-file\.ts$/,
];
const PLANNER_FORBIDDEN = [
  ...LIVE_FORBIDDEN,
  /\/src\/tasks\/intent\.ts$/,
  /\/src\/tasks\/fixture\.ts$/,
  /\/src\/baseline\/c1-judge\.ts$/,
  /\/src\/verify\//,
  /\/src\/integration\//,
  /\/src\/benchmark\//,
];

const dir = resolve("src/baseline/hcu-shell-live");
const modules = readdirSync(dir)
  .filter((n) => n.endsWith(".ts"))
  .map((n) => resolve(dir, n));

describe("hcu+shell live harness import boundary", () => {
  it("covers the live modules", () => expect(modules.length).toBeGreaterThanOrEqual(3));
  it.each(modules)("%s never reaches the grader, the gate, or the key loader", (entry) => {
    expect(reachable(entry).filter((p) => LIVE_FORBIDDEN.some((re) => re.test(p)))).toEqual([]);
  });
  it("the planner reaches no ground truth and nothing under src/benchmark", () => {
    const hits = reachable(resolve(dir, "planner.ts")).filter((p) =>
      PLANNER_FORBIDDEN.some((re) => re.test(p)),
    );
    expect(hits).toEqual([]);
  });
});
