/**
 * TIF-268, lead ruling 2026-11-27 01:35Z: the hcu+shell arm runs at $0 Anthropic API. This file
 * proves no code path of the arm reaches the Messages API or reads an Anthropic key:
 *
 *  1. **Grep, comments stripped, over every module the CLI loads at runtime** (type-only
 *     imports are erased): no `/v1/messages`, no `api.anthropic.com`, no `x-api-key`, no
 *     `fetch(`, no read of `ANTHROPIC_API_KEY` from an environment, and no reference to C1's
 *     paid `createPlanner` or the key loaders. C1's `src/baseline/planner.ts` is the one
 *     exception: it IS loaded (the merged `decision.ts` imports its prompt constants), so the
 *     check there is that nothing the arm loads calls into it beyond those constants.
 *  2. **Runtime, with a dummy `ANTHROPIC_API_KEY` set in the process environment**: the
 *     planner refuses to start on `process.env`; given a clean environment it never passes the
 *     key to `claude` or into its input; a whole simulated run plus pack never calls fetch and
 *     never writes the value anywhere.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSubscriptionPlanner,
  PROBE_SCREENSHOT,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  demoTasks,
  exportHcuPack,
  hcuRunPlan,
  loadFcV1,
  runHcuShell,
  SIMULATED_PLANNER,
} from "../../../src/baseline/hcu-shell-live/runner.ts";
import {
  simulatedEnvironment,
  simulatedPlanner,
} from "../../../src/baseline/hcu-shell-live/simulated.ts";
import { fakeClaude, okReply, useClaudeTrap, useFetchTrap } from "./helpers.ts";

useClaudeTrap();
const fetchTrap = useFetchTrap();

const ROOT = resolve(".");
const CLI = resolve("scripts/m2-hcu-shell-run.ts");
const C1_PLANNER = resolve("src/baseline/planner.ts");

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
const onDisk = (p: string) =>
  existsSync(p) ? p : p.endsWith(".js") ? `${p.slice(0, -3)}.ts` : `${p}.ts`;

/** Every repo module the entry loads at runtime, with its source minus comments. */
function runtimeModules(entry: string): Map<string, string> {
  const out = new Map<string, string>();
  const printer = ts.createPrinter({ removeComments: true });
  const visit = (file: string) => {
    if (out.has(file) || file.endsWith(".json")) return;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    out.set(file, printer.printFile(source));
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !typeOnly(node) &&
        node.moduleSpecifier.text.startsWith(".")
      )
        visit(onDisk(resolve(dirname(file), node.moduleSpecifier.text)));
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return out;
}

const FORBIDDEN: readonly [string, RegExp][] = [
  ["Messages API path", /\/v1\/messages/],
  ["Anthropic API host", /api\.anthropic\.com/],
  ["API key header", /x-api-key/i],
  ["network fetch", /\bfetch\s*\(/],
  ["env read of the key", /env(?:\.ANTHROPIC_API_KEY|\[\s*["'`]ANTHROPIC_API_KEY)/],
  ["C1 paid planner", /\bcreatePlanner\b/],
  ["key loader", /\bresolveAnthropicKey\b|\breadSecretFromFile\b|secret-file/],
];

describe("grep: no runtime code path of the arm reaches the Messages API or an Anthropic key", () => {
  const modules = runtimeModules(CLI);
  const files = [...modules.keys()].filter((f) => f !== C1_PLANNER);
  it("covers the arm's live modules, the CLI and the shared CLI classifier", () => {
    const live = readdirSync("src/baseline/hcu-shell-live").map((n) =>
      resolve("src/baseline/hcu-shell-live", n),
    );
    for (const f of [CLI, resolve("src/pilot/claude-cli.ts"), ...live])
      expect(modules.has(f), f).toBe(true);
  });
  it.each(FORBIDDEN)("no %s", (_what, re) => {
    expect(files.filter((f) => re.test(modules.get(f) ?? ""))).toEqual([]);
  });
  it("C1's planner is loaded only for its prompt constants: nothing imports its API entry points", () => {
    // Every runtime import that resolves to C1's planner, with the names it takes.
    const uses: { file: string; names: string[] }[] = [];
    for (const f of files) {
      const source = ts.createSourceFile(f, modules.get(f) ?? "", ts.ScriptTarget.Latest, true);
      for (const stmt of source.statements) {
        if (
          !(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) ||
          stmt.moduleSpecifier === undefined ||
          !ts.isStringLiteral(stmt.moduleSpecifier) ||
          typeOnly(stmt) ||
          onDisk(resolve(dirname(f), stmt.moduleSpecifier.text)) !== C1_PLANNER
        )
          continue;
        const bindings = ts.isImportDeclaration(stmt)
          ? stmt.importClause?.namedBindings
          : stmt.exportClause;
        const names =
          bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
            ? bindings.elements
                .filter((e) => !e.isTypeOnly)
                .map((e) => (e.propertyName ?? e.name).text)
            : ["*"];
        uses.push({ file: f, names: names.sort() });
      }
    }
    expect(uses).toEqual([
      { file: resolve("src/baseline/hcu-shell/decision.ts"), names: ["MAX_OUTPUT", "PROMPT"] },
    ]);
  });
  it("the guest helper never talks to Anthropic either", () => {
    const ps1 = readFileSync("scripts/guest/hcu-shell.ps1", "utf8");
    for (const [, re] of FORBIDDEN.slice(0, 3)) expect(ps1).not.toMatch(re);
  });
});

describe("runtime: a dummy ANTHROPIC_API_KEY in the environment is never used", () => {
  const DUMMY = "dummy-not-a-key-0000";
  const before = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = DUMMY;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  });
  const price = () => 0.001;
  it("the planner refuses to start on that environment (and spawns nothing)", () => {
    const fake = fakeClaude([okReply('{"claim":"done"}')]);
    expect(() =>
      createSubscriptionPlanner({
        spawn: fake.spawn,
        command: "claude",
        env: process.env,
        cwd: ROOT,
        price,
      }),
    ).toThrow(/api-key-path-configured/);
    expect(fake.calls).toHaveLength(0);
  });
  it("on a clean environment the key never reaches claude's environment, argv or input", async () => {
    const fake = fakeClaude([okReply('{"claim":"done"}')]);
    const env = { HOME: "/home/op", PATH: "/usr/bin" };
    const p = createSubscriptionPlanner({
      spawn: fake.spawn,
      command: "claude",
      env,
      cwd: ROOT,
      price,
    });
    await p.act({ instruction: "x", screenshot: PROBE_SCREENSHOT, shellHistory: [] });
    const call = fake.calls[0];
    expect(Object.keys(call?.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(call)).not.toContain(DUMMY);
  });
  it("a whole run and its pack never fetch and never write the value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-nokey-"));
    const tasks = demoTasks(loadFcV1(ROOT));
    await runHcuShell({
      outDir: dir,
      repoRoot: ROOT,
      tasks,
      plan: hcuRunPlan(tasks, { hcuGuestCommand: "c", guestShellSha256: "0".repeat(64) }),
      env: simulatedEnvironment(ROOT),
      planner: simulatedPlanner(),
      plannerModelId: SIMULATED_PLANNER,
      maxTrials: 3,
    });
    exportHcuPack(dir, ROOT, tasks);
    expect(fetchTrap.calls).toEqual([]);
    const written = ["ledger.jsonl", "progress.json", "arm.jsonl", "requests.jsonl"].map((f) =>
      readFileSync(join(dir, f), "utf8"),
    );
    for (const w of written) expect(w).not.toContain(DUMMY);
  });
});
