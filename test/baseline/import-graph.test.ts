import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

function violations(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (/\/src\/(integration|win|verify)\//.test(file)) return;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (!spec.startsWith(".")) throw new Error(`External import: ${spec}`);
        const path = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        visit(path.endsWith(".ts") ? path : `${path}.ts`);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  };
  visit(entry);
  return [...seen].filter((p) => /\/src\/(integration|win|verify)\//.test(p));
}
describe("baseline import boundary", () => {
  // Guards the harness against reaching live adapters or trial orchestration.
  it("keeps the entry isolated", () => expect(violations(resolve("src/baseline/index.ts"))).toEqual([]));
  // Guards the graph walker itself against silently ignoring an offending import.
  it("detects a deliberate forbidden import", () => expect(violations(resolve("test/baseline/fixtures/offending.ts")).length).toBeGreaterThan(0));
});
