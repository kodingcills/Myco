/**
 * Track U backend guards (src/desktops/backend.ts, src/desktops/local-process.ts). Every
 * guard here is fail-closed and mutation-proved by scripts/desktops-mutation-proof.sh.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkSpec,
  DESKTOP_PATH,
  type DesktopError,
  type DesktopSpec,
  safeRelativePath,
} from "../../src/desktops/backend.ts";
import { runFleet } from "../../src/desktops/fleet.ts";
import { LocalProcessBackend } from "../../src/desktops/local-process.ts";

const spec = (over: Partial<DesktopSpec> = {}): DesktopSpec => ({
  trialKey: "t-1/r-1",
  image: "myco-linux-desktop/1",
  network: "off",
  seed: [{ path: "fixture.csv", bytes: Buffer.from("id,name\nEMP-0001,Ada\n") }],
  ...over,
});

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return (e as DesktopError).code ?? `not a DesktopError: ${String(e)}`;
  }
  return "no error";
}

const node = (code: string) => [process.execPath, "-e", code];

let base: string;
let backend: LocalProcessBackend;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-u-backend-"));
  backend = new LocalProcessBackend({ baseDir: base, maxCaptureBytes: 1024 });
});
afterEach(() => {
  delete process.env.MYCO_U_PLANTED_SECRET;
});

describe("spec guards", () => {
  it("refuses any network other than off", async () => {
    const bad = { ...spec(), network: "on" } as unknown as DesktopSpec;
    expect(await codeOf(backend.create(bad))).toBe("NETWORK_NOT_OFF");
    expect(await codeOf(() => checkSpec({ ...spec(), network: undefined } as never))).toBe(
      "NETWORK_NOT_OFF",
    );
  });

  it("refuses unsafe trial keys and images", async () => {
    expect(await codeOf(backend.create(spec({ trialKey: "../x" })))).toBe("BAD_SPEC");
    expect(await codeOf(backend.create(spec({ image: "a b" })))).toBe("BAD_SPEC");
  });

  it.each([
    ["/etc/passwd", "PATH_ESCAPE"],
    ["../outside", "PATH_ESCAPE"],
    ["a/../../outside", "PATH_ESCAPE"],
    ["a/./b", "PATH_ESCAPE"],
    ["a\\b", "PATH_ESCAPE"],
    ["", "BAD_PATH"],
    ["a//b", "BAD_PATH"],
    [".hidden", "BAD_PATH"],
    ["a b", "BAD_PATH"],
  ])("refuses the path %j (%s)", async (path, code) => {
    expect(await codeOf(() => safeRelativePath(path))).toBe(code);
    expect(await codeOf(backend.create(spec({ seed: [{ path, bytes: Buffer.from("x") }] })))).toBe(
      code,
    );
  });

  it("refuses duplicate seed paths", async () => {
    const seed = [
      { path: "a.txt", bytes: Buffer.from("1") },
      { path: "a.txt", bytes: Buffer.from("2") },
    ];
    expect(await codeOf(backend.create(spec({ seed })))).toBe("BAD_SPEC");
  });

  it("accepts nested relative seed paths", async () => {
    const h = await backend.create(
      spec({ seed: [{ path: "docs/in/a.txt", bytes: Buffer.from("A") }] }),
    );
    expect(readFileSync(join(backend.rootOf(h), "docs", "in", "a.txt"), "utf8")).toBe("A");
  });
});

describe("environment isolation", () => {
  it("a desktop program does not inherit the host environment", async () => {
    const marker = `planted-${Date.now()}-marker`;
    process.env.MYCO_U_PLANTED_SECRET = marker;
    const h = await backend.create(spec());
    const r = await backend.run(h, {
      argv: node("process.stdout.write(JSON.stringify(process.env))"),
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(marker);
    const env = JSON.parse(r.stdout) as Record<string, string>;
    // macOS injects `__CF_USER_TEXT_ENCODING` into EVERY child process, whatever env it is
    // spawned with (round 2, R2-D2). It is allowed on darwin only, and only in its fixed
    // `0x<uid>:0x<enc>:0x<region>` shape, so nothing else can ride in it.
    const osInjected = process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];
    const injected = env.__CF_USER_TEXT_ENCODING;
    if (injected !== undefined) {
      expect(process.platform).toBe("darwin");
      expect(injected).toMatch(/^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/);
    }
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "TMPDIR",
        "PATH",
        ...["LANG", "TZ"].filter((k) => process.env[k] !== undefined),
        ...osInjected.filter((k) => env[k] !== undefined),
      ].sort(),
    );
    // PATH is never the host's (a host PATH can name host home directories).
    expect(env.PATH).toBe(DESKTOP_PATH);
    // HOME is the desktop's own home, reported as a placeholder, never the host path.
    expect(env.HOME).toBe("<home>");
    expect(env.TMPDIR).toBe("<desktop>/tmp");
  });

  it("runs with the desktop home as cwd and scrubs the host root from output", async () => {
    const h = await backend.create(spec());
    const r = await backend.run(h, {
      argv: node("console.log(process.cwd()); console.error(require('os').homedir())"),
      timeoutMs: 10_000,
    });
    expect(r.stdout.trim()).toBe("<home>");
    expect(r.stderr.trim()).toBe("<home>");
    expect(r.stdout + r.stderr).not.toContain(base);
  });

  it("kills a program that runs past its timeout", async () => {
    const h = await backend.create(spec());
    const r = await backend.run(h, { argv: node("setTimeout(() => {}, 60000)"), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("a missing program is RUN_FAILED, a code with no path", async () => {
    const h = await backend.create(spec());
    expect(await codeOf(backend.run(h, { argv: ["/nonexistent/prog"], timeoutMs: 1000 }))).toBe(
      "RUN_FAILED",
    );
  });
});

describe("capture guards", () => {
  it("captures the persisted bytes with their digest", async () => {
    const h = await backend.create(spec());
    const r = await backend.run(h, {
      argv: node(
        "fs=require('fs'); fs.mkdirSync('out'); fs.writeFileSync('out/doc.csv', 'a,b\\n')",
      ),
      timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(0);
    const c = await backend.capture(h, "out/doc.csv");
    expect(c).not.toBeNull();
    expect(Buffer.from(c!.bytes).toString()).toBe("a,b\n");
    expect(c!.sha256).toBe(createHash("sha256").update("a,b\n").digest("hex"));
    expect(c!.size).toBe(4);
    expect(await backend.capture(h, "out/missing.csv")).toBeNull();
  });

  it("never follows a symlink: final component or directory component", async () => {
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "host secret file");
    const h = await backend.create(spec());
    const home = backend.rootOf(h);
    symlinkSync(outside, join(home, "doc.csv"));
    mkdirSync(join(base, "outdir"));
    writeFileSync(join(base, "outdir", "doc.csv"), "host");
    symlinkSync(join(base, "outdir"), join(home, "linked"));
    expect(await codeOf(backend.capture(h, "doc.csv"))).toBe("SYMLINK_REFUSED");
    expect(await codeOf(backend.capture(h, "linked/doc.csv"))).toBe("SYMLINK_REFUSED");
  });

  it("refuses a directory or a FIFO instead of reading it", async () => {
    const h = await backend.create(spec());
    mkdirSync(join(backend.rootOf(h), "adir"));
    expect(await codeOf(backend.capture(h, "adir"))).toBe("NOT_REGULAR_FILE");
    const fifo = join(backend.rootOf(h), "pipe");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      expect(await codeOf(backend.capture(h, "pipe"))).toBe("NOT_REGULAR_FILE");
    }
  });

  it("refuses a capture over the size cap rather than truncating", async () => {
    const h = await backend.create(spec());
    writeFileSync(join(backend.rootOf(h), "big.bin"), Buffer.alloc(1025));
    expect(await codeOf(backend.capture(h, "big.bin"))).toBe("CAPTURE_TOO_LARGE");
    writeFileSync(join(backend.rootOf(h), "ok.bin"), Buffer.alloc(1024));
    expect((await backend.capture(h, "ok.bin"))!.size).toBe(1024);
  });

  it("refuses an escaping capture path", async () => {
    const h = await backend.create(spec());
    expect(await codeOf(backend.capture(h, "../../outside.txt"))).toBe("PATH_ESCAPE");
  });
});

describe("handles are bound to one desktop", () => {
  it("destroy removes everything and later calls are refused; destroy is idempotent", async () => {
    const h = await backend.create(spec());
    const home = backend.rootOf(h);
    expect(existsSync(home)).toBe(true);
    await backend.destroy(h);
    expect(existsSync(home)).toBe(false);
    expect(await codeOf(backend.capture(h, "fixture.csv"))).toBe("DESKTOP_DESTROYED");
    expect(await codeOf(backend.run(h, { argv: node("1"), timeoutMs: 1000 }))).toBe(
      "DESKTOP_DESTROYED",
    );
    await backend.destroy(h);
  });

  it("refuses a forged handle or another backend's handle", async () => {
    const h = await backend.create(spec());
    const other = new LocalProcessBackend({ baseDir: join(base, "other") });
    expect(await codeOf(other.capture(h, "fixture.csv"))).toBe("UNKNOWN_DESKTOP");
    expect(await codeOf(backend.capture({ ...h, backend: "microvm/1" }, "fixture.csv"))).toBe(
      "BACKEND_MISMATCH",
    );
    expect(await codeOf(backend.capture({ ...h, id: "forged" }, "fixture.csv"))).toBe(
      "UNKNOWN_DESKTOP",
    );
  });

  it("two desktops have disjoint homes", async () => {
    const a = await backend.create(spec({ trialKey: "a/1" }));
    const b = await backend.create(spec({ trialKey: "b/1" }));
    expect(backend.rootOf(a)).not.toBe(backend.rootOf(b));
    writeFileSync(join(backend.rootOf(a), "doc.csv"), "A");
    expect(await backend.capture(b, "doc.csv")).toBeNull();
  });

  it("declares what it does not enforce", () => {
    expect(backend.isolation).toBe("process");
    expect(backend.enforcesNetworkOff).toBe(false);
  });
});

describe("fleet guards", () => {
  const trial = (k: number, over: Record<string, unknown> = {}) => ({
    trialKey: `t-${k}/r-${k}`,
    taskId: `t-${k}`,
    runId: `r-${k}`,
    image: "myco-linux-desktop/1",
    seed: [],
    argv: node("require('fs').writeFileSync('doc.csv', 'x')"),
    capturePath: "doc.csv",
    canary: `canary-${k}-abcdefghijklmnop`,
    timeoutMs: 10_000,
    ...over,
  });

  it.each([
    ["duplicate trial key", [trial(1), trial(2, { trialKey: "t-1/r-1" })]],
    ["duplicate run id", [trial(1), trial(2, { runId: "r-1" })]],
    ["duplicate canary", [trial(1), trial(2, { canary: "canary-1-abcdefghijklmnop" })]],
    ["short canary", [trial(1, { canary: "short" })]],
  ])("refuses a batch with a %s before any desktop starts", async (_name, trials) => {
    expect(await codeOf(runFleet(backend, trials, { concurrency: 2 }))).toBe("BAD_SPEC");
    expect(readdirSync(base).filter((n) => n.startsWith("d-"))).toEqual([]);
  });

  it("refuses a non-positive concurrency", async () => {
    expect(await codeOf(runFleet(backend, [trial(1)], { concurrency: 0 }))).toBe("BAD_SPEC");
  });

  it("never runs more desktops at once than the cap, and destroys every one", async () => {
    const trials = Array.from({ length: 6 }, (_, k) =>
      trial(k, {
        argv: node("setTimeout(() => require('fs').writeFileSync('doc.csv', 'x'), 150)"),
      }),
    );
    const r = await runFleet(backend, trials, { concurrency: 3 });
    expect(r.maxConcurrent).toBeLessThanOrEqual(3);
    expect(r.outcomes.every((o) => o.error === null && o.capture !== null)).toBe(true);
    expect(readdirSync(base).filter((n) => n.startsWith("d-"))).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("a canary in another trial's output is a contamination event", async () => {
    const trials = [trial(1), trial(2, { argv: node("console.log('canary-1-abcdefghijklmnop')") })];
    const r = await runFleet(backend, trials, { concurrency: 1 });
    expect(r.clean).toBe(false);
    expect(r.contamination).toEqual([
      { trialKey: "t-2/r-2", canaryOf: "t-1/r-1", where: "stdout" },
    ]);
  });
});
