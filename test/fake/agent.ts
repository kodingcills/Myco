/**
 * Fake myco-agent for the UNO verifier tests (M1-007). A scriptable NDJSON
 * agent speaking the agent/README.md protocol, so the verifier is exercised
 * against the real wire shape (request lines → response lines), not mocks of
 * its own interfaces.
 */

import { GUEST_BATCH_END } from "../../src/integration/guest-shell.js";
import type { AgentRequest, AgentResponse, UnoEvalResult } from "../../src/win/agent-client.ts";

export interface FakeAgentScript {
  /**
   * Responses for uno_eval. When `behavior` is "scripted", entries pop in
   * order; otherwise `unoBehavior` decides per call.
   */
  unoEval?: ("error" | UnoEvalResult)[];
  /** CSV bytes returned by read_file (the converted persisted file). */
  csvBytes?: Buffer;
  /** When set, read_file fails (persisted file unreadable). */
  readFileError?: boolean;
  /** When set, this op fails with OP_FAILED (fault injection). */
  failOps?: string[];
  /** Guest files written via write_file, by path. */
  writtenFiles?: Map<string, Buffer>;
  /**
   * Called for every uno_eval; overrides the scripted list when set. A
   * string return becomes the deployed agent's `{call, cell, value}` shape.
   */
  unoBehavior?: (params: Record<string, unknown>) => "error" | string | boolean | UnoEvalResult;
  /** When set, helper-launched mutations answer uno_eval (stateful desktop). */
  desktopOverlay?: boolean;
  /** Stray processes by image name, killed (and cleared) by the kill op. */
  strayProcesses?: Record<string, number[]>;
  /**
   * Emulates a guest cmd.exe batch: receives the generated .cmd text and
   * returns the lines the script would have written to its report. The fake
   * appends the host's per-invocation end marker, like cmd's final echo.
   */
  batch?: (script: string) => string;
}

/**
 * In-memory agent: records every request (to prove the verifier only issues
 * read-only ops) and answers from a script. Mirrors the real FakeBackend's
 * role in the Python test suite.
 */
export class FakeAgent {
  readonly requests: AgentRequest[] = [];
  private readonly script: FakeAgentScript;
  private unoIndex = 0;
  /** In-memory fake desktop: cell values the UIA "helper" mutations wrote. */
  readonly desktopCells = new Map<string, string>();
  private modified = false;
  /** Guest filesystem: scripts/reports written via write_file, then read. */
  private readonly files: Map<string, Buffer>;
  private readonly strays: Map<string, number[]>;

  constructor(script: FakeAgentScript) {
    this.script = script;
    this.files = script.writtenFiles ?? new Map<string, Buffer>();
    this.strays = new Map<string, number[]>(
      Object.entries(script.strayProcesses ?? {}).map(([image, pids]) => [image, [...pids]]),
    );
  }

  call(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    if (request.token !== "test-token") {
      return Promise.resolve({
        ok: false,
        id: request.id,
        error: { code: "AUTH_FAILED", message: "bad token" },
      });
    }
    return Promise.resolve(this.dispatch(request));
  }
  private dispatch(request: AgentRequest): AgentResponse {
    const fail = this.script.failOps?.includes(request.op);
    if (fail) {
      return {
        ok: false,
        id: request.id,
        error: { code: "OP_FAILED", message: `injected failure on ${request.op}` },
      };
    }
    switch (request.op) {
      case "ping":
        return { ok: true, id: request.id, result: { agent_version: "0.1.0", session_id: "s1" } };
      case "session_info":
        return {
          ok: true,
          id: request.id,
          result: { session_id: 1, window_station: "WinSta0", desktop: "Default", user: "myco" },
        };
      case "uno_eval": {
        const params = request.params as Record<string, unknown>;
        // Helper mutations shadow the scripted behavior (opt-in via
        // `desktopOverlay`) — otherwise scripted verdicts stay deterministic
        // for the verifier tests.
        const written = this.script.desktopOverlay
          ? this.desktopCells.get(String(params.cell))
          : undefined;
        if (written !== undefined && params.call === "get_string") {
          return { ok: true, id: request.id, result: unoResult(written, params) };
        }
        if (this.script.desktopOverlay && params.call === "is_modified") {
          return { ok: true, id: request.id, result: unoResult(this.modified, params) };
        }
        if (this.script.unoBehavior) {
          const out = this.script.unoBehavior(params);
          if (out === "error") {
            return {
              ok: false,
              id: request.id,
              error: { code: "OP_FAILED", message: "UNO socket unreachable" },
            };
          }
          return { ok: true, id: request.id, result: unoResult(out, params) };
        }
        const step = this.script.unoEval?.[this.unoIndex] ?? { get_string: "" };
        this.unoIndex++;
        if (step === "error") {
          return {
            ok: false,
            id: request.id,
            error: { code: "OP_FAILED", message: "UNO socket unreachable" },
          };
        }
        return { ok: true, id: request.id, result: step };
      }
      case "launch": {
        const argv = (request.params.argv ?? []) as string[];
        // Guest hygiene batches (M1-019): the host writes a .cmd, then
        // launches cmd.exe /c on it; emulate the batch's report output.
        if (argv[0] === "cmd.exe" && argv[1] === "/c") {
          const scriptPath = argv[2] ?? "";
          const script = this.files.get(scriptPath)?.toString("utf8") ?? "";
          const body = this.script.batch?.(script) ?? "";
          const marker = script.match(/echo\s+(__MYCO_BATCH_END__\S+)>>/)?.[1] ?? GUEST_BATCH_END;
          const reportPath = scriptPath.replace(/\.cmd$/, ".out");
          this.files.set(reportPath, Buffer.from(`${body}${marker}\r\n`, "utf8"));
          return { ok: true, id: request.id, result: { pid: 9999 } };
        }
        // Model the deployed UIA helper: argv is [python, script, <json cmd>, out].
        const helperArg = argv.find((a) => a.includes('"op"'));
        if (helperArg) {
          try {
            const cmd = JSON.parse(helperArg) as {
              op: string;
              cell?: string;
              text?: string;
              keys?: string;
            };
            if (cmd.op === "nametype" && cmd.cell && cmd.text) {
              this.desktopCells.set(cmd.cell, cmd.text);
              this.modified = true;
            }
            if (cmd.op === "save" || (cmd.op === "keys" && cmd.keys === "{Ctrl}s")) {
              this.modified = false;
            }
          } catch {
            // not a helper command — plain launch
          }
        }
        return { ok: true, id: request.id, result: { pid: 4242 } };
      }
      case "kill": {
        const params = request.params as { pid?: number; image_name?: string };
        let killed: Array<number | string>;
        if (params.image_name !== undefined) {
          killed = this.strays.get(params.image_name) ?? [];
          this.strays.delete(params.image_name);
        } else {
          killed = params.pid === undefined ? [] : [params.pid];
        }
        return { ok: true, id: request.id, result: { killed } };
      }
      case "write_file": {
        const { path, data_b64 } = request.params as { path: string; data_b64: string };
        const bytes = Buffer.from(data_b64, "base64");
        this.files.set(path, bytes);
        this.script.writtenFiles?.set(path, bytes);
        return { ok: true, id: request.id, result: { bytes: data_b64.length / 2 } };
      }
      case "read_file": {
        const { path } = request.params as { path: string };
        // The deployed UIA helper writes `<script>.result.json`; the fake
        // models that write as an implicit side effect of read_file.
        if (path.endsWith(".result.json")) {
          return {
            ok: true,
            id: request.id,
            result: { data_b64: Buffer.from('{"ok": true}', "utf8").toString("base64") },
          };
        }
        const stored = this.files.get(path);
        if (stored !== undefined) {
          return { ok: true, id: request.id, result: { data_b64: stored.toString("base64") } };
        }
        if (this.script.readFileError) {
          return {
            ok: false,
            id: request.id,
            error: { code: "OP_FAILED", message: "file not found" },
          };
        }
        const bytes = this.script.csvBytes ?? Buffer.from("");
        return { ok: true, id: request.id, result: { data_b64: bytes.toString("base64") } };
      }
      default:
        return {
          ok: false,
          id: request.id,
          error: { code: "UNKNOWN_OP", message: `op ${request.op} not faked` },
        };
    }
  }
}

/** An agent that never answers — connection refused / timeout shape. */
export class UnreachableAgent {
  call(_request: AgentRequest): Promise<AgentResponse> {
    return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8765"));
  }
}

/**
 * Shape a `unoBehavior` answer into the deployed agent's result shape:
 * strings become `{call, cell, value}`, booleans `{call, value: <bool>}`
 * (is_modified), UnoEvalResult objects pass through.
 */
function unoResult(
  out: string | boolean | UnoEvalResult,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof out === "boolean") {
    return { call: params.call, value: out };
  }
  if (typeof out === "string") {
    return { call: params.call, cell: params.cell, value: out };
  }
  return out as Record<string, unknown>;
}
