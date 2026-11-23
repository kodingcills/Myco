import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const driverModules = [
  "src/baseline/index.ts",
  "src/baseline/c1.ts",
  "src/baseline/c1-trial.ts",
  "src/baseline/planner.ts",
  "src/baseline/mcp-stdio.ts",
];
const stdioImports = new Set(["node:readline", "node:stream"]);

const allowed = new Set(
  [
    "src/tasks/intent.ts",
    "src/tasks/fixture.ts",
    "src/core/verify.ts",
    // Imports nothing (`src/tasks/task-text.ts` documents why that is a
    // requirement). It renders the sentence for the screenshot baseline only:
    // Myco's arm runs a compiled program and is never prompted. Both arms must
    // share the job — see test/baseline/task-parity.test.ts — not the prose. A
    // dependency-free leaf is safe to allow, and this test still catches
    // anything it might one day import.
    "src/tasks/task-text.ts",
  ].map((p) => resolve(p)),
);
function violations(entry: string, extraAllowed: string[] = []): string[] {
  const permitted = new Set([...allowed, ...extraAllowed.map((p) => resolve(p))]);
  const seen = new Set<string>();
  const errors: string[] = [];
  function visit(file: string): void {
    if (seen.has(file)) return;
    seen.add(file);
    if (file !== entry && !permitted.has(file)) errors.push(file);
    if (/\/src\/(integration|win|verify)\//.test(file)) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function checkSpecifier(spec: string): void {
      if (!spec.startsWith(".")) {
        if (file === resolve("src/baseline/mcp-stdio.ts") && stdioImports.has(spec)) return;
        errors.push(spec);
        return;
      }
      const path = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      visit(path.endsWith(".ts") ? path : `${path}.ts`);
    }
    function walk(node: ts.Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        checkSpecifier(node.moduleSpecifier.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        checkSpecifier(node.moduleReference.expression.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        checkSpecifier(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        errors.push(`dynamic import in ${file}`);
      if (ts.isIdentifier(node) && node.text === "require")
        errors.push(`require reference in ${file}`);
      if (ts.isElementAccessExpression(node)) {
        const root = node.expression.getText(source).split(".")[0] ?? "";
        const key = node.argumentExpression;
        if (
          ["globalThis", "process", "module"].includes(root) &&
          (!(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ||
            key.text === "require")
        )
          errors.push(`unsafe element access in ${file}`);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(entry);
  return errors;
}
describe("baseline import boundary", () => {
  // Guards against any dependency outside the host task modules and shared verdict types.
  it("enforces the allowlist", () =>
    expect(violations(resolve("src/baseline/index.ts"))).toEqual([]));
  it.each(driverModules)("keeps %s isolated from the grader and structural adapters", (entry) =>
    expect(violations(resolve(entry), driverModules)).toEqual([]),
  );
  // Guards against missing a direct forbidden integration import.
  it("detects the offending fixture", () =>
    expect(violations(resolve("test/baseline/fixtures/offending.ts"))).toContain(
      resolve("src/integration/trial.ts"),
    ));
  // Guards against stopping at an allowed intermediate module.
  it("detects a two-hop forbidden import", () =>
    expect(
      violations(resolve("test/baseline/fixtures/two-hop.ts"), [
        "test/baseline/fixtures/offending.ts",
      ]),
    ).toContain(resolve("src/integration/trial.ts")));
  // Guards against ignoring TypeScript import-equals dependencies.
  it("detects import equals", () =>
    expect(violations(resolve("test/baseline/fixtures/import-equals.txt"))).toContain(
      resolve("src/integration/trial.ts"),
    ));
  // Guards against ignoring dependencies referenced by import types.
  it("detects import types", () =>
    expect(violations(resolve("test/baseline/fixtures/import-type.txt"))).toContain(
      resolve("src/integration/trial.ts"),
    ));
});

it.each([
  "alias-require.txt",
  "property-require.txt",
  "double-require.txt",
  "single-require.txt",
  "process-require.txt",
  "template-require.txt",
  "computed-global.txt",
  "computed-process.txt",
  "computed-module.txt",
])("detects require references in %s", (name) => {
  expect(violations(resolve(`test/baseline/fixtures/${name}`))).not.toEqual([]);
});

it("allows benign references and data", () =>
  expect(violations(resolve("test/baseline/fixtures/benign.txt"))).toEqual([]));
