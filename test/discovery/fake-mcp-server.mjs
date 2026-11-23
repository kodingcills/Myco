#!/usr/bin/env node
// Minimal MCP stdio server for the RuntimeTransport test. It records every
// tools/call to FAKE_MCP_LOG and answers with canned payloads.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_MCP_LOG;
const send = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError: false,
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake", version: "0" },
    });
    return;
  }
  if (message.method !== "tools/call") return;
  const { name, arguments: args } = message.params;
  if (log) appendFileSync(log, `${name} ${JSON.stringify(args)}\n`);
  if (name === "create") return send(message.id, text({ ok: true, session_id: args.session_id }));
  if (name === "observe") return send(message.id, text({ ok: true, state_version: 7 }));
  if (name === "act") return send(message.id, text({ ok: true, outcome: "delivered_unverified" }));
  if (name === "read_file") {
    if (args.path === "state.json") {
      const state = { entry_text: "", listbox_rows: ["a", "b"], status_text: "saved 2 item(s)" };
      return send(
        message.id,
        text({ ok: true, content_base64: Buffer.from(JSON.stringify(state)).toString("base64") }),
      );
    }
    const store = { items: [{ text: "a" }, { text: "b" }] };
    return send(
      message.id,
      text({ ok: true, content_base64: Buffer.from(JSON.stringify(store)).toString("base64") }),
    );
  }
  if (name === "reset" || name === "destroy") return send(message.id, text({ ok: true }));
  send(message.id, {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown" }) }],
    isError: true,
  });
});
