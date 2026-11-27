/**
 * Track K: the separation rules of docs/product/capability-spec.md §1.2, pinned for
 * `src/recovery/` (round 2, D2 and D3).
 *
 *  - §1.2.1: the gate request is unchanged. `ORACLE_INPUT_FIELDS` and `GATE_REQUEST_SCHEMA`
 *    are pinned by hash, and a recovery field in a request is refused.
 *  - §1.2.3 (in-process part): the real gate gives the same result on the same captured bytes
 *    whether or not the recovery tools ran. The MCP-server-attached form waits for the server
 *    (declared follow-up).
 *  - §1.2.4: no module under `src/recovery/` reaches, even transitively (type-only imports
 *    included), the gate's oracle, registry, sealed or corrections code, the grader, ground
 *    truth, the fixture generator or any manifest. Walked with the TypeScript AST, as
 *    `test/baseline/hcu-shell/import-boundary.test.ts` does.
 *  - The two values `src/recovery/` mirrors instead of importing are pinned equal to their
 *    sources.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EVIDENCE_PLANNERS } from "../../src/benchmark/check.ts";
import { GATE_REQUEST_SCHEMA, ORACLE_INPUT_FIELDS, parseGateRequest } from "../../src/gate/api.ts";
import { STATE_FILE_LIMIT } from "../../src/gate/gate.ts";
import { RECOVERY_EVIDENCE_PLANNERS } from "../../src/recovery/batch.ts";
import { RECOVERY_DOCUMENT_LIMIT, RecoveryTools, StepMeter } from "../../src/recovery/tools.ts";
import { COLLATERAL, STEPS, world } from "./helpers.ts";

/** From `src/gate/`, a capability module may reach only the request types and #514's loop. */
const GATE_ALLOWED = [/\/src\/gate\/api\.ts$/, /\/src\/gate\/multistep\.ts$/];
const FORBIDDEN = [
  /\/src\/benchmark\//,
  /\/src\/tasks\/intent\.ts$/,
  /\/src\/tasks\/fixture\.ts$/,
  /\/src\/foundry\//,
  /\/src\/verify\//,
  /manifest/i,
  /\.json$/,
];
const ALLOWED_EXTERNAL = new Set(["node:crypto"]);

function forbidden(path: string): boolean {
  if (/\/src\/gate\//.test(path)) return !GATE_ALLOWED.some((re) => re.test(path));
  return FORBIDDEN.some((re) => re.test(path));
}

/** Every file reachable from `entry` (static, re-export and type-only imports), plus externals. */
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
      if (ts.isImportTypeNode(node)) external.push(`import() type in ${file}`);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit(entry);
  return [...seen, ...external];
}

const violations = (entry: string) =>
  reachable(entry).filter(
    (p) => (p.startsWith("/") && forbidden(p)) || (!p.startsWith("/") && !ALLOWED_EXTERNAL.has(p)),
  );

const dir = resolve("src/recovery");
const modules = readdirSync(dir)
  .filter((n) => n.endsWith(".ts"))
  .map((n) => resolve(dir, n));

describe("§1.2.4 import boundary: src/recovery reaches no oracle, grader or ground truth", () => {
  it("covers every module of the track", () => expect(modules.length).toBeGreaterThanOrEqual(3));

  it.each(modules)("%s reaches nothing forbidden", (entry) => {
    expect(violations(entry)).toEqual([]);
  });

  it("canary: the gate module round 1 imported reaches oracles, corrections and ground truth", () => {
    const hits = violations(resolve("src/gate/gate.ts"));
    for (const re of [
      /\/src\/gate\/gate\.ts$/,
      /\/src\/gate\/corrections\.ts$/,
      /\/src\/gate\/families\.ts$/,
      /\/src\/tasks\/intent\.ts$/,
      /\/src\/tasks\/fixture\.ts$/,
    ])
      expect(
        hits.some((p) => re.test(p)),
        String(re),
      ).toBe(true);
  });

  it("canary: the grader and R1's check are forbidden", () => {
    expect(forbidden(resolve("src/benchmark/grade/grade.ts"))).toBe(true);
    expect(forbidden(resolve("src/benchmark/check.ts"))).toBe(true);
    expect(violations(resolve("src/benchmark/check.ts")).length).toBeGreaterThan(0);
  });

  it("canary: every other src/gate module is forbidden; only api.ts and multistep.ts are allowed", () => {
    const gateDir = resolve("src/gate");
    const names = readdirSync(gateDir).filter((n) => n.endsWith(".ts"));
    const allowed = names.filter((n) => !forbidden(resolve(gateDir, n))).sort();
    expect(allowed).toEqual(["api.ts", "multistep.ts"]);
  });
});

describe("§1.2.1 the gate request is unchanged by the track", () => {
  const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

  it("ORACLE_INPUT_FIELDS and GATE_REQUEST_SCHEMA match their pinned bytes", () => {
    expect(h(ORACLE_INPUT_FIELDS)).toBe(
      "179025d3b72a52a0379cca4ab42d996de9171f0dbe2181f0a0b436f52c66198c",
    );
    expect(h(GATE_REQUEST_SCHEMA)).toBe(
      "6086e47503d52dc79fcab2308ae0099f1a56c06df33e09fcefe62ac902605186",
    );
    expect(Object.keys(GATE_REQUEST_SCHEMA.properties).sort()).toEqual([
      "apiVersion",
      "claim",
      "runId",
      "taskId",
    ]);
  });

  it("a request carrying a recovery field is refused", () => {
    for (const field of ["checkpoint", "checkpointId", "id", "recovery", "snapshot"]) {
      const parsed = parseGateRequest({ taskId: "t", runId: "r", claim: "done", [field]: "x" });
      expect(parsed.ok, field).toBe(false);
    }
    expect(parseGateRequest({ taskId: "t", runId: "r", claim: "done" }).ok).toBe(true);
  });
});

describe("§1.2.3 (in-process) the gate's result on the same bytes does not depend on the tools", () => {
  it("same captured bytes, with and without the recovery tools having run: identical results", async () => {
    const w = world(async () => ({ claim: "done" }), { corrections: true });
    const ask = async () => {
      await w.harness.capture(1);
      const { checkedAt: _t, ...rest } = await w.harness.checkGate("done");
      return rest;
    };
    w.setGuest(STEPS);
    const without = await ask();

    const tools = new RecoveryTools({
      document: w.harness.guest,
      handed: new TextEncoder().encode("handed"),
      meter: new StepMeter(80),
    });
    const take = await tools.call("checkpoint_take", {});
    expect(take.ok).toBe(true);
    w.setGuest([COLLATERAL]);
    expect((await tools.call("snapshot_restore_start", {})).ok).toBe(true);
    expect((await tools.call("checkpoint_restore", { id: take.ok ? take.id : "" })).ok).toBe(true);
    tools.close();
    const withTools = await ask();

    expect(without.verdict).toBe("verified");
    expect(withTools).toEqual(without);
  });
});

describe("mirrored values are pinned to their sources", () => {
  it("RECOVERY_DOCUMENT_LIMIT is the gate's STATE_FILE_LIMIT", () => {
    expect(RECOVERY_DOCUMENT_LIMIT).toBe(STATE_FILE_LIMIT);
  });

  it("RECOVERY_EVIDENCE_PLANNERS is R1's EVIDENCE_PLANNERS", () => {
    expect([...RECOVERY_EVIDENCE_PLANNERS].sort()).toEqual([...EVIDENCE_PLANNERS].sort());
  });
});
