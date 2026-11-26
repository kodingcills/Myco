/**
 * Live watch view, verifier round 1 defects and survivors (PR #513):
 *  - D1: frame CONTENTS (not just names) never carry a planted marker or a host path into a
 *    response: SVG text, PNG text/metadata chunks, palette bytes, bytes after IEND, other
 *    image types, and text stored verbatim in pixel bytes;
 *  - D2: slow or stalled SSE watchers cannot grow server memory without bound;
 *  - OWN-1/2/3/4/6/7 and the nits ([::1] bind, 127.0.0.2 Host).
 */
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { projectDecisions } from "../../src/watch/events.ts";
import {
  directoryFrameSource,
  type FrameSource,
  readRegular,
  renderedFrameSource,
  resolveListed,
} from "../../src/watch/frames.ts";
import {
  frameLeaks,
  hostNeedles,
  needlesFor,
  sanitizePng,
  servableFrame,
} from "../../src/watch/sanitize-frame.ts";
import {
  MAX_SSE_CLIENTS,
  startWatchServer,
  type WatchServer,
  type WatchState,
} from "../../src/watch/server.ts";
import { encodePng, MARKER, PNG, pngChunk, raw, tempDir } from "./helpers.ts";

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

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The verifier's style of fake absolute path (never exists). */
const HOST_PATH = `/Users/fakeuser-${process.pid}/secret/path`;
const PLANT = `${MARKER} ${HOST_PATH}`;

function chunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    types.push(png.toString("latin1", at + 4, at + 8));
    at += 12 + length;
  }
  return types;
}

/** The decoded scanlines (filtered) of a sanitized PNG: concatenated IDAT, inflated. */
function idatOf(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return inflateSync(Buffer.concat(parts));
}

/** A deterministic high-entropy byte stream (so deflate cannot compress it). */
function noise(n: number): Buffer {
  const blocks: Buffer[] = [];
  for (let i = 0; blocks.length * 32 < n; i++)
    blocks.push(createHash("sha256").update(`noise-${i}`).digest());
  return Buffer.concat(blocks).subarray(0, n);
}

const CLEAN_RAW = Buffer.from([
  0, 10, 20, 30, 255, 40, 50, 60, 255, 0, 70, 80, 90, 255, 1, 2, 3, 4,
]);
const clean = () => encodePng({ width: 2, height: 2, colorType: 6, raw: CLEAN_RAW });

/** Text and metadata chunks a screenshot tool might write, each carrying the plant. */
function plantedMetadataPng(): Buffer {
  const text = Buffer.from(`Comment\0${PLANT}`, "latin1");
  return encodePng({
    width: 2,
    height: 2,
    colorType: 6,
    raw: CLEAN_RAW,
    extra: [
      pngChunk("tEXt", text),
      pngChunk("iTXt", Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${PLANT}`, "latin1")),
      pngChunk("zTXt", Buffer.from(`Source\0\0${PLANT}`, "latin1")),
      pngChunk("eXIf", Buffer.from(`MM\0*${PLANT}`, "latin1")),
      pngChunk("prVt", Buffer.from(PLANT, "latin1")),
      // A truecolor image may carry a suggested palette: never needed, never passed.
      pngChunk("PLTE", Buffer.from(`${MARKER}xx`.padEnd(30, "x"), "latin1")),
    ],
    trailer: Buffer.from(PLANT, "latin1"),
  });
}

/** A palette image whose palette bytes spell the plant. */
function plantedPalettePng(): Buffer {
  const palette = Buffer.from(PLANT.padEnd(Math.ceil(PLANT.length / 3) * 3, "_"), "latin1");
  // 4x1, 8-bit indices 0..3
  return encodePng({
    width: 4,
    height: 1,
    colorType: 3,
    raw: Buffer.from([0, 0, 1, 2, 3]),
    palette,
    trns: Buffer.from([255, 128]),
  });
}

/** Pixel bytes deflate must store verbatim (noise), with the plant spliced into a row. */
function plantedStoredPng(): Buffer {
  const width = 64;
  const height = 64;
  const rowBytes = width * 3;
  const rawRows = Buffer.alloc(height * (rowBytes + 1));
  noise(rawRows.length).copy(rawRows);
  for (let y = 0; y < height; y++) rawRows[y * (rowBytes + 1)] = 0;
  Buffer.from(PLANT, "latin1").copy(rawRows, 10 * (rowBytes + 1) + 1);
  return encodePng({ width, height, colorType: 2, raw: rawRows, level: 0 });
}

describe("D1: frame contents never reach a response unredacted", () => {
  it("a sealed capture with the plant inside SVG, PNG chunks, palette, trailer, JPEG and pixel bytes leaks nothing", async () => {
    const vault = tempDir();
    const captured = join(vault, "run-a", "captured");
    mkdirSync(join(captured, "shots"), { recursive: true });
    writeFileSync(
      join(captured, "shots", "a.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><desc>${PLANT}</desc></svg>`,
    );
    writeFileSync(join(captured, "b.png"), plantedMetadataPng());
    writeFileSync(join(captured, "c.png"), plantedPalettePng());
    writeFileSync(join(captured, "d.png"), plantedStoredPng());
    writeFileSync(
      join(captured, "e.jpg"),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 60]), Buffer.from(PLANT)]),
    );
    writeFileSync(join(captured, "f.png"), clean());
    const s = await serve({
      runs: ["run-a"],
      frames: directoryFrameSource(vault, "sealed", new Set(["run-a"])),
    });
    // PNG only is listed: b, c, d, f (the SVG and the JPEG never are).
    expect(s.state().runs).toEqual([{ runId: "run-a", frames: 4 }]);
    const bodies: Buffer[] = [];
    for (const path of ["/api/state", ...[0, 1, 2, 3, 4, 5].map((i) => `/frames/run-a/${i}`)]) {
      const r = await raw(s.port, path);
      bodies.push(r.body, Buffer.from(JSON.stringify(r.headers)));
    }
    const all = Buffer.concat(bodies).toString("latin1");
    const forbidden = [MARKER, HOST_PATH, "/Users/", "fakeuser", homedir()];
    const user = userInfo().username;
    if (user.length >= 3) forbidden.push(`/${user}`);
    for (const needle of forbidden) expect(all.includes(needle), needle).toBe(false);
    // The metadata PNG is still shown: its pixels, rebuilt, with no chunk but IHDR/IDAT/IEND.
    const b = await raw(s.port, "/frames/run-a/0");
    expect(b.status).toBe(200);
    expect(b.headers["content-type"]).toBe("image/png");
    expect(chunkTypes(b.body)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(b.body.equals(sanitizePng(clean()) as Buffer)).toBe(true);
    // The palette PNG is shown expanded to RGBA: palette bytes are pixels now, not a chunk.
    const c = await raw(s.port, "/frames/run-a/1");
    expect(c.status).toBe(200);
    expect(chunkTypes(c.body)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(c.body[25]).toBe(6); // color type RGBA
  });

  it("sanitizePng rebuilds from pixels: drops every ancillary chunk and trailer, expands palettes", () => {
    const out = sanitizePng(plantedMetadataPng()) as Buffer;
    expect(chunkTypes(out)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(out.toString("latin1")).not.toContain(MARKER);
    expect(idatOf(out).equals(CLEAN_RAW)).toBe(true);
    // Idempotent: a rebuilt PNG rebuilds to itself.
    expect((sanitizePng(out) as Buffer).equals(out)).toBe(true);
    // Palette (with tRNS) expands to RGBA 8-bit, filter 0, the right colours.
    const pal = sanitizePng(plantedPalettePng()) as Buffer;
    expect(pal.toString("latin1")).not.toContain(MARKER);
    expect(chunkTypes(pal)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect([pal[24], pal[25]]).toEqual([8, 6]);
    const p = Buffer.from(PLANT, "latin1");
    expect([...idatOf(pal)]).toEqual([
      0,
      ...[p[0], p[1], p[2], 255],
      ...[p[3], p[4], p[5], 128],
      ...[p[6], p[7], p[8], 255],
      ...[p[9], p[10], p[11], 255],
    ]);
    // A 2-bit palette image unpacks its indices.
    const two = sanitizePng(
      encodePng({
        width: 3,
        height: 1,
        colorType: 3,
        bitDepth: 2,
        raw: Buffer.from([0, 0b00011000]),
        palette: Buffer.from([1, 1, 1, 2, 2, 2, 3, 3, 3]),
      }),
    ) as Buffer;
    expect(two[25]).toBe(2); // RGB
    expect([...idatOf(two)]).toEqual([0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it("sanitizePng refuses what it cannot rebuild safely", () => {
    const bad = (png: Buffer) => expect(sanitizePng(png)).toBeNull();
    bad(Buffer.from("not a png at all, just text"));
    bad(encodePng({ width: 2, height: 2, colorType: 6, raw: CLEAN_RAW, interlace: 1 }));
    bad(encodePng({ width: 2, height: 2, colorType: 6, raw: CLEAN_RAW.subarray(0, 10) }));
    bad(
      encodePng({
        width: 2,
        height: 2,
        colorType: 6,
        raw: CLEAN_RAW,
        extra: [pngChunk("ZZZZ", Buffer.from("x"))],
      }),
    );
    bad(
      encodePng({
        width: 4,
        height: 1,
        colorType: 3,
        raw: Buffer.from([0, 0, 1, 2, 9]),
        palette: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      }),
    );
    const badFilter = Buffer.from(CLEAN_RAW);
    badFilter[0] = 7;
    bad(encodePng({ width: 2, height: 2, colorType: 6, raw: badFilter }));
    // A bad CRC on a chunk that would otherwise be dropped unread still refuses the file.
    const withText = encodePng({
      width: 2,
      height: 2,
      colorType: 6,
      raw: CLEAN_RAW,
      extra: [pngChunk("tEXt", Buffer.from("Comment\0hello", "latin1"))],
    });
    expect(sanitizePng(withText)).not.toBeNull();
    const corrupt = Buffer.from(withText);
    corrupt[41] = (corrupt[41] as number) ^ 0xff; // first data byte of the tEXt chunk (after the 33-byte header)
    bad(corrupt);
    bad(clean().subarray(0, clean().length - 12)); // no IEND
    expect(sanitizePng(PNG)).not.toBeNull();
  });

  it("text stored verbatim in pixel bytes is refused by the backstop scan", () => {
    const rebuilt = sanitizePng(plantedStoredPng()) as Buffer;
    // Deflate stores incompressible noise as-is, so the rebuilt bytes still carry the plant
    // (the precondition this test needs)...
    expect(rebuilt.toString("latin1")).toContain(MARKER);
    expect(frameLeaks(rebuilt, true, [])).toBe(true);
    // ...which servableFrame therefore never serves.
    expect(
      servableFrame(
        { bytes: plantedStoredPng(), contentType: "image/png", provenance: "file" },
        [],
      ),
    ).toBeNull();
  });

  it("frameLeaks: host needles, absolute host paths, key prefixes, and text runs in binary", () => {
    const b = (s: string) => Buffer.from(`\x89\x01${s}\x02\xff`, "latin1");
    expect(frameLeaks(b("abc"), true, [])).toBe(false);
    expect(frameLeaks(b("x/opt-in-zz"), true, ["/opt-in-zz"])).toBe(true);
    for (const leak of [
      "/Users/x/",
      "/home/x/",
      "/srv/x/",
      "C:\\Users\\x\\",
      "\\\\host\\share",
      "sk-ant-x",
      "ghp_x",
      "-----BEGIN ",
    ])
      expect(frameLeaks(b(leak), false, []), leak).toBe(true);
    expect(frameLeaks(b(MARKER), true, [])).toBe(true); // a 16+ char text run in binary
    expect(frameLeaks(b(MARKER), false, [])).toBe(false); // rendered SVG is text by design
    expect(frameLeaks(b("ABCDEFGHIJKLMNO"), true, [])).toBe(false); // 15 chars: below the run
    expect(needlesFor({ home: "/h/aaaa", tmp: "/t/bbbb", user: "cccc" }).sort()).toEqual(
      ["/cccc", "/h/aaaa", "/t/bbbb", "\\cccc"].sort(),
    );
    expect(needlesFor({ home: "/h", user: "ab" })).toEqual([]); // too short to be specific
    const needles = hostNeedles();
    expect(needles).toContain(homedir());
    if (userInfo().username.length >= 3) expect(needles).toContain(`/${userInfo().username}`);
  });

  it("servableFrame: SVG only when rendered in-process; other types refused; rendered SVG still scanned", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>mock</text></svg>');
    expect(
      servableFrame({ bytes: svg, contentType: "image/svg+xml", provenance: "file" }, []),
    ).toBeNull();
    expect(
      servableFrame({ bytes: svg, contentType: "image/svg+xml", provenance: "rendered" }, [])
        ?.bytes,
    ).toEqual(svg);
    const pathSvg = Buffer.from(`<svg><text>${HOST_PATH}</text></svg>`);
    expect(
      servableFrame({ bytes: pathSvg, contentType: "image/svg+xml", provenance: "rendered" }, []),
    ).toBeNull();
    for (const contentType of ["image/jpeg", "image/gif", "image/webp", "text/html"])
      expect(
        servableFrame({ bytes: PNG, contentType, provenance: "file" }, []),
        contentType,
      ).toBeNull();
  });

  it("file frame sources list PNG only; the rendered source serves only listed runs", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "run-a"));
    for (const name of ["1.svg", "2.jpg", "3.jpeg", "4.gif", "5.webp", "6.png"])
      writeFileSync(join(dir, "run-a", name), PNG);
    const src = directoryFrameSource(dir, "per-run", new Set(["run-a"]));
    expect(src.count("run-a")).toBe(1);
    expect(src.read("run-a", 0)?.provenance).toBe("file");
    const rendered = renderedFrameSource(new Set(["run-a"]));
    rendered.push("run-a", "<svg/>");
    rendered.push("run-b", "<svg/>");
    expect([rendered.count("run-a"), rendered.count("run-b")]).toEqual([1, 0]);
    expect(rendered.read("run-a", 0)?.provenance).toBe("rendered");
    expect(rendered.read("run-b", 0)).toBeNull();
  });
});

/** A decision line for run `runId` (padded so each event is a realistic size). */
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

/** An SSE watcher that connects and then never reads. */
function stalledWatcher(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      sock.pause();
      resolve(sock);
    });
    sock.on("error", () => {});
    sockets.push(sock);
  });
}

/** A reading SSE watcher; `pause()`/`resume()` simulate a slow one. */
function watcher(port: number) {
  const states: WatchState[] = [];
  let buffer = "";
  let sock: Socket | undefined;
  const ready = new Promise<void>((resolve) => {
    sock = connect(port, "127.0.0.1", () => {
      sock?.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      resolve();
    });
    sock.on("error", () => {});
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
    sockets.push(sock);
  });
  return {
    ready,
    states,
    pause: () => sock?.pause(),
    resume: () => sock?.resume(),
  };
}

describe("D2: slow or stalled SSE watchers cannot grow memory without bound", () => {
  it("a watcher that never reads holds at most about one state message, however many updates land", async () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    const initial = 3000;
    writeFileSync(
      log,
      `${Array.from({ length: initial }, (_, i) => decision("run-a", i)).join("\n")}\n`,
    );
    const s = await serve({
      runs: ["run-a"],
      tasks: ["task-a"],
      decisionLog: log,
      pollMs: 10,
      maxEvents: initial,
      sseStallMs: 120_000,
      sseMaxBufferedBytes: 1024 * 1024 * 1024, // the hard cap is tested on its own below
    });
    await stalledWatcher(s.port);
    const healthy = watcher(s.port);
    await healthy.ready;
    await until(() => s.sse().clients === 2);
    const stateBytes = JSON.stringify(s.state()).length;
    let pushed = 0;
    for (let i = 0; i < 60; i++) {
      writeFileSync(log, `${decision("run-a", initial + i)}\n`, { flag: "a" });
      await until(() => s.state().events.at(-1)?.seq === initial + i + 1);
      pushed += stateBytes;
      await new Promise((r) => setTimeout(r, 5));
    }
    // Far more was published than any kernel buffer holds...
    expect(pushed).toBeGreaterThan(40 * 1024 * 1024);
    // ...yet no watcher ever held more than about one message unsent.
    expect(s.sse().maxBufferedBytes).toBeLessThan(2 * stateBytes + 64 * 1024);
    // The healthy watcher still ends on the latest state.
    await until(() => healthy.states.at(-1)?.events.at(-1)?.seq === initial + 60);
    expect(s.sse().clients).toBe(2);
  }, 60_000);

  it("a slow watcher that catches up receives the latest state (updates coalesce, none is lost at the end)", async () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    writeFileSync(
      log,
      `${Array.from({ length: 3000 }, (_, i) => decision("run-a", i)).join("\n")}\n`,
    );
    const s = await serve({ runs: ["run-a"], decisionLog: log, pollMs: 10, maxEvents: 3000 });
    const slow = watcher(s.port);
    await slow.ready;
    await until(() => slow.states.length > 0);
    slow.pause();
    for (let i = 0; i < 25; i++) {
      writeFileSync(log, `${decision("run-a", 3000 + i)}\n`, { flag: "a" });
      await until(() => s.state().events.at(-1)?.seq === 3000 + i + 1);
    }
    slow.resume();
    await until(() => slow.states.at(-1)?.events.at(-1)?.seq === 3025, 20_000);
    expect(slow.states.at(-1)).toEqual(s.state());
    // Coalesced: it was not sent all 25 intermediate states.
    expect(slow.states.length).toBeLessThan(26);
  }, 60_000);

  it("a watcher stalled longer than sseStallMs is disconnected and its slot freed", async () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    writeFileSync(
      log,
      `${Array.from({ length: 3000 }, (_, i) => decision("run-a", i)).join("\n")}\n`,
    );
    const s = await serve({
      runs: ["run-a"],
      decisionLog: log,
      pollMs: 10,
      maxEvents: 3000,
      sseStallMs: 200,
    });
    const sock = await stalledWatcher(s.port);
    let closed = false;
    sock.on("close", () => {
      closed = true;
    });
    await until(() => s.sse().clients === 1);
    for (let i = 0; i < 40 && s.sse().dropped === 0; i++) {
      writeFileSync(log, `${decision("run-a", 3000 + i)}\n`, { flag: "a" });
      await new Promise((r) => setTimeout(r, 30));
    }
    await until(() => s.sse().clients === 0 && s.sse().dropped === 1, 20_000);
    // The server really closed the connection: once the watcher reads again, it sees the end.
    sock.resume();
    await until(() => closed);
  }, 60_000);

  it("a watcher holding more than sseMaxBufferedBytes unsent is disconnected", async () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    writeFileSync(
      log,
      `${Array.from({ length: 3000 }, (_, i) => decision("run-a", i)).join("\n")}\n`,
    );
    const s = await serve({
      runs: ["run-a"],
      decisionLog: log,
      pollMs: 10,
      maxEvents: 3000,
      sseStallMs: 120_000,
      sseMaxBufferedBytes: 64 * 1024,
    });
    await stalledWatcher(s.port);
    await until(() => s.sse().clients === 1 || s.sse().dropped === 1);
    for (let i = 0; i < 40 && s.sse().dropped === 0; i++) {
      writeFileSync(log, `${decision("run-a", 3000 + i)}\n`, { flag: "a" });
      await new Promise((r) => setTimeout(r, 30));
    }
    await until(() => s.sse().dropped === 1 && s.sse().clients === 0);
  }, 60_000);

  it("the state carries at most maxEvents (the latest), counting the rest as omitted", async () => {
    const dir = tempDir();
    const log = join(dir, "log.jsonl");
    writeFileSync(
      log,
      `${Array.from({ length: 30 }, (_, i) => decision("run-a", i)).join("\n")}\n`,
    );
    const s = await serve({ runs: ["run-a"], decisionLog: log, maxEvents: 10 });
    const state = JSON.parse((await raw(s.port, "/api/state")).body.toString()) as WatchState;
    expect(state.events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(state.omitted).toBe(20);
  });

  it(`at most ${MAX_SSE_CLIENTS} SSE watchers; the next gets 503 (OWN-2)`, async () => {
    const s = await serve({ runs: ["r"] });
    for (let i = 0; i < MAX_SSE_CLIENTS; i++) await watcher(s.port).ready;
    await until(() => s.sse().clients === MAX_SSE_CLIENTS);
    expect(MAX_SSE_CLIENTS).toBe(16);
    const extra = await raw(s.port, "/api/events", { maxMs: 300 });
    expect(extra.status).toBe(503);
    expect(s.sse().clients).toBe(MAX_SSE_CLIENTS);
  });
});

describe("round 1 survivors and nits", () => {
  it("Origin: null is refused (OWN-3)", async () => {
    const s = await serve({ runs: ["r"] });
    expect((await raw(s.port, "/api/state", { headers: { origin: "null" } })).status).toBe(403);
    expect(
      (await raw(s.port, "/api/events", { headers: { origin: "null" }, maxMs: 200 })).status,
    ).toBe(403);
  });

  it("the call number is per run, not global: interleaved runs count separately (OWN-6)", () => {
    const records = [
      decision("run-a", 0),
      decision("run-b", 1),
      decision("run-a", 2),
      decision("run-b", 3),
      decision("run-b", 4),
    ].map((l) => JSON.parse(l) as unknown);
    const { events } = projectDecisions(records, {
      runs: new Set(["run-a", "run-b"]),
      tasks: new Set(),
    });
    expect(events.map((e) => [e.runId, e.call, e.retry])).toEqual([
      ["run-a", 1, false],
      ["run-b", 1, false],
      ["run-a", 2, true],
      ["run-b", 2, true],
      ["run-b", 3, true],
    ]);
  });

  it("the server refuses an unlisted run even if the frame source would serve it (OWN-1)", async () => {
    const promiscuous: FrameSource = {
      count: () => 1,
      read: () => ({ bytes: PNG, contentType: "image/png", provenance: "file" }),
    };
    const s = await serve({ runs: ["run-a"], frames: promiscuous });
    expect((await raw(s.port, "/frames/run-a/0")).status).toBe(200);
    expect((await raw(s.port, "/frames/run-z/0")).status).toBe(404);
  });

  it("a component that became a symlink after listing is refused (OWN-4), and so is a symlinked file (OWN-7)", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.png"), PNG);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "a.png"), PNG);
    symlinkSync(outside, join(dir, "sub"));
    symlinkSync(join(outside, "secret.png"), join(dir, "real", "link.png"));
    expect(resolveListed(dir, "real/a.png")).toBe(join(dir, "real", "a.png"));
    expect(resolveListed(dir, "sub/secret.png")).toBeNull();
    expect(resolveListed(dir, "real/link.png")).toBeNull();
    expect(resolveListed(dir, "real/missing.png")).toBeNull();
    expect(readRegular(join(dir, "real", "a.png"))?.equals(PNG)).toBe(true);
    expect(readRegular(join(dir, "real", "link.png"))).toBeNull();
    expect(readRegular(dir)).toBeNull();
  });

  it("a [::1] bind host is passed to listen() without brackets", async () => {
    const outcome = await startWatchServer({ host: "[::1]", runs: ["r"] }).then(
      async (s) => {
        await s.close();
        return s.host;
      },
      (error: NodeJS.ErrnoException) => error.code,
    );
    // ::1 where IPv6 exists; EAFNOSUPPORT/EADDRNOTAVAIL where it does not; never a DNS lookup.
    expect(["::1", "EAFNOSUPPORT", "EADDRNOTAVAIL"]).toContain(outcome);
  });

  it("a loopback bind other than 127.0.0.1 (127.0.0.2) serves its own Host", async () => {
    const s = await serve({ host: "127.0.0.2", runs: ["r"] });
    const r = await new Promise<number>((resolve, reject) => {
      const sock = connect(s.port, "127.0.0.2", () =>
        sock.write(
          `GET /api/state HTTP/1.1\r\nHost: 127.0.0.2:${s.port}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let text = "";
      sock.setEncoding("latin1");
      sock.on("data", (c: string) => {
        text += c;
      });
      sock.on("end", () => resolve(Number(text.split(" ")[1])));
      sock.on("error", reject);
    });
    expect(r).toBe(200);
  });
});
