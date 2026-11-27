/**
 * TIF-268: `src/pilot/claude-cli.ts` is the dependency-free half of the pilot's headless
 * Claude Code transport, moved unchanged so the hcu+shell planner can reuse it without loading
 * the pilot runner (which reaches the gate and the grader). The old modules re-export it.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as cli from "../../src/pilot/claude-cli.ts";
import * as transport from "../../src/pilot/claude-transport.ts";
import * as config from "../../src/pilot/config.ts";
import * as launch from "../../src/pilot/launch.ts";
import * as runner from "../../src/pilot/runner.ts";

describe("claude-cli", () => {
  it("has no runtime import at all (type-only imports are erased)", () => {
    const file = "src/pilot/claude-cli.ts";
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const runtime = source.statements.filter(
      (s) =>
        (ts.isImportDeclaration(s) && s.importClause?.isTypeOnly !== true) ||
        (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && !s.isTypeOnly),
    );
    expect(runtime.map((s) => s.getText())).toEqual([]);
  });
  it("the pilot modules re-export the very same objects (one classifier, one fault class)", () => {
    expect(transport.interpretResult).toBe(cli.interpretResult);
    expect(transport.classOfText).toBe(cli.classOfText);
    expect(transport.classOfStatus).toBe(cli.classOfStatus);
    expect(transport.parseUsage).toBe(cli.parseUsage);
    expect(transport.parseClaim).toBe(cli.parseClaim);
    expect(transport.RATE_LIMIT_TEXT).toBe(cli.RATE_LIMIT_TEXT);
    expect(transport.AUTH_TEXT).toBe(cli.AUTH_TEXT);
    expect(runner.HarnessFault).toBe(cli.HarnessFault);
    expect(launch.childEnv).toBe(cli.childEnv);
    expect(launch.subscriptionPreflight).toBe(cli.subscriptionPreflight);
    expect(launch.preflightRefusal).toBe(cli.preflightRefusal);
    expect(launch.API_CREDENTIAL_NAMES).toBe(cli.API_CREDENTIAL_NAMES);
    expect(config.PILOT_MODEL).toBe(cli.PILOT_MODEL);
    expect(config.CHILD_ENV_ALLOWLIST).toBe(cli.CHILD_ENV_ALLOWLIST);
  });
});
