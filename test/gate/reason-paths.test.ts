/**
 * Agent-facing reasons never carry host paths or raw error messages (TIF-265 follow-up 2).
 *
 * #478 made the file reader's reasons path-free. These tests cover the gate-level reasons
 * outside it: "reader threw", "oracle threw", "decision log write failed", "gate error",
 * and the todo-items family's "store does not parse". Each forces the failure with an
 * error whose message holds an absolute host path, then requires that neither the path nor
 * the raw message appears anywhere in the result, in process and through the MCP server,
 * while the operator still gets the full error through `onDiagnostic`.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { GateResult } from "../../src/gate/api.ts";
import { main } from "../../src/gate/cli.ts";
import { FAMILIES, type OracleFamily } from "../../src/gate/families.ts";
import {
  buildRegistry,
  createGate,
  type EvidenceReader,
  fileEvidenceReader,
  type GateConfig,
  type GateDiagnostic,
  type GateTask,
  type TaskRegistry,
} from "../../src/gate/gate.ts";
import { GATE_TOOL, handleLine } from "../../src/gate/mcp-server.ts";
import { errorCode } from "../../src/gate/reasons.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { S01_ITEMS, tempRoot, todoStore, writeState } from "./helpers.ts";

const STORE = ".myco-todo.json";
const TRIAL = { taskId: "df-s01", runId: "r1" } as const;

/** Every spelling of a host path that must not reach the agent. */
function spellings(path: string): string[] {
  const out = new Set([path, resolve(path)]);
  try {
    out.add(realpathSync(path));
  } catch {
    // The path need not exist (an audit log in a missing directory).
  }
  return [...out];
}

/** An fs-shaped error: Node's message format, with the absolute path in it. */
function fsError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `${code}: simulated failure, ${syscall} '${path}'`,
  );
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function expectClean(
  { results, wire }: { results: GateResult[]; wire: string },
  forbidden: readonly string[],
): void {
  for (const result of results) expectResultClean(result, forbidden);
  // Nothing in the raw JSON-RPC reply line may carry it either.
  for (const text of forbidden) expect(wire).not.toContain(text);
}

function expectResultClean(result: GateResult, forbidden: readonly string[]): void {
  const whole = JSON.stringify(result);
  for (const text of forbidden) {
    expect(whole, `result carries ${JSON.stringify(text)}`).not.toContain(text);
    for (const reason of result.reasons) expect(reason).not.toContain(text);
  }
}

/**
 * Check once in process and once through the MCP server's tools/call. Returns the
 * in-process result, the reply's structuredContent and its text content, plus the raw
 * JSON-RPC reply line.
 */
async function bothWays(config: GateConfig): Promise<{ results: GateResult[]; wire: string }> {
  const direct = await createGate(config).check({ ...TRIAL });
  const line = await handleLine(
    createGate(config),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: GATE_TOOL, arguments: { ...TRIAL } },
    }),
  );
  const wire = JSON.parse(line as string) as {
    result: { structuredContent: GateResult; content: { text: string }[] };
  };
  const text = JSON.parse(wire.result.content[0]?.text ?? "null") as GateResult;
  return { results: [direct, wire.result.structuredContent, text], wire: line as string };
}

function registry(families: ReadonlyMap<string, OracleFamily> = FAMILIES): TaskRegistry {
  return buildRegistry(builtinTasks(), families);
}

describe("errorCode: a path-free code, never the message", () => {
  it("prefers an errno code, then the class name, else 'error'", () => {
    expect(errorCode(fsError("EACCES", "open", "/home/op/evidence/r1/x"))).toBe("EACCES");
    expect(errorCode(new TypeError("/home/op/secret is not a function"))).toBe("TypeError");
    expect(errorCode("/home/op/evidence: thrown string")).toBe("error");
    expect(errorCode(undefined)).toBe("error");
    expect(errorCode(null)).toBe("error");
  });

  it("ignores a code or name outside the strict alphabet (a path, spaces)", () => {
    expect(errorCode({ code: "/home/op/evidence/r1", name: "Error" })).toBe("Error");
    expect(errorCode({ code: "enoent /x" })).toBe("error");
    expect(errorCode({ name: "Error at /home/op/evidence" })).toBe("error");
    const hostile = {
      get code(): string {
        throw new Error("/home/op/evidence");
      },
    };
    expect(errorCode(hostile)).toBe("error");
  });

  it("an Error whose message holds a path, with a rejected code AND a rejected name, gives 'error', never the message", () => {
    const raw = Object.assign(new Error("/home/op/evidence/r1/.myco-todo.json"), {
      code: "/home/op/x",
      name: "Bad/Name",
    });
    expect(errorCode(raw)).toBe("error");
    expect(errorCode(raw)).not.toContain("/home/op");
  });

  it("a throwing `name` getter does not hide a valid `code`, and vice versa", () => {
    const badName = {
      code: "ENOENT",
      get name(): string {
        throw new Error("/home/op/evidence");
      },
    };
    expect(errorCode(badName)).toBe("ENOENT");
    const badCode = {
      name: "TypeError",
      get code(): string {
        throw new Error("/home/op/evidence");
      },
    };
    expect(errorCode(badCode)).toBe("TypeError");
  });
});

describe("reader threw: code only (custom readers)", () => {
  for (const [label, kind] of [
    ["rejects", "async"],
    ["throws synchronously", "sync"],
  ] as const) {
    it(`a reader that ${label} with a host path in its message`, async () => {
      const root = tempRoot();
      const path = join(root, "r1", STORE);
      const raw = fsError("EACCES", "open", path);
      const reader: EvidenceReader = {
        describe: root,
        read:
          kind === "async"
            ? async () => {
                throw raw;
              }
            : () => {
                throw raw;
              },
      };
      const seen: GateDiagnostic[] = [];
      const both = await bothWays({
        tasks: registry(),
        reader,
        assignment: TRIAL,
        onDiagnostic: (d) => seen.push(d),
      });
      for (const result of both.results) {
        expect(result.verdict).toBe("uncertain");
        expect(result.reasonCodes).toEqual(["STATE_UNREADABLE"]);
        expect(result.reasons).toEqual(["could not look: reader threw: EACCES"]);
      }
      expectClean(both, [...spellings(root), raw.message]);
      // The operator still gets the raw error.
      expect(seen[0]).toEqual({ stage: "reader", code: "EACCES", error: raw });
    });
  }

  it("a reader error with a path in its message and neither a usable code nor name is reported as 'error' (in process and over MCP)", async () => {
    const root = tempRoot();
    const raw = Object.assign(new Error(`EACCES: open '${join(root, "r1", STORE)}'`), {
      code: join(root, "r1"),
      name: `Err${root}`,
    });
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: registry(),
      reader: {
        describe: root,
        read: async () => {
          throw raw;
        },
      },
      assignment: TRIAL,
      onDiagnostic: (d) => seen.push(d),
    });
    for (const result of both.results) {
      expect(result.verdict).toBe("uncertain");
      expect(result.reasonCodes).toEqual(["STATE_UNREADABLE"]);
      expect(result.reasons).toEqual(["could not look: reader threw: error"]);
    }
    expectClean(both, [...spellings(root), raw.message, raw.name]);
    expect(seen[0]).toEqual({ stage: "reader", code: "error", error: raw });
  });

  it("a reader error whose `code` is itself a path is reported by class name", async () => {
    const root = tempRoot();
    const raw = Object.assign(new RangeError(`bad ${root}`), { code: join(root, "r1") });
    const both = await bothWays({
      tasks: registry(),
      reader: {
        describe: root,
        read: async () => {
          throw raw;
        },
      },
      assignment: TRIAL,
    });
    expect(both.results[0]?.reasons).toEqual(["could not look: reader threw: RangeError"]);
    expectClean(both, [...spellings(root), raw.message]);
  });
});

describe("oracle threw: code only", () => {
  it("an oracle that throws with the evidence root in its message", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const raw = new TypeError(`cannot read ${join(realpathSync(root), "r1", STORE)}`);
    const throwing: OracleFamily = {
      ...(FAMILIES.get("todo-items") as OracleFamily),
      decide() {
        throw raw;
      },
    };
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: registry(new Map([...FAMILIES, ["todo-items", throwing]])),
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDiagnostic: (d) => seen.push(d),
    });
    for (const result of both.results) {
      expect(result.reasonCodes).toEqual(["ORACLE_ERROR"]);
      expect(result.reasons).toEqual(["oracle threw: TypeError"]);
    }
    expectClean(both, [...spellings(root), raw.message]);
    expect(seen[0]).toEqual({ stage: "oracle", code: "TypeError", error: raw });
  });

  it("an oracle that throws a revoked Proxy (instanceof itself throws) is an oracle error, not a gate error", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const { proxy, revoke } = Proxy.revocable(new Error(`at ${root}`), {});
    revoke();
    const throwing: OracleFamily = {
      ...(FAMILIES.get("todo-items") as OracleFamily),
      decide() {
        throw proxy;
      },
    };
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: registry(new Map([...FAMILIES, ["todo-items", throwing]])),
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDiagnostic: (d) => seen.push(d),
    });
    for (const result of both.results) {
      expect(result.verdict).toBe("uncertain");
      expect(result.reasonCodes).toEqual(["ORACLE_ERROR"]);
      expect(result.reasons).toEqual(["oracle threw: error"]);
    }
    expectClean(both, spellings(root));
    // bothWays checks twice (in process, then over MCP): one diagnostic each.
    expect(seen.map((d) => [d.stage, d.code])).toEqual([
      ["oracle", "error"],
      ["oracle", "error"],
    ]);
  });

  it("the todo-items family reports a corrupt store by class name, not the parser's text", async () => {
    const root = tempRoot();
    // JSON.parse's message quotes the input; the input here holds a host path.
    const content = `{"items": ${join(realpathSync(root), "leak")}`;
    writeState(root, "r1", STORE, content);
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: registry(),
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDiagnostic: (d) => seen.push(d),
    });
    for (const result of both.results) {
      expect(result.reasonCodes).toEqual(["STATE_CORRUPT"]);
      expect(result.reasons).toEqual(["could not look: store does not parse (SyntaxError)"]);
    }
    const parserMessage = String((seen[0]?.error as Error | undefined)?.message);
    expect(seen[0]?.stage).toBe("oracle");
    expect(seen[0]?.error).toBeInstanceOf(SyntaxError);
    expectClean(both, [...spellings(root), parserMessage]);
  });
});

describe("decision log write failed: code only (the audit-log path)", () => {
  it("a real fs failure appending the log names neither the log path nor the message", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const audit = join(root, "missing-dir", "decisions.jsonl");
    let raw: unknown;
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: registry(),
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDecision: async (result) => {
        const { appendFileSync } = await import("node:fs");
        try {
          appendFileSync(audit, `${JSON.stringify(result)}\n`);
        } catch (error) {
          raw = error;
          throw error;
        }
      },
      onDiagnostic: (d) => seen.push(d),
    });
    expect(String(raw)).toContain(audit);
    for (const result of both.results) {
      expect(result.verdict).toBe("uncertain");
      expect(result.reasonCodes).toEqual(["ORACLE_PASS", "AUDIT_FAILED"]);
      expect(result.reasons.at(-1)).toBe("decision log write failed: ENOENT");
    }
    expectClean(both, [...spellings(audit), ...spellings(root), (raw as Error).message]);
    expect(seen[0]).toMatchObject({ stage: "decision-log", code: "ENOENT" });
  });

  it("CLI: --audit in a missing directory keeps the path out of the JSON, puts it on stderr", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const audit = join(root, "missing-dir", "decisions.jsonl");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (d) => {
      out += String(d);
    });
    stderr.on("data", (d) => {
      err += String(d);
    });
    const code = await main(
      ["check", "--evidence-root", root, "--task", "df-s01", "--run", "r1", "--audit", audit],
      { stdin: new PassThrough(), stdout, stderr },
    );
    expect(code).toBe(2);
    expect(out).toContain("decision log write failed: ENOENT");
    for (const text of [...spellings(audit), ...spellings(root)]) expect(out).not.toContain(text);
    // The operator sees the full error on stderr.
    expect(err).toContain("myco-gate: decision-log error (ENOENT):");
    expect(err).toContain(audit);
  });
});

describe("gate error: code only", () => {
  it("an internal throw (a registry whose lookup fails) carries no path or message", async () => {
    const root = tempRoot();
    const base = registry();
    const raw = new Error(`registry backing file ${join(realpathSync(root), "tasks.json")} gone`);
    const failing = new (class extends Map<string, GateTask> {
      override get(): GateTask | undefined {
        throw raw;
      }
    })(base);
    const seen: GateDiagnostic[] = [];
    const both = await bothWays({
      tasks: failing,
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDiagnostic: (d) => seen.push(d),
    });
    for (const result of both.results) {
      expect(result.reasonCodes).toEqual(["ORACLE_ERROR"]);
      expect(result.reasons).toEqual(["gate error: Error"]);
    }
    expectClean(both, [...spellings(root), raw.message]);
    expect(seen[0]).toEqual({ stage: "gate", code: "Error", error: raw });
  });
});

describe("onDiagnostic never changes a verdict", () => {
  it("a throwing diagnostic sink still yields a result (decision-log failure path)", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const result = await createGate({
      tasks: registry(),
      reader: fileEvidenceReader(root),
      assignment: TRIAL,
      onDecision: () => {
        throw new Error(`log ${root}`);
      },
      onDiagnostic: () => {
        throw new Error("sink down");
      },
    }).check({ ...TRIAL });
    expect(result.verdict).toBe("uncertain");
    expect(result.reasonCodes).toEqual(["ORACLE_PASS", "AUDIT_FAILED"]);
    expectResultClean(result, spellings(root));
  });
});
