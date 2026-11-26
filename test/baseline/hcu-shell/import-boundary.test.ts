/**
 * TIF-268: the hcu+shell arm's code cannot reach the grader's ground truth.
 *
 * The shell boundary keeps the *agent* away from ground truth at run time. This keeps the
 * *arm's own code* away from it: nothing under `src/baseline/hcu-shell/` may import, even
 * transitively, the module that computes the expected value (`src/tasks/intent.ts`), the
 * fixture generator, the pinned manifest (which carries Myco's verdicts), the Foundry
 * oracles and grader, TIF-267's benchmark grader, or the guest verifier the independent
 * judge uses. The one external import allowed is `node:crypto`, for hashing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWED_EXTERNAL = new Set(["node:crypto"]);

const FORBIDDEN = [
  /\/src\/tasks\/intent\.ts$/,
  /\/src\/tasks\/fixture\.ts$/,
  /\/src\/foundry\//,
  /\/src\/verify\//,
  /\/src\/integration\//,
  /\/src\/baseline\/c1-judge\.ts$/,
  /\/src\/baseline\/sweep\.ts$/,
  // TIF-267's independent grader and its check: the arm must not share code with them.
  /\/src\/benchmark\//,
  // Myco's gate (M2-02): the competitor arm must not share code with the arm it is compared to.
  /\/src\/gate\//,
  /\.json$/,
];

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const external: string[] = [];
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
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
        else external.push(spec);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        external.push(`dynamic import in ${file}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return [...seen, ...external];
}

const armDir = resolve("src/baseline/hcu-shell");
const armModules = readdirSync(armDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => resolve(armDir, name));

describe("hcu+shell import boundary", () => {
  it("covers every module in the arm", () => expect(armModules.length).toBeGreaterThanOrEqual(3));
  it.each(armModules)("%s reaches no ground-truth module", (entry) => {
    const hits = reachable(entry).filter(
      (path) =>
        FORBIDDEN.some((re) => re.test(path)) ||
        (!path.startsWith("/") && !ALLOWED_EXTERNAL.has(path)),
    );
    expect(hits).toEqual([]);
  });
  it("forbids Myco's gate (canary)", () => {
    expect(FORBIDDEN.some((re) => re.test(resolve("src/gate/api.ts")))).toBe(true);
  });
  it("would catch a ground-truth import (canary)", () => {
    const hits = reachable(resolve("src/baseline/sweep.ts")).filter((path) =>
      FORBIDDEN.some((re) => re.test(path)),
    );
    expect(hits.some((path) => path.endsWith("src/tasks/intent.ts"))).toBe(true);
  });
});
