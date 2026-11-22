import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type Mcp, record } from "./c1.ts";

/** Attach to an operator-provided MCP stdio session. Owns no guest lifecycle. */
export function mcpStdio(input: Writable, output: Readable): Mcp & { close(): void } {
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let nextId = 0;
  let closed = false;
  let pending: { id: number; finish(result?: unknown): void } | undefined;
  function close() {
    closed = true;
    pending?.finish();
    lines.close();
  }
  lines.on("close", close);
  input.on("error", close);
  output.on("error", close);
  lines.on("line", (line) => {
    try {
      const response = record(JSON.parse(line));
      if (pending && response.id === pending.id && response.jsonrpc === "2.0")
        pending.finish(response.error === undefined ? response.result : undefined);
    } catch {
      close();
    }
  });

  async function send(message: object) {
    if (closed) throw new Error("MCP session closed");
    await new Promise<void>((resolve, reject) => {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, (error) => {
        if (error) reject(new Error("MCP write failed"));
        else resolve();
      });
    });
  }
  return {
    close,
    notify: (method) => send({ method }),
    async request(method, params) {
      if (closed || pending) throw new Error("MCP session unavailable");
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(close, 30_000);
        pending = {
          id,
          finish(result) {
            clearTimeout(timer);
            pending = undefined;
            if (result === undefined) reject(new Error("MCP request failed"));
            else resolve(result);
          },
        };
        void send({ id, method, params }).catch(close);
      });
    },
  };
}
