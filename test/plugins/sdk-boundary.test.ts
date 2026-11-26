/**
 * Capability track T, code boundaries:
 *  - the SDK (`src/plugins/sdk/`) loads inside the sandbox, so it imports nothing outside its
 *    own directory except builtins the sandbox guard allows (and no TS-only runtime syntax:
 *    the child runs it with Node's type stripping);
 *  - no plugin module (SDK, host, example) reaches the gate's request or oracle code: plugins
 *    are not wired into `myco.gate/v1`, whose request schema stays `taskId`/`runId`/`claim`.
 * Grader independence (plugins never share code with `src/benchmark/grade/`) is in
 * `test/benchmark/independence.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SDK = join(ROOT, "src", "plugins", "sdk");
const PLUGINS = join(ROOT, "src", "plugins");
const EXAMPLES = join(ROOT, "examples", "plugins");

const IMPORT =
  /(?:import|export)\s(?!type\b)[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function runtimeSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : /\.(ts|mjs)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

function walk(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of runtimeSpecifiers(readFileSync(entry, "utf8")))
    if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  return seen;
}

// Must match ALLOWED_BUILTINS in src/plugins/sdk/guard.ts (checked below).
const SANDBOX_BUILTINS = ["node:module", "node:url"];

describe("plugin SDK boundary", () => {
  it("the SDK imports only its own directory and sandbox-allowed builtins", () => {
    const violations: string[] = [];
    for (const file of tsFiles(SDK)) {
      for (const mod of walk(file)) {
        if (!mod.startsWith(`${SDK}/`))
          violations.push(`${relative(ROOT, mod)} from ${relative(ROOT, file)}`);
        for (const spec of runtimeSpecifiers(readFileSync(mod, "utf8")))
          if (!spec.startsWith(".") && !SANDBOX_BUILTINS.includes(spec))
            violations.push(`${relative(ROOT, mod)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("node:module is used only by the guard (to install the hooks before plugin code)", () => {
    for (const file of tsFiles(SDK)) {
      const uses = runtimeSpecifiers(readFileSync(file, "utf8")).includes("node:module");
      expect(uses, relative(ROOT, file)).toBe(file.endsWith("guard.ts"));
    }
    const guard = readFileSync(join(SDK, "guard.ts"), "utf8");
    expect(guard).toMatch(/"url",/);
    expect(guard).not.toMatch(
      /"(net|http|https|dns|fs|child_process|module|os|vm|worker_threads)",/,
    );
  });

  it("the SDK uses no non-erasable TypeScript (parameter properties, enums, namespaces)", () => {
    for (const file of tsFiles(SDK)) {
      const code = readFileSync(file, "utf8");
      expect(code, relative(ROOT, file)).not.toMatch(
        /constructor\s*\([^)]*\b(readonly|private|public|protected)\s|\benum\s+\w|\bnamespace\s+\w/,
      );
    }
  });

  it("the example plugin has no runtime imports (self-contained directory)", () => {
    for (const file of tsFiles(EXAMPLES))
      expect(runtimeSpecifiers(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("no plugin module reaches the gate's request, oracle, registry or sealed code", () => {
    const forbidden = /\/src\/(gate|verify|benchmark)\//;
    const violations: string[] = [];
    for (const file of [...tsFiles(PLUGINS), ...tsFiles(EXAMPLES)])
      for (const mod of walk(file))
        if (forbidden.test(mod))
          violations.push(`${relative(ROOT, mod)} from ${relative(ROOT, file)}`);
    expect(violations).toEqual([]);
  });

  it("the walker sees runtime imports and skips type-only ones (bite check)", () => {
    expect(
      runtimeSpecifiers(
        'import type { A } from "../gate/api.ts";\nimport { b } from "../gate/oracle.ts";\nawait import("node:fs");',
      ),
    ).toEqual(["../gate/oracle.ts", "node:fs"]);
  });
});
