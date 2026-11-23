import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeTransport } from "../../src/discovery/runtime-transport.ts";

function transport(log: string): RuntimeTransport {
  return new RuntimeTransport({
    binary: process.execPath,
    args: [join(import.meta.dirname, "fake-mcp-server.mjs")],
    cwd: join(import.meta.dirname, "..", ".."),
    readRoot: "/home/myco",
    introspectionPath: "state.json",
    sessionId: "s0-test",
    timeoutMs: 10_000,
  });
}

describe("runtime MCP transport", () => {
  it("creates, observes the app's published state, acts, reads the store, resets and destroys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-mcp-"));
    const log = join(dir, "calls.log");
    process.env.FAKE_MCP_LOG = log;
    const t = transport(log);
    await t.initialize();
    const session = await t.create();
    expect(session.id).toBe("s0-test");
    const observation = await t.observe();
    expect(observation.stateVersion).toBe(7);
    expect(observation.listRows).toEqual(["a", "b"]);
    expect(observation.statusText).toBe("saved 2 item(s)");
    expect(await t.act(session, { kind: "typeTextGlobal", text: "x" })).toBe(
      "delivered_unverified",
    );
    expect(await t.act(session, { kind: "clickAt", x: 1, y: 2 })).toBe("delivered_unverified");
    expect(await t.readFile(session, "store.json")).toContain('"a"');
    await t.reset();
    await t.destroy();
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain('create {"session_id":"s0-test","read_root":"/home/myco"}');
    expect(calls).toContain('"kind":"typeTextGlobal"');
    expect(calls).toContain('"kind":"clickAt"');
    expect(calls).toContain("reset");
    expect(calls).toContain("destroy");
  });
});
