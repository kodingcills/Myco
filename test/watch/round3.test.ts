/**
 * Live watch view, verifier round 2 findings (PR #513):
 *  - D3: the 127.0.0.2 Host allowlist is pinned without binding 127.0.0.2 (macOS lo0 has only
 *    127.0.0.1), see also the probing test in round2.test.ts;
 *  - OWN-B: a watcher that stalls once and recovers is not dropped later;
 *  - OWN-G: the server really passes the host needles to the frame scan;
 *  - N1: clients that stop reading plain responses are bounded (connection cap, idle timeout);
 *  - N2: a multi-byte UTF-8 character split across two read chunks is decoded intact.
 */
import { writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionLogTail } from "../../src/watch/decision-log.ts";
import type { FrameSource } from "../../src/watch/frames.ts";
import {
  allowedHostHeaders,
  startWatchServer,
  type WatchServer,
  type WatchState,
} from "../../src/watch/server.ts";
import { raw, tempDir } from "./helpers.ts";

const open: WatchServer[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serve(opts: Parameters<typeof startWatchServer>[0]): Promise<WatchServer> {
  const server = await startWatchServer({ pollMs: 20, ...opts });
  open.push(server);
  return server;
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decision(runId: string, i: number): string {
  return JSON.stringify({
    apiVersion: "myco.gate/v1",
    verdict: i % 2 === 0 ? "refuted" : "verified",
    accepted: i % 2 === 1,
    reasonCodes: ["ORACLE_FAIL", "TARGET_MISMATCH"],
    request: { taskId: "task-a", runId, claim: "x" },
    checkpoints: {
      total: 2,
      lastVerified: 1,
      verdicts: [
        { checkpoint: 1, verdict: "verified" },
        { checkpoint: 2, verdict: "refuted" },
      ],
    },
    checkedAt: "2026-11-26T12:00:00.000Z",
  });
}

function bigLog(n: number): string {
  const log = join(tempDir(), "log.jsonl");
  writeFileSync(log, `${Array.from({ length: n }, (_, i) => decision("run-a", i)).join("\n")}\n`);
  return log;
}

/** A raw connection that is tracked for cleanup. */
function socketTo(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => resolve(sock));
    sock.on("error", () => {});
    sockets.push(sock);
  });
}

describe("D3: the bind host's own Host header, without binding it", () => {
  it("allowedHostHeaders admits the loopback names and the bind host, each only with the port", () => {
    const hosts = allowedHostHeaders("127.0.0.2", 4321);
    expect([...hosts].sort()).toEqual(
      ["127.0.0.1:4321", "127.0.0.2:4321", "[::1]:4321", "localhost:4321"].sort(),
    );
    expect(hosts.has("127.0.0.2")).toBe(false);
    expect(hosts.has("127.0.0.3:4321")).toBe(false);
    expect(allowedHostHeaders("::1", 80).has("[::1]:80")).toBe(true);
    expect(allowedHostHeaders("::1", 80).has("::1:80")).toBe(false);
    expect(allowedHostHeaders("LOCALHOST", 9).has("localhost:9")).toBe(true);
  });

  it("the server enforces exactly that set (127.0.0.1 bind: 127.0.0.2 Host refused)", async () => {
    const s = await serve({ runs: ["r"] });
    expect(
      (await raw(s.port, "/api/state", { headers: { Host: `127.0.0.1:${s.port}` } })).status,
    ).toBe(200);
    expect(
      (await raw(s.port, "/api/state", { headers: { Host: `127.0.0.2:${s.port}` } })).status,
    ).toBe(421);
  });
});

describe("OWN-B: recovering from a stall resets the stall clock", () => {
  it("a watcher that stalls once, then drains, is still connected well after sseStallMs", async () => {
    const stallMs = 2500;
    const log = bigLog(3000);
    const s = await serve({
      runs: ["run-a"],
      decisionLog: log,
      pollMs: 10,
      maxEvents: 3000,
      sseStallMs: stallMs,
      sseMaxBufferedBytes: 1024 * 1024 * 1024,
    });
    const states: WatchState[] = [];
    let buffer = "";
    const sock = await socketTo(s.port);
    sock.setEncoding("latin1");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const data = buffer
          .slice(0, at)
          .split("\n")
          .find((l) => l.startsWith("data: "));
        buffer = buffer.slice(at + 2);
        if (data) states.push(JSON.parse(data.slice(6)) as WatchState);
        at = buffer.indexOf("\n\n");
      }
    });
    sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
    await until(() => states.length > 0);

    // Stall: stop reading until the server records that this watcher stopped draining.
    sock.pause();
    let seq = 3000;
    for (let i = 0; i < 200 && s.sse().stalls === 0; i++) {
      writeFileSync(log, `${decision("run-a", seq++)}\n`, { flag: "a" });
      await sleep(15);
    }
    expect(s.sse().stalls).toBeGreaterThanOrEqual(1);
    expect(s.sse().dropped).toBe(0);
    // Recover: read again and catch up.
    sock.resume();
    await until(() => states.at(-1)?.events.at(-1)?.seq === seq);

    // Keep it healthy for twice the stall limit; it must not be dropped for the old stall.
    const end = Date.now() + 2 * stallMs;
    while (Date.now() < end) {
      writeFileSync(log, `${decision("run-a", seq++)}\n`, { flag: "a" });
      await sleep(100);
    }
    await until(() => states.at(-1)?.events.at(-1)?.seq === seq);
    expect(s.sse().dropped).toBe(0);
    expect(s.sse().clients).toBe(1);
  }, 60_000);
});

describe("OWN-G: the server's host needles reach the frame scan", () => {
  it("a rendered frame naming /<this user> (no trailing slash, so no generic pattern) is refused", async () => {
    const user = userInfo().username;
    expect(user.length).toBeGreaterThanOrEqual(3);
    const svg = (text: string) =>
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`);
    const frames: FrameSource = {
      count: () => 2,
      read: (_run, index) => ({
        bytes: index === 0 ? svg("checkpoint 1") : svg(`at /${user} now`),
        contentType: "image/svg+xml",
        provenance: "rendered",
      }),
    };
    const s = await serve({ runs: ["r"], frames });
    expect((await raw(s.port, "/frames/r/0")).status).toBe(200);
    expect((await raw(s.port, "/frames/r/1")).status).toBe(404);
  });
});

describe("N1: clients that stop reading plain responses are bounded", () => {
  it("connections beyond maxConnections are closed at once", async () => {
    const s = await serve({ runs: ["r"], maxConnections: 2 });
    await socketTo(s.port);
    await socketTo(s.port);
    await until(async () => (await s.connections()) === 2);
    const third = await socketTo(s.port);
    const outcome = await new Promise<string>((resolve) => {
      let text = "";
      third.setEncoding("latin1");
      third.on("data", (c: string) => {
        text += c;
      });
      third.on("close", () => resolve(text === "" ? "closed-empty" : text.slice(0, 12)));
      third.write(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
    });
    expect(outcome).toBe("closed-empty");
    expect(await s.connections()).toBe(2);
  });

  it("a client that pipelines large GETs and never reads is destroyed after idleSocketMs", async () => {
    const s = await serve({
      runs: ["run-a"],
      decisionLog: bigLog(3000),
      maxEvents: 3000,
      idleSocketMs: 300,
    });
    await until(() => s.state().events.length === 3000);
    expect(JSON.stringify(s.state()).length).toBeGreaterThan(200 * 1024);
    const sock = await socketTo(s.port);
    sock.pause();
    const request = `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`;
    sock.write(request.repeat(40));
    await until(async () => (await s.connections()) === 1, 5_000);
    // The responses (~40 x the state) stop moving once the socket buffers fill; the idle
    // timeout then destroys the connection, freeing what it held.
    await until(async () => (await s.connections()) === 0, 5_000);
  }, 30_000);
});

describe("N2: UTF-8 split across read chunks", () => {
  it("a two-byte character straddling the 256 KiB chunk boundary is decoded intact", () => {
    const CHUNK = 256 * 1024;
    const head = '{"claim":"';
    // Put "é" (C3 A9) at bytes CHUNK-1 and CHUNK.
    const claim = `${"a".repeat(CHUNK - 1 - head.length)}é tail`;
    const line = `${head}${claim}"}\n`;
    expect(
      Buffer.from(line)
        .subarray(CHUNK - 1, CHUNK + 1)
        .toString("hex"),
    ).toBe("c3a9");
    const log = join(tempDir(), "log.jsonl");
    writeFileSync(log, `${line}{"claim":"next ü"}\n`);
    const tail = new DecisionLogTail(log);
    tail.poll();
    const { records, malformed } = tail.snapshot();
    expect(malformed).toBe(0);
    expect((records[0] as { claim: string }).claim).toBe(claim);
    expect((records[1] as { claim: string }).claim).toBe("next ü");
  });
});
