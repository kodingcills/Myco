/**
 * H-01 (docs/security/gate-api-review.md): `myco-gate mcp` never holds more than
 * `MAX_FRAME_BYTES` of one JSON-RPC frame, answers an oversized frame with `-32600` in
 * order, and keeps serving. Unit tests on `FrameBound`, in process through `serveStdio`,
 * and as the real subprocess started from `scripts/myco-gate.ts`.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { GATE_TOOL, handleLine, serveStdio } from "../../src/gate/mcp-server.ts";
import {
  boundFrames,
  FrameBound,
  MAX_FRAME_BYTES,
  OVERSIZED_FRAME_LINE,
} from "../../src/gate/stdio-frame.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { S01_ITEMS, tempRoot, todoStore, writeState } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const STORE = ".myco-todo.json";

async function collect(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

/** Push `chunks` through a FrameBound and return everything it emitted. */
async function frame(chunks: readonly (string | Buffer)[], maxBytes: number) {
  const bound = new FrameBound({ maxBytes });
  const out = collect(bound);
  for (const chunk of chunks) bound.write(chunk);
  bound.end();
  return { text: await out, bound };
}

function passingGate() {
  const root = tempRoot();
  writeState(root, "run-ok", STORE, todoStore(S01_ITEMS));
  return createGate({
    tasks: buildRegistry(builtinTasks()),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "df-s01", runId: "run-ok" },
  });
}

const PING = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });

describe("FrameBound: frames within the cap pass through byte for byte", () => {
  it("passes frames of exactly maxBytes, split across chunks, unchanged", async () => {
    const exact = "x".repeat(16);
    const { text } = await frame([exact.slice(0, 5), exact.slice(5), "\nab", "c\n"], 16);
    expect(text).toBe(`${exact}\nabc\n`);
  });

  it("passes a final frame with no newline unchanged", async () => {
    const { text } = await frame(["a\nlast"], 16);
    expect(text).toBe("a\nlast");
  });

  it("keeps multi-byte UTF-8 split across chunks intact", async () => {
    const line = Buffer.from('{"claim":"héllo ✓"}');
    const { text } = await frame([line.subarray(0, 12), line.subarray(12), "\n"], 64);
    expect(text).toBe('{"claim":"héllo ✓"}\n');
  });
});

describe("FrameBound: an oversized frame is replaced, never held", () => {
  it("one byte over the cap is replaced by the fixed line", async () => {
    const { text } = await frame([`${"x".repeat(17)}\n`], 16);
    expect(text).toBe(`${OVERSIZED_FRAME_LINE}\n`);
  });

  it("the frames before and after an oversized one are untouched, in order", async () => {
    const { text } = await frame(["before\n", "y".repeat(40), "y".repeat(40), "\nafter\n"], 16);
    expect(text).toBe(`before\n${OVERSIZED_FRAME_LINE}\nafter\n`);
  });

  it("an oversized frame that never ends holds at most maxBytes and is replaced at end", async () => {
    const cap = 1024;
    const chunk = Buffer.alloc(4096, 0x61);
    const chunks = Array.from({ length: 2048 }, () => chunk); // 8 MiB, no newline
    const { text, bound } = await frame(chunks, cap);
    expect(text).toBe(OVERSIZED_FRAME_LINE);
    expect(bound.peakHeldBytes).toBeLessThanOrEqual(cap);
  });

  it("calls onOversized once per dropped frame; a throwing callback changes nothing", async () => {
    let calls = 0;
    const bound = new FrameBound({
      maxBytes: 4,
      onOversized: () => {
        calls += 1;
        throw new Error("diagnostic sink failed");
      },
    });
    const out = collect(bound);
    bound.end("ok\n123456\nfine\n7890123\n");
    expect(await out).toBe(`ok\n${OVERSIZED_FRAME_LINE}\nfine\n${OVERSIZED_FRAME_LINE}\n`);
    expect(calls).toBe(2);
  });

  it("the replacement line is answered -32600 by the server, with id null and no handler run", async () => {
    const reply = JSON.parse((await handleLine(passingGate(), OVERSIZED_FRAME_LINE)) ?? "null");
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid request" },
    });
  });

  it("rejects a non-positive or fractional cap", () => {
    expect(() => new FrameBound({ maxBytes: 0 })).toThrow(RangeError);
    expect(() => new FrameBound({ maxBytes: 1.5 })).toThrow(RangeError);
  });

  it("the default cap is 1 MiB", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(new FrameBound().maxBytes).toBe(MAX_FRAME_BYTES);
  });
});

describe("serveStdio behind boundFrames", () => {
  it("an oversized tools/call is -32600, never a verdict, and the next call is still served", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serveStdio(passingGate(), boundFrames(input, { maxBytes: 4096 }), output);
    const replies = collect(output);
    // A passing run: an oversized call that reached the gate would be a verdict.
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: GATE_TOOL,
        arguments: { taskId: "df-s01", runId: "run-ok", claim: "c".repeat(10_000) },
      },
    });
    const ok = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: GATE_TOOL, arguments: { taskId: "df-s01", runId: "run-ok" } },
    });
    input.end(`${PING(0)}\n${oversized}\n${PING(2)}\n${ok}\n`);
    await served;
    output.end();
    const lines = (await replies)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([0, null, 2, 3]);
    expect(lines[1]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid request" },
    });
    expect(lines[1].result).toBeUndefined();
    expect(lines[3].result.structuredContent.verdict).toBe("verified");
  });
});

describe("myco-gate mcp as a subprocess: stdin is bounded", () => {
  function spawnGate(root: string) {
    return spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts/myco-gate.ts"),
        "mcp",
        "--evidence-root",
        root,
        "--task",
        "df-s01",
        "--run",
        "run-ok",
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  it("a frame over MAX_FRAME_BYTES gets -32600 and a stderr note; the following ping is served", async () => {
    const root = tempRoot();
    writeState(root, "run-ok", STORE, todoStore(S01_ITEMS));
    const child = spawnGate(root);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: GATE_TOOL,
        arguments: { taskId: "df-s01", runId: "run-ok", claim: "c".repeat(MAX_FRAME_BYTES) },
      },
    });
    child.stdin.write(`${huge}\n`);
    child.stdin.end(`${PING(2)}\n`);
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    const lines = (await stdout)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(code).toBe(0);
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect(await stderr).toContain(`dropped a JSON-RPC frame over ${MAX_FRAME_BYTES} bytes`);
  }, 30_000);

  it("check does not read stdin: it exits with stdin left open", async () => {
    const root = tempRoot();
    writeState(root, "run-ok", STORE, todoStore(S01_ITEMS));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts/myco-gate.ts"),
        "check",
        "--evidence-root",
        root,
        "--task",
        "df-s01",
        "--run",
        "run-ok",
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done(-1);
      }, 15_000);
      child.once("exit", (c) => {
        clearTimeout(timer);
        done(c);
      });
    });
    child.stdin.destroy();
    expect(code).toBe(0);
  }, 30_000);
});
