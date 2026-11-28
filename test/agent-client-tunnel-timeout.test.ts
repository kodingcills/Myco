/**
 * TIF-216: `AgentClient.overTunnel(tunnel, { timeoutMs })` must govern every
 * call. Before the fix it ignored `timeoutMs`, so run-live's 60 s limit was
 * silently the tunnel's 15 s default and two row-8 trials timed out.
 *
 * Scaled down: the tunnel's own timeout is 50 ms, the configured one 400 ms,
 * and the fake agent answers after 150 ms. No real ssh, no port 8765, no VM:
 * the "ssh" child is a stub that just sleeps, and the agent is a local
 * NDJSON server on an ephemeral port.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentClient, AgentUnreachableError, SshTunnel } from "../src/win/agent-client.ts";

const TUNNEL_TIMEOUT_MS = 50;
const CONFIGURED_TIMEOUT_MS = 400;
const AGENT_DELAY_MS = 150;

let dir: string;
let server: Server;
let port: number;
const sockets = new Set<Socket>();
const tunnels: SshTunnel[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myco-tunnel-timeout-"));
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number };
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(
          `${JSON.stringify({ ok: true, id: request.id, result: { agent_version: "t", session_id: "s" } })}\n`,
        );
      }, AGENT_DELAY_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) await tunnel.stop();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function startTunnel(): Promise<SshTunnel> {
  const script = join(dir, "fake-ssh");
  writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(script, 0o755);
  const tunnel = new SshTunnel({ sshPath: script, localPort: port, timeoutMs: TUNNEL_TIMEOUT_MS });
  tunnels.push(tunnel);
  await tunnel.start(5_000);
  return tunnel;
}

describe("AgentClient.overTunnel timeout (TIF-216)", () => {
  it("the configured timeoutMs governs a tunnel call, not the tunnel's default", async () => {
    const tunnel = await startTunnel();
    const client = AgentClient.overTunnel(tunnel, {
      token: "test-token",
      timeoutMs: CONFIGURED_TIMEOUT_MS,
    });
    await expect(client.ping()).resolves.toMatchObject({ agent_version: "t" });
  });

  it("without a configured timeoutMs, the tunnel's own timeout still applies", async () => {
    const tunnel = await startTunnel();
    const client = AgentClient.overTunnel(tunnel, { token: "test-token" });
    const error = await client.ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentUnreachableError);
    expect(String(error)).toContain(`timed out after ${TUNNEL_TIMEOUT_MS}ms`);
  });
});

describe("AgentClient constructor config (TIF-216)", () => {
  it("rejects timeoutMs at compile time: it could not be applied to an arbitrary transport", () => {
    const transport = { call: () => Promise.reject(new Error("unused")) };
    // @ts-expect-error timeoutMs is not accepted by the plain constructor.
    const client = new AgentClient(transport, { token: "t", timeoutMs: 1 });
    expect(client).toBeInstanceOf(AgentClient);
  });
});
