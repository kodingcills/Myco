/**
 * `myco clip` and `GET /clip/...` (spec #589 RS-08 verify half, RS-14, RS-13 /clip rows;
 * issue #666). Export writes exactly the user-chosen path and nothing else, never overwrites,
 * reads the run read-only, and is machine-marked mock; verify refuses a mock preview with
 * CLIP_NO_SIDECAR; the route serves mock previews only, codes only on refusal.
 */
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BAND_H, MOCK_RED, watermarkMask } from "../../src/watch/clip/band.ts";
import { CLIP_USAGE, clipMain, EXPORT_FLAGS } from "../../src/watch/clip/cli.ts";
import { directoryFrameSource, renderedFrameSource } from "../../src/watch/frames.ts";
import { todoFrameSvg } from "../../src/watch/render-frame.ts";
import { startWatchServer, type WatchServer } from "../../src/watch/server.ts";
import { decodeGif } from "./gif-decode.ts";
import { MARKER, raw, tempDir, treeSnapshot } from "./helpers.ts";
import { RUN, recordedRun, TASK } from "./recorded-run.ts";

function capture() {
  let out = "";
  let err = "";
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, done) {
        append(String(chunk));
        done();
      },
    });
  return {
    io: { stdout: sink((s) => (out += s)), stderr: sink((s) => (err += s)) },
    out: () => out,
    err: () => err,
  };
}

function exportArgs(root: string, log: string, out: string, extra: string[] = []): string[] {
  return [
    "export",
    "--run",
    RUN,
    "--task",
    TASK,
    "--from",
    "0",
    "--to",
    "3",
    "--decision-log",
    log,
    "--frames",
    root,
    "--out",
    out,
    ...extra,
  ];
}

describe("myco clip export (RS-14)", () => {
  it("writes exactly --out, a watermarked GIF, and prints a summary machine-marked mock", async () => {
    const rec = await recordedRun();
    const before = treeSnapshot(rec.root);
    const logBefore = readFileSync(rec.log);
    const outDir = tempDir("myco-clip-out-");
    const out = join(outDir, "clip.gif");
    const c = capture();
    expect(clipMain(exportArgs(rec.root, rec.log, out, ["--json"]), c.io)).toBe(0);
    expect(readdirSync(outDir)).toEqual(["clip.gif"]); // no sidecar, nothing else
    const summary = JSON.parse(c.out()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      schema: "myco.clip-export/1",
      ok: true,
      mock: true,
      evidence: false,
      watermark: "MOCK · NOT EVIDENCE",
      frames: 5,
    });
    expect(c.out()).not.toContain(rec.root);
    expect(c.out()).not.toContain(outDir);
    const gif = decodeGif(readFileSync(out));
    const mask = watermarkMask(gif.width, gif.height - BAND_H);
    for (const frame of gif.frames)
      for (let p = 0; p < mask.length; p += 1)
        if (mask[p] === 1) expect(frame.pixels[p]).toBe(MOCK_RED);
    // Read-only: the run directory and the log are byte-identical.
    expect(treeSnapshot(rec.root)).toEqual(before);
    expect(readFileSync(rec.log)).toEqual(logBefore);
  });

  it("never overwrites: an existing --out or a symlink at --out is refused and left as it was", async () => {
    const rec = await recordedRun();
    const outDir = tempDir("myco-clip-out-");
    const existing = join(outDir, "taken.gif");
    writeFileSync(existing, MARKER);
    const c = capture();
    expect(clipMain(exportArgs(rec.root, rec.log, existing), c.io)).toBe(1);
    expect(readFileSync(existing, "utf8")).toBe(MARKER);
    const target = join(outDir, "target.txt");
    writeFileSync(target, MARKER);
    const link = join(outDir, "link.gif");
    symlinkSync(target, link);
    expect(clipMain(exportArgs(rec.root, rec.log, link), capture().io)).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(MARKER);
    expect(readdirSync(outDir).sort()).toEqual(["link.gif", "taken.gif", "target.txt"]);
    expect(c.err()).not.toContain(outDir);
  });

  it("refuses with codes only and writes nothing: an edited frame (CLIP_TIMELINE), a bad span", async () => {
    const rec = await recordedRun();
    writeFileSync(join(rec.root, RUN, "frame-001.png"), MARKER);
    const outDir = tempDir("myco-clip-out-");
    const c = capture();
    expect(clipMain(exportArgs(rec.root, rec.log, join(outDir, "x.gif"), ["--json"]), c.io)).toBe(
      1,
    );
    expect(JSON.parse(c.out())).toEqual({ ok: false, code: "CLIP_TIMELINE" });
    expect(readdirSync(outDir)).toEqual([]);
    expect(c.out() + c.err()).not.toContain(MARKER);
  });

  it("no flag marks a run real or drops the watermark; unknown flags are usage errors", async () => {
    for (const flag of [
      "--evidence",
      "--real",
      "--not-mock",
      "--force",
      "--no-watermark",
      "--vault",
    ])
      expect(EXPORT_FLAGS).not.toContain(flag);
    expect(CLIP_USAGE).not.toMatch(/--(evidence|real|not-mock|force|no-watermark)\b/);
    const rec = await recordedRun();
    for (const flag of ["--real", "--no-watermark", "--force"]) {
      const c = capture();
      expect(
        clipMain([...exportArgs(rec.root, rec.log, join(tempDir(), "x.gif")), flag, "1"], c.io),
      ).toBe(3);
    }
    expect(clipMain([], capture().io)).toBe(3);
    expect(clipMain(["export", "--run", RUN], capture().io)).toBe(3);
  });
});

describe("myco clip verify (RS-08)", () => {
  it("a mock preview has no sidecar: exit 1 with CLIP_NO_SIDECAR, never 0", async () => {
    const rec = await recordedRun();
    const out = join(tempDir(), "clip.gif");
    expect(clipMain(exportArgs(rec.root, rec.log, out), capture().io)).toBe(0);
    const c = capture();
    const code = clipMain(
      ["verify", out, "--sidecar", `${out}.myco.json`, "--decision-log", rec.log, "--json"],
      c.io,
    );
    expect(code).toBe(1);
    expect(JSON.parse(c.out())).toEqual({ ok: false, code: "CLIP_NO_SIDECAR" });
    // Any sidecar is refused until the evidence clip lands; verify never exits 0.
    writeFileSync(`${out}.myco.json`, "{}");
    const d = capture();
    expect(
      clipMain(
        ["verify", out, "--sidecar", `${out}.myco.json`, "--decision-log", rec.log, "--json"],
        d.io,
      ),
    ).toBe(1);
    expect(JSON.parse(d.out())).toEqual({ ok: false, code: "CLIP_SCHEMA" });
  });
});

describe("GET /clip/<run>/<from>/<to>.gif (mock previews only)", () => {
  const open: WatchServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });
  const serve = async (opts: Parameters<typeof startWatchServer>[0]) => {
    const s = await startWatchServer({ pollMs: 20, ...opts });
    open.push(s);
    return s;
  };

  it("serves a watermarked attachment, marked mock, and writes nothing", async () => {
    const rec = await recordedRun();
    const before = treeSnapshot(rec.root);
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const r = await raw(server.port, `/clip/${RUN}/0/3.gif`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/gif");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="myco-mock-clip.gif"');
    expect(r.headers["x-myco-mock"]).toBe("1");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const gif = decodeGif(r.body);
    expect(gif.frames).toHaveLength(5);
    const mask = watermarkMask(gif.width, gif.height - BAND_H);
    for (const frame of gif.frames)
      for (let p = 0; p < mask.length; p += 1)
        if (mask[p] === 1) expect(frame.pixels[p]).toBe(MOCK_RED);
    expect(treeSnapshot(rec.root)).toEqual(before);
  });

  it("refuses with a code only (422), 404s unlisted runs, 405s non-GET, 400s traversal", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const bad = await raw(server.port, `/clip/${RUN}/2/9.gif`);
    expect(bad.status).toBe(422);
    expect(bad.body.toString("utf8")).toBe("CLIP_FRAMES\n");
    expect((await raw(server.port, "/clip/run-s/0/1.gif")).status).toBe(404);
    expect((await raw(server.port, `/clip/${RUN}/0/1.png`)).status).toBe(404);
    expect((await raw(server.port, `/clip/${RUN}/01/1.gif`)).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
      expect((await raw(server.port, `/clip/${RUN}/0/1.gif`, { method })).status).toBe(405);
    for (const path of [
      `/clip/../${RUN}/0/1.gif`,
      `/clip/${RUN}/0/1.gif?x`,
      "/clip/%2e%2e/0/1.gif",
    ])
      expect([400, 404]).toContain((await raw(server.port, path)).status);
    expect(
      (await raw(server.port, `/clip/${RUN}/0/1.gif`, { headers: { origin: "http://evil.test" } }))
        .status,
    ).toBe(403);
  });

  it("an invalid join refuses the clip (CLIP_TIMELINE); demo SVG frames refuse (CLIP_FRAME_REFUSED)", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    expect((await raw(server.port, `/clip/${RUN}/0/1.gif`)).body.toString()).toBe(
      "CLIP_TIMELINE\n",
    );
    const frames = renderedFrameSource(new Set(["demo"]));
    frames.push(
      "demo",
      todoFrameSvg({ stateVersion: 1, entryText: "", listRows: [], statusText: "" }, 1),
    );
    const demo = await serve({ runs: ["demo"], frames });
    const r = await raw(demo.port, "/clip/demo/0/0.gif");
    expect(r.status).toBe(422);
  });

  it("the clip modules are passive: no write call, no spawn, no vault or secret-file import", () => {
    const dir = resolve(import.meta.dirname, "..", "..", "src", "watch", "clip");
    const writes =
      /(?<!\.)\b(writeFile|writeSync|appendFile|createWriteStream|mkdir|rmSync|rmdir|unlink|rename|truncate|chmod|chown|utimes|copyFile|symlink|link|cp|cpSync|spawn|exec|fork)\w*\s*\(|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;
    for (const file of ["band.ts", "font.ts", "gif.ts", "png-decode.ts", "mock-preview.ts"]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(writes.test(text), file).toBe(false);
      expect(text, file).not.toMatch(
        /integrity\/vault|secret-file|child_process|node:net|node:http/,
      );
    }
    // The CLI module is the one place a file is written (--out, O_EXCL), and the server never imports it.
    const server = readFileSync(resolve(dir, "..", "server.ts"), "utf8");
    expect(server).not.toContain("clip/cli.ts");
    mkdirSync(tempDir(), { recursive: true });
  });
});
