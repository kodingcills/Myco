/**
 * Live watch view (TIF-265 follow-up, scope add A): the security guards.
 *  - loopback-only bind (refused without the explicit flag), Host/Origin checks, no CORS;
 *  - read-only: every non-GET method refused on every route;
 *  - path traversal on the frame route;
 *  - redaction: a planted marker and a fake absolute path never reach any response;
 *  - passivity: running the view changes no file, and the passive modules have no write call
 *    and no handle on the gate, the vault, an oracle or the agent.
 */
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, parseWatchArgs } from "../../src/watch/cli.ts";
import { DecisionLogTail } from "../../src/watch/decision-log.ts";
import { projectDecisions } from "../../src/watch/events.ts";
import { directoryFrameSource } from "../../src/watch/frames.ts";
import { gridFrameSvg, todoFrameSvg } from "../../src/watch/render-frame.ts";
import { sanitizePng } from "../../src/watch/sanitize-frame.ts";
import {
  isLoopbackHost,
  startWatchServer,
  WatchBindError,
  type WatchServer,
} from "../../src/watch/server.ts";
import { FAKE_ABS_PATH, MARKER, PNG, raw, tempDir, treeSnapshot } from "./helpers.ts";

const open: WatchServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serve(opts: Parameters<typeof startWatchServer>[0]): Promise<WatchServer> {
  const server = await startWatchServer({ pollMs: 20, ...opts });
  open.push(server);
  return server;
}

/** A decision line as the gate writes it, with a marker and a fake host path planted everywhere free-form. */
function plantedDecision(runId: string, over: Record<string, unknown> = {}) {
  return {
    apiVersion: "myco.gate/v1",
    verdict: "refuted",
    accepted: false,
    reasonCodes: ["ORACLE_FAIL", "TARGET_MISMATCH", MARKER, "CLAIM_RECORDED"],
    reasons: [`could not look: ${FAKE_ABS_PATH} ${MARKER}`],
    evidenceRefs: [
      {
        kind: "persisted-state",
        runId,
        path: `${FAKE_ABS_PATH}/${MARKER}`,
        sha256: MARKER,
        bytes: 1,
      },
    ],
    request: { taskId: "task-a", runId, claim: `done ${MARKER} ${FAKE_ABS_PATH}` },
    oracle: { family: MARKER, version: MARKER, specSha256: MARKER },
    checkpoints: {
      total: 2,
      lastVerified: 1,
      verdicts: [
        { checkpoint: 1, verdict: "verified" },
        { checkpoint: 2, verdict: "refuted" },
      ],
    },
    checkedAt: "2026-11-26T12:00:00.000Z",
    vaultKey: MARKER,
    sealDigest: FAKE_ABS_PATH,
    ...over,
  };
}

/** An operator directory with a planted decision log and frames (names carry the marker). */
function plantedFixture() {
  const root = tempDir(`myco-watch-${MARKER}-`);
  const log = join(root, "gate-decisions.jsonl");
  const lines = [
    JSON.stringify(plantedDecision("run-a")),
    JSON.stringify(
      plantedDecision("run-a", {
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        checkedAt: MARKER,
      }),
    ),
    // An agent naming another run (ids are agent-influenced): never shown.
    JSON.stringify(plantedDecision(MARKER)),
    JSON.stringify(plantedDecision("run-a", { request: { runId: "run-a", taskId: MARKER } })),
    JSON.stringify(
      plantedDecision("run-a", {
        checkpoints: { total: 1, lastVerified: 0, verdicts: [{ checkpoint: 1, verdict: MARKER }] },
      }),
    ),
    `{"not json ${MARKER} ${FAKE_ABS_PATH}`,
  ];
  writeFileSync(log, `${lines.join("\n")}\n`);
  const frames = join(root, "frames");
  mkdirSync(join(frames, "run-a", `${MARKER}-sub`), { recursive: true });
  writeFileSync(join(frames, "run-a", `0001-${MARKER}.png`), PNG);
  writeFileSync(join(frames, "run-a", `${MARKER}-sub`, "0002.png"), PNG);
  writeFileSync(join(frames, "run-a", `notes-${MARKER}.txt`), `${MARKER} ${FAKE_ABS_PATH}`);
  // A secret outside the frames tree, and a symlink to it inside: never served.
  const secret = join(root, "secret.png");
  writeFileSync(secret, Buffer.concat([PNG, Buffer.from(MARKER)]));
  symlinkSync(secret, join(frames, "run-a", "0003-link.png"));
  return { root, log, frames, secret };
}

const FS_READ_ONLY = [
  "closeSync",
  "constants",
  "fstatSync",
  "lstatSync",
  "openSync",
  "readdirSync",
  "readSync",
];
const ROUTES = [
  "/",
  "/watch.css",
  "/watch.js",
  "/api/state",
  "/api/events",
  "/frames/run-a/0",
  "/nope",
];
const NON_GET = ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "PROPFIND", "MKCOL"];

describe("watch: loopback-only bind", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "example.com",
      "127.0.0.1.nip.io",
      "::ffff:127.0.0.1",
      "",
    ])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it("refuses a non-loopback bind without the explicit flag", async () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com"])
      await expect(startWatchServer({ host, runs: ["r"] }), host).rejects.toBeInstanceOf(
        WatchBindError,
      );
  });

  it("binds 127.0.0.1 by default and only allows a non-loopback bind with the flag", async () => {
    const s = await serve({ runs: ["r"] });
    expect(s.host).toBe("127.0.0.1");
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const wide = await serve({ host: "0.0.0.0", allowNonLoopback: true, runs: ["r"] });
    expect(wide.host).toBe("0.0.0.0");
  });

  it("the CLI refuses --host 0.0.0.0 without --allow-non-loopback (exit 3), and port 8765", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) } as never,
      stderr: { write: (s: string) => err.push(s) } as never,
    };
    expect(await main(["--run", "r", "--host", "0.0.0.0", "--port", "0"], io)).toBe(3);
    expect(err.join("")).toMatch(/loopback only/);
    expect(() => parseWatchArgs(["--run", "r", "--port", "8765"])).toThrow(/8765/);
    expect(parseWatchArgs(["--run", "r"]).host).toBe("127.0.0.1");
    expect(() => parseWatchArgs([])).toThrow(/--run is required/);
    expect(() => parseWatchArgs(["--run", "../x"])).toThrow(/safe id/);
  });

  it("refuses a foreign Host header (DNS rebinding) and a foreign Origin; never grants CORS", async () => {
    const s = await serve({ runs: ["r"] });
    expect(
      (await raw(s.port, "/api/state", { headers: { host: `evil.example:${s.port}` } })).status,
    ).toBe(421);
    expect((await raw(s.port, "/api/state", { headers: { host: "127.0.0.1:1" } })).status).toBe(
      421,
    );
    expect(
      (await raw(s.port, "/api/state", { headers: { origin: "http://evil.example" } })).status,
    ).toBe(403);
    const same = await raw(s.port, "/api/state", {
      headers: { origin: `http://127.0.0.1:${s.port}` },
    });
    expect(same.status).toBe(200);
    for (const path of ROUTES) {
      const r = await raw(s.port, path, {
        maxMs: 150,
        headers: { origin: `http://127.0.0.1:${s.port}` },
      });
      const cors = Object.keys(r.headers).filter((h) => h.startsWith("access-control-"));
      expect(cors, path).toEqual([]);
    }
  });
});

describe("watch: read-only routes", () => {
  it("refuses every non-GET method on every route with 405", async () => {
    const { log, frames } = plantedFixture();
    const s = await serve({
      runs: ["run-a"],
      decisionLog: log,
      frames: directoryFrameSource(frames, "per-run", new Set(["run-a"])),
    });
    for (const path of ROUTES)
      for (const method of NON_GET) {
        const r = await raw(s.port, path, { method, maxMs: 300 });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe("GET");
      }
    // GET still works.
    expect((await raw(s.port, "/api/state")).status).toBe(200);
    expect((await raw(s.port, "/frames/run-a/0")).status).toBe(200);
  });
});

describe("watch: path traversal on the frame route", () => {
  it("serves frames only by (listed run, index); every traversal form is refused", async () => {
    const { frames, secret } = plantedFixture();
    const s = await serve({
      runs: ["run-a"],
      frames: directoryFrameSource(frames, "per-run", new Set(["run-a"])),
    });
    const secretBytes = readFileSync(secret);
    const attacks = [
      "/frames/../secret.png",
      "/frames/run-a/../../secret.png",
      "/frames/run-a/../../../../etc/passwd",
      "/frames/%2e%2e/0",
      "/frames/run-a/%2e%2e%2fsecret.png",
      "/frames/run-a/..%2f..%2fsecret.png",
      "/frames/run-a/0/../2",
      "/frames/run-a\\..\\secret.png",
      "/frames/run-a/./0",
      "//frames/run-a/0",
      "/frames/run-a/0?x=../secret.png",
      "/frames/run-a/-1",
      "/frames/run-a/01",
      "/frames/run-a/0.png",
      "/frames/run-a/1e3",
      "/frames/run-a/2", // the symlink to the secret is not listed
      "/frames/run-a/999",
      "/frames/run-b/0", // not a listed run
      "/frames/secret.png/0",
      "/frames/run-a",
      "/frames/",
      "/etc/passwd",
      "/api/state/../../secret.png",
    ];
    for (const path of attacks) {
      const r = await raw(s.port, path);
      expect([400, 404], path).toContain(r.status);
      expect(r.body.includes(secretBytes), path).toBe(false);
      expect(r.body.includes(MARKER), path).toBe(false);
    }
    // The first layer refuses encoded, query, backslash and dot-segment forms outright (400),
    // before any route is matched; exact routing and the listing are the second and third.
    for (const path of [
      "/frames/%2e%2e/0",
      "/frames/run-a/0?x=1",
      "/frames/run-a\\..\\x",
      "/frames/run-a/./0",
      "/frames/run-a/../run-a/0",
      "/api/state/..",
      "/%2e%2e/etc/passwd",
    ])
      expect((await raw(s.port, path)).status, path).toBe(400);
    // Served frames are the PNG rebuilt from its pixels (round 2, D1), not the file's bytes.
    const rebuilt = sanitizePng(PNG) as Buffer;
    expect((await raw(s.port, "/frames/run-a/0")).body.equals(rebuilt)).toBe(true);
    expect((await raw(s.port, "/frames/run-a/1")).body.equals(rebuilt)).toBe(true);
    expect(s.state().runs).toEqual([{ runId: "run-a", frames: 2 }]);
  });

  it("the sealed layout lists captured images only, never persisted/, the seal or the ground truth", () => {
    const vault = tempDir();
    const run = join(vault, "run-s");
    mkdirSync(join(run, "captured", "persisted"), { recursive: true });
    mkdirSync(join(run, "sealed"), { recursive: true });
    writeFileSync(join(run, "seal.json"), MARKER);
    writeFileSync(join(run, "sealed", "ground-truth.png"), PNG);
    writeFileSync(join(run, "captured", "persisted", "sheet.png"), PNG);
    writeFileSync(join(run, "captured", "result.json"), MARKER);
    writeFileSync(join(run, "captured", "screen-01.png"), PNG);
    const src = directoryFrameSource(vault, "sealed", new Set(["run-s"]));
    expect(src.count("run-s")).toBe(1);
    expect(src.read("run-s", 0)?.bytes.equals(PNG)).toBe(true);
    expect(src.read("run-s", 1)).toBeNull();
    expect(src.count("other")).toBe(0);
  });
});

describe("watch: redaction (planted marker and fake absolute path)", () => {
  it("no HTTP response carries the marker, a host path, the username or a vault field", async () => {
    const { root, log, frames } = plantedFixture();
    const s = await serve({
      runs: ["run-a"],
      tasks: ["task-a"],
      decisionLog: log,
      frames: directoryFrameSource(frames, "per-run", new Set(["run-a"])),
    });
    const bodies: Buffer[] = [];
    const paths = [
      ...ROUTES,
      "/frames/run-a/1",
      "/frames/run-a/2",
      "/frames/run-a/../x",
      "/frames/run-b/0",
    ];
    for (const path of paths) {
      const r = await raw(s.port, path, { maxMs: 300 });
      bodies.push(r.body, Buffer.from(JSON.stringify(r.headers)));
    }
    for (const method of NON_GET) bodies.push((await raw(s.port, "/", { method })).body);
    bodies.push((await raw(s.port, "/", { headers: { host: "evil:1" } })).body);
    const all = Buffer.concat(bodies).toString("latin1");
    const forbidden = [
      MARKER,
      FAKE_ABS_PATH,
      "/srv/",
      resolve(root),
      root,
      homedir(),
      "vaultKey",
      "sealDigest",
      "specSha256",
      "evidenceRefs",
      "claim",
    ];
    const user = userInfo().username;
    if (user.length >= 3) forbidden.push(`/${user}`);
    for (const needle of forbidden) expect(all.includes(needle), needle).toBe(false);
    // What it does show: the listed run's four usable decisions, codes from the closed set.
    const state = JSON.parse((await raw(s.port, "/api/state")).body.toString()) as {
      events: {
        runId: string;
        taskId: string | null;
        reasonCodes: string[];
        checkedAt: string | null;
        checkpoints: unknown;
      }[];
      skipped: number;
    };
    expect(state.events.map((e) => e.runId)).toEqual(["run-a", "run-a", "run-a", "run-a"]);
    expect(state.events[0]?.reasonCodes).toEqual([
      "ORACLE_FAIL",
      "TARGET_MISMATCH",
      "CLAIM_RECORDED",
    ]);
    expect(state.events[0]?.taskId).toBe("task-a");
    expect(state.events[1]?.checkedAt).toBeNull();
    expect(state.events[2]?.taskId).toBeNull();
    expect(state.events[3]?.checkpoints).toBeNull();
    expect(state.skipped).toBe(2);
  });

  it("projection is an allowlist: unknown fields never survive", () => {
    const { events } = projectDecisions([plantedDecision("run-a")], {
      runs: new Set(["run-a"]),
      tasks: new Set(),
    });
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      "accepted",
      "call",
      "checkedAt",
      "checkpoints",
      "reasonCodes",
      "retry",
      "runId",
      "seq",
      "taskId",
      "verdict",
    ]);
    expect(JSON.stringify(events)).not.toContain(MARKER);
    // accepted is never shown without verified.
    const forged = projectDecisions([plantedDecision("run-a", { accepted: true })], {
      runs: new Set(["run-a"]),
      tasks: new Set(),
    });
    expect(forged.events[0]?.accepted).toBe(false);
  });

  it("demo frames draw app content only, never host facts", () => {
    const svg = gridFrameSvg(
      {
        stateVersion: 1,
        capturedAt: "x",
        facts: { documentPath: `${FAKE_ABS_PATH}/${MARKER}`, dirty: false, focusedNodeId: null },
        nodes: [
          {
            id: "A1",
            role: "cell",
            name: "A1",
            value: "id",
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            enabled: true,
            visible: true,
          },
          {
            id: "A2",
            role: "cell",
            name: "A2",
            value: "<script>x</script>",
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            enabled: true,
            visible: true,
          },
        ],
      },
      1,
    );
    expect(svg).not.toContain(MARKER);
    expect(svg).not.toContain(FAKE_ABS_PATH);
    expect(svg).not.toContain("<script>");
    const todo = todoFrameSvg(
      { stateVersion: 1, entryText: "a & <b>", listRows: ['x"y'], statusText: "saved" },
      2,
    );
    expect(todo).toContain("a &amp; &lt;b&gt;");
    expect(todo).not.toContain("<b>");
  });
});

describe("watch: passive (changes no file, holds no gate handle)", () => {
  it("serving, polling and every request (including refused writes) leave the operator files unchanged", async () => {
    const { root, log, frames } = plantedFixture();
    const before = treeSnapshot(root);
    const s = await serve({
      runs: ["run-a"],
      decisionLog: log,
      frames: directoryFrameSource(frames, "per-run", new Set(["run-a"])),
    });
    for (const path of [...ROUTES, "/frames/run-a/1"]) {
      await raw(s.port, path, { maxMs: 200 });
      for (const method of NON_GET) await raw(s.port, path, { method, maxMs: 200 });
    }
    await new Promise((r) => setTimeout(r, 120)); // several polls
    await s.close();
    open.splice(open.indexOf(s), 1);
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("a missing log is never created, and a symlinked log is refused", async () => {
    const root = tempDir();
    const missing = join(root, "not-yet.jsonl");
    const s = await serve({ runs: ["r"], decisionLog: missing });
    await new Promise((r) => setTimeout(r, 60));
    expect(s.state().logPresent).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    const real = join(root, "real.jsonl");
    writeFileSync(real, `${JSON.stringify(plantedDecision("r"))}\n`);
    symlinkSync(real, join(root, "link.jsonl"));
    const tail = new DecisionLogTail(join(root, "link.jsonl"));
    tail.poll();
    expect(tail.snapshot()).toMatchObject({ present: false, records: [] });
  });

  it("the tail reads only complete lines, follows appends, and restarts on truncation", () => {
    const root = tempDir();
    const path = join(root, "log.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":');
    const tail = new DecisionLogTail(path);
    tail.poll();
    expect(tail.snapshot().records).toEqual([{ a: 1 }]);
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    tail.poll();
    expect(tail.snapshot().records).toEqual([{ a: 1 }, { b: 2 }]);
    writeFileSync(path, '{"c":3}\n');
    tail.poll();
    expect(tail.snapshot().records).toEqual([{ c: 3 }]);
  });

  it("the passive modules have no write call and import nothing that can reach the gate, vault, oracle or agent", () => {
    const dir = resolve(import.meta.dirname, "..", "..", "src", "watch");
    const passive = [
      "server.ts",
      "events.ts",
      "decision-log.ts",
      "frames.ts",
      "page.ts",
      "render-frame.ts",
      "sanitize-frame.ts",
      // Replay B2 (spec #589 §2.8): the joiner and the run-trust classifier, extended, never relaxed.
      "timeline.ts",
      "run-trust.ts",
    ];
    const writes =
      /(?<!\.)\b(writeFile|writeSync|appendFile|createWriteStream|mkdir|rmSync|rmdir|unlink|rename|truncate|chmod|chown|utimes|copyFile|symlink|link|cp|cpSync|spawn|exec|fork)\w*\s*\(|["']w\+?["']|O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;
    for (const file of passive) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(writes.test(text), file).toBe(false);
      // From node:fs, read-only calls only; nothing from child_process, net sockets out, etc.
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"node:fs"/g))
        for (const name of (m[1] as string)
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean))
          expect(FS_READ_ONLY, `${file} imports ${name} from node:fs`).toContain(name);
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        const ok =
          [
            "node:fs",
            "node:http",
            "node:net",
            "node:os",
            "node:path",
            "node:zlib",
            "node:crypto",
          ].includes(spec) ||
          [
            "./decision-log.ts",
            "./events.ts",
            "./frames.ts",
            "./page.ts",
            "./sanitize-frame.ts",
            "./timeline.ts",
            "./run-trust.ts",
            "../gate/api.ts",
            "../core/state.ts",
            "../discovery/live-runner.ts",
          ].includes(spec);
        expect(ok, `${file} imports ${spec}`).toBe(true);
      }
    }
    // The two non-gate imports are type-only.
    const render = readFileSync(join(dir, "render-frame.ts"), "utf8");
    expect(render).toMatch(/import type \{ AppState \}/);
    expect(render).toMatch(/import type \{ DesktopObservation \}/);
  });
});
