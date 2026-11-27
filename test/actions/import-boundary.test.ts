/**
 * Track J: the router's code shares nothing with the gate, the grader or ground truth
 * (capability spec §1.2 item 4). Nothing under `src/actions/` may import, even
 * transitively, the gate, the benchmark grader and check, the module that computes the
 * expected value (`src/tasks/intent.ts`), the fixture generator, the Linux path's oracle or
 * scripted demo agents, the guest verifier, the Foundry, or any JSON manifest.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWED_EXTERNAL = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:os",
  "node:path",
  "node:url",
]);

const FORBIDDEN = [
  /\/src\/gate\//,
  /\/src\/benchmark\//,
  /\/src\/tasks\//,
  /\/src\/linux\/(oracle|agent|run|demo|corrupt)\.ts$/,
  /\/src\/verify\//,
  /\/src\/foundry\//,
  /\/src\/m2\//,
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

const dir = resolve("src/actions");
const modules = readdirSync(dir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => resolve(dir, name));

describe("track J import boundary", () => {
  it("covers every module", () => expect(modules.length).toBeGreaterThanOrEqual(6));
  it.each(modules)("%s reaches no gate, grader or ground-truth module", (entry) => {
    const hits = reachable(entry).filter(
      (path) =>
        FORBIDDEN.some((re) => re.test(path)) ||
        (!path.startsWith("/") && !ALLOWED_EXTERNAL.has(path)),
    );
    expect(hits).toEqual([]);
  });
});
