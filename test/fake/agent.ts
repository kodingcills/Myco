/**
 * Fake myco-agent for the UNO verifier tests (M1-007). A scriptable NDJSON
 * agent speaking the agent/README.md protocol, so the verifier is exercised
 * against the real wire shape (request lines → response lines), not mocks of
 * its own interfaces.
 */

import type { AgentRequest, AgentResponse, UnoEvalResult } from "../../src/win/agent-client.ts";

export interface FakeAgentScript {
  /** Responses for uno_eval, in order. */
  unoEval: ("error" | UnoEvalResult)[];
  /** CSV bytes returned by read_file (the converted persisted file). */
  csvBytes?: Buffer;
  /** When set, read_file fails (persisted file unreadable). */
  readFileError?: boolean;
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

  constructor(script: FakeAgentScript) {
    this.script = script;
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
    switch (request.op) {
      case "ping":
        return { ok: true, id: request.id, result: { agent_version: "0.1.0", session_id: "s1" } };
      case "uno_eval": {
        const step = this.script.unoEval[this.unoIndex] ?? { get_string: "" };
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
      case "launch":
        return { ok: true, id: request.id, result: { pid: 4242 } };
      case "read_file": {
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
