/**
 * TIF-209 (F16): the §5 desktop-proof CLI (`src/integration/session-info.ts`, logic in
 * `session-info-core.ts`).
 *
 * The contract under test:
 * - exit 0 + result JSON on stdout when session_id is a non-zero integer and
 *   the window station is WinSta0;
 * - exit 2 (the "stop, do not run trials" gate) for session 0 / a
 *   Service-0x0-… station, with a one-line reason on stderr;
 * - exit 3 for unreachable / auth failure / bad token file;
 * - exit 10 with `REFUSED_VM_LOCKED: holder …` when the VM lock is held;
 * - the lock and the tunnel are always released.
 *
 * The fault cases (the key ones, F16's own incident class): a misbehaving
 * agent echoes the token — in an `{ok:false}` error message, in the result
 * JSON, in a transport error's message, inside a gate-shaped station name —
 * and the sentinel must appear NOWHERE in captured stdout, stderr, or console
 * output. Those assertions fail if the redaction sink is removed from
 * `runSessionInfo`.
 *
 * Nothing here touches the VM: `connect` is a fake, the lock acquirer is
 * recorded, and the token file always resolves to a synthetic sentinel.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  classifySessionInfo,
  DEFAULT_TOKEN_FILE,
  productionDeps,
  readTokenFile,
  redactToken,
  runSessionInfo,
  type SessionInfoConnection,
  type SessionInfoDeps,
  type SessionInfoTunnel,
  tokenFileFromArgv,
  tunnelOptionsFor,
} from "../src/integration/session-info-core.ts";
import { type VmLock, VmLockedError } from "../src/integration/vm-lock.ts";
import {
  type AgentRequest,
  type AgentResponse,
  AgentUnreachableError,
  SshTunnel,
  type SshTunnelOptions,
  sshTunnelArgs,
} from "../src/win/agent-client.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SENTINEL = "tok-SENTINEL-a1b2c3d4e5f6";

interface Captured {
  stdout: string[];
  stderr: string[];
  lockAcquired: number;
  lockReleased: number;
  tunnelsStarted: number;
  tunnelsStopped: number;
  /** Argv/env the tunnel's ssh spawn receives; the token must never be here. */
  spawnArgv: string[];
  spawnEnv: Record<string, string>;
}

interface Harness {
  deps: SessionInfoDeps;
  captured: Captured;
  /** What the fake agent does; mutate per test before invoking. */
  agent: {
    result?: unknown;
    error?: Error;
    /** Thrown by the tunnel teardown. */
    stopError?: Error;
    /** Thrown by `connect` itself (the tunnel never came up). */
    connectError?: Error;
    /** The token the fake token file holds (default SENTINEL). */
    token?: string;
    onToken?: (token: string) => void;
  };
}

/** console.* spies plus a way to join what they swallowed, in one value so the
 * leak assertions can treat console output as just another visible channel. */
interface ConsoleProbe {
  spies: MockInstance<(...args: unknown[]) => void>[];
  text(): string;
  clear(): void;
}

function attachConsoleProbe(): ConsoleProbe {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  return {
    spies,
    text: () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n"),
    clear: () => {
      for (const spy of spies) spy.mockClear();
    },
  };
}

function fakeLock(captured: Captured): VmLock {
  let released = false;
  return {
    path: "/tmp/test-myco-win11.vm.lock",
    holder: "12345 session-info.ts",
    release: () => {
      if (!released) captured.lockReleased++;
      released = true;
    },
  };
}

/** Wires the fakes: a fake lock, a fake tunnel + client, a synthetic token. */
function harness(lockError?: Error, tokenError?: Error): Harness {
  const captured: Captured = {
    stdout: [],
    stderr: [],
    lockAcquired: 0,
    lockReleased: 0,
    tunnelsStarted: 0,
    tunnelsStopped: 0,
    spawnArgv: [],
    spawnEnv: {},
  };
  const agent: Harness["agent"] = {};
  const deps: SessionInfoDeps = {
    connect: async (token: string): Promise<SessionInfoConnection> => {
      if (agent.connectError) throw agent.connectError;
      captured.tunnelsStarted++;
      // What production really spawns (SshTunnel → sshTunnelArgs): captured so
      // the leak scan can prove the token never enters a child's argv or env.
      // The env is the real scrub applied to a shell that still exports the
      // token (directly and embedded in another variable).
      const options = tunnelOptionsFor(token, {
        PATH: "/usr/bin",
        MYCO_AGENT_TOKEN: token,
        OTHER_VAR: `prefix-${token}-suffix`,
      });
      captured.spawnArgv = sshTunnelArgs(options);
      captured.spawnEnv = Object.fromEntries(
        Object.entries(options.env ?? {}).map(([k, v]) => [k, `${k}=${v ?? ""}`]),
      );
      agent.onToken?.(token);
      return {
        client: {
          sessionInfo: async (): Promise<unknown> => {
            // AgentOpError / AgentUnreachableError carry the wire message
            // as-is; a misbehaving agent can plant the token in it.
            if (agent.error) throw agent.error;
            return agent.result;
          },
        },
        stop: async () => {
          captured.tunnelsStopped++;
          if (agent.stopError) throw agent.stopError;
        },
      };
    },
    acquireLock: () => {
      if (lockError) throw lockError;
      captured.lockAcquired++;
      return fakeLock(captured);
    },
    readToken: (_path: string): string => {
      if (tokenError) throw tokenError;
      return agent.token ?? SENTINEL;
    },
    stdout: (text: string) => captured.stdout.push(text),
    stderr: (text: string) => captured.stderr.push(text),
  };
  return { deps, captured, agent };
}

const HAPPY = {
  session_id: 1,
  window_station: "WinSta0",
  desktop: "Default",
  user: "MYCO-WIN11\\myco",
};

/** Every channel the CLI could leak the token through, joined for one scan. */
function visibleChannels(captured: Captured, probe: ConsoleProbe): string {
  return [
    ...captured.stdout,
    ...captured.stderr,
    probe.text(),
    captured.spawnArgv.join(" "),
    ...Object.values(captured.spawnEnv),
  ].join("\n");
}

describe("tokenFileFromArgv", () => {
  it("parses --token-file PATH and rejects a missing value", () => {
    expect(tokenFileFromArgv(["--token-file", "/tmp/t"])).toBe("/tmp/t");
    expect(tokenFileFromArgv([])).toBeUndefined();
    expect(() => tokenFileFromArgv(["--token-file"])).toThrow("usage");
    expect(() => tokenFileFromArgv(["--token-file", "--other"])).toThrow("usage");
  });
});

describe("classifySessionInfo", () => {
  it("passes only a non-zero integer session on WinSta0", () => {
    expect(classifySessionInfo(HAPPY).code).toBe(0);
    expect(classifySessionInfo({ ...HAPPY, session_id: 3 }).code).toBe(0);
  });

  it("gates session 0 and non-WinSta0 stations", () => {
    expect(classifySessionInfo({ ...HAPPY, session_id: 0 }).code).toBe(2);
    expect(
      classifySessionInfo({
        session_id: 1,
        window_station: "Service-0x0-3e7$Default",
        desktop: "Default",
        user: "x",
      }).code,
    ).toBe(2);
    expect(
      classifySessionInfo({ ...HAPPY, session_id: 0, window_station: "Service-0x0-3e7$Default" })
        .code,
    ).toBe(2);
  });

  it("treats unreadable shapes as blocked (exit 3), including a string session id and a null result", () => {
    expect(classifySessionInfo(null).code).toBe(3);
    expect(classifySessionInfo({ session_id: "1", window_station: "WinSta0" }).code).toBe(3);
    // One field readable, the other garbage: cannot prove either way.
    expect(classifySessionInfo({ session_id: 1, window_station: 42 }).code).toBe(3);
  });
});

describe("runSessionInfo", () => {
  const probes: ConsoleProbe[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: prints the result JSON and exits 0; lock and tunnel released", async () => {
    probes.push(attachConsoleProbe());
    const { deps, captured, agent } = harness();
    agent.result = HAPPY;
    const code = await runSessionInfo([], deps);
    expect(code).toBe(0);
    expect(captured.stdout.join("\n")).toContain('"session_id":1');
    expect(captured.stdout.join("\n")).toContain('"window_station":"WinSta0"');
    expect(captured.stderr.join("\n")).toBe("");
    expect(captured.lockAcquired).toBe(1);
    expect(captured.lockReleased).toBe(1);
    expect(captured.tunnelsStarted).toBe(1);
    expect(captured.tunnelsStopped).toBe(1);
  });

  it("session 0 / Service-0x0 station: gate exit code, reason on stderr, result on stdout", async () => {
    probes.push(attachConsoleProbe());
    const { deps, captured, agent } = harness();
    agent.result = {
      session_id: 0,
      window_station: "Service-0x0-3e7$Default",
      desktop: "Default",
      user: "MYCO-WIN11\\myco",
    };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(2);
    expect(captured.stderr.join("\n")).toContain("stop, do not run trials");
    expect(captured.stderr.join("\n")).toContain("session_id 0");
    expect(captured.stdout.join("\n")).toContain("Service-0x0");
    expect(captured.lockReleased).toBe(1);
    expect(captured.tunnelsStopped).toBe(1);
  });

  it("REFUSED_VM_LOCKED: exit 10, holder named, no tunnel, no token read", async () => {
    probes.push(attachConsoleProbe());
    const { deps, captured } = harness(
      new VmLockedError("4242 m1-sweep.sh"),
      new Error("token must not be read after a lock refusal"),
    );
    const code = await runSessionInfo([], deps);
    expect(code).toBe(10);
    expect(captured.stderr.join("\n")).toBe("REFUSED_VM_LOCKED: holder 4242 m1-sweep.sh");
    expect(captured.tunnelsStarted).toBe(0);
    expect(captured.lockReleased).toBe(0);
    expect(captured.stdout.join("\n")).toBe("");
  });

  it("unreachable / auth failure: exit 3, message on stderr, tunnel stopped, lock released", async () => {
    probes.push(attachConsoleProbe());
    const { deps, captured, agent } = harness();
    agent.error = new Error("agent at 127.0.0.1:8765 unreachable: connection refused");
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(captured.stderr.join("\n")).toContain("unreachable");
    expect(captured.stdout.join("\n")).toBe("");
    expect(captured.tunnelsStopped).toBe(1);
    expect(captured.lockReleased).toBe(1);
  });

  it("missing and empty token file: exit 3, message names the PATH, never the contents", async () => {
    probes.push(attachConsoleProbe());
    for (const path of ["/home/op/.myco-token", "/tmp/s5-token"]) {
      const missing = harness(undefined, new Error(`cannot read token file ${path}: ENOENT`));
      expect(await runSessionInfo(["--token-file", path], missing.deps)).toBe(3);
      expect(missing.captured.stderr.join("\n")).toContain(path);
      expect(missing.captured.tunnelsStarted).toBe(0);

      const empty = harness(undefined, new Error(`token file ${path} is empty`));
      expect(await runSessionInfo(["--token-file", path], empty.deps)).toBe(3);
      expect(empty.captured.stderr.join("\n")).toContain(path);
      expect(empty.captured.tunnelsStarted).toBe(0);
    }
  });

  it("transport error whose message embeds the token: nowhere in output (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    agent.error = new Error(
      `agent at 127.0.0.1:8765 unreachable: auth failed for token ${SENTINEL} (ECONNRESET)`,
    );
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
    expect(captured.stderr.join("\n")).toContain("[REDACTED]");
    expect(captured.tunnelsStopped).toBe(1);
    expect(captured.lockReleased).toBe(1);
  });

  it("tunnel teardown throws with the token in its message: exit 3, redacted, lock released (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    agent.result = HAPPY;
    agent.stopError = new Error(`ssh teardown failed; last request carried ${SENTINEL}`);
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
    expect(captured.stderr.join("\n")).toContain("[REDACTED]");
    expect(captured.tunnelsStopped).toBe(1);
    expect(captured.lockReleased).toBe(1);
  });

  it("ok:false error message echoes the token: nowhere in output (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    agent.error = new Error(`agent op failed (AUTH_FAILED): token ${SENTINEL} is not valid`);
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
    expect(captured.stderr.join("\n")).toContain("[REDACTED]");
  });

  it("result JSON embeds the token: printed output is redacted (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    agent.result = { ...HAPPY, debug_token: SENTINEL };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(0);
    expect(captured.stdout.join("\n")).toContain("[REDACTED]");
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
  });

  it("gate-shaped result embeds the token in the station name: both channels redacted (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    agent.result = {
      session_id: 0,
      window_station: `Service-0x0-3e7$${SENTINEL}`,
      desktop: "Default",
      user: "x",
    };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(2);
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
    expect(captured.stdout.join("\n")).toContain("[REDACTED]");
    expect(captured.stderr.join("\n")).toContain("[REDACTED]");
    expect(captured.stderr.join("\n")).toContain("stop, do not run trials");
  });

  it("the agent receives the intact token (auth still works), and it never lands in ssh argv or env (FAULT)", async () => {
    const probe = probes.push(attachConsoleProbe()) - 1;
    const { deps, captured, agent } = harness();
    let clientToken = "";
    agent.result = HAPPY;
    agent.onToken = (token: string) => {
      clientToken = token;
    };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(0);
    // The client got the real token…
    expect(clientToken).toBe(SENTINEL);
    // …but no visible channel — stdout, stderr, console, ssh argv, child env —
    // ever saw it.
    expect(visibleChannels(captured, probes[probe] as ConsoleProbe)).not.toContain(SENTINEL);
    expect(captured.spawnArgv.join(" ")).not.toContain(SENTINEL);
    expect(Object.values(captured.spawnEnv).join("\n")).not.toContain(SENTINEL);
  });

  it("sshTunnelArgs never contains the token regardless of token value", async () => {
    probes.push(attachConsoleProbe());
    const argv = sshTunnelArgs();
    expect(argv.join(" ")).not.toContain(SENTINEL);
    expect(argv).toEqual([
      "-L",
      "8765:127.0.0.1:8765",
      "-F",
      expect.stringContaining("ssh_config"),
      "-N",
      "myco-win11",
    ]);
  });
});

describe("tunnelOptionsFor", () => {
  it("drops MYCO_AGENT_TOKEN and any variable carrying the token; keeps the rest", () => {
    const options = tunnelOptionsFor(SENTINEL, {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      MYCO_AGENT_TOKEN: "anything",
      OTHER_VAR: `x${SENTINEL}y`,
    });
    expect(options.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone" });
  });
});

describe("readTokenFile (real fs, synthetic token)", () => {
  it("reads and trims; refuses missing and empty with the path in the message", () => {
    expect(DEFAULT_TOKEN_FILE).toContain(".myco-token");
    const dir = mkdtempSync(join(tmpdir(), "myco-tif209-"));
    const path = join(dir, "token");
    writeFileSync(path, `  ${SENTINEL}\n`);
    expect(readTokenFile(path)).toBe(SENTINEL);
    const emptyPath = join(dir, "empty");
    writeFileSync(emptyPath, "   \n");
    expect(() => readTokenFile(emptyPath)).toThrow(emptyPath);
    expect(() => readTokenFile(join(dir, "missing"))).toThrow(join(dir, "missing"));
  });
});

// ---------------------------------------------------------------------------
// Round-1 verifier findings (D1–D5)
// ---------------------------------------------------------------------------

/** A synthetic token that differs from SENTINEL: what a stale operator shell
 * might still export. It must never reach the agent or the ssh child. */
const ENV_TOKEN = "env-token-SYNTHETIC-zz99887766";

/** A synthetic token that changes under JSON escaping (`"` and `\`). */
const QUOTED_TOKEN = 'tok"quoted\\SENTINEL-0123456789';

describe("CLI entry point (subprocess, no VM: usage errors return before the lock) — D1", () => {
  it("a bad argument exits 3 with usage, both directly and through a symlinked path — never a silent 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-tif209-link-"));
    const link = join(dir, "repo");
    symlinkSync(REPO_ROOT, link, "dir");
    const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    for (const root of [REPO_ROOT, link]) {
      const run = spawnSync(tsx, [join(root, "src/integration/session-info.ts"), "--token-file"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect({ root: root === link ? "symlink" : "direct", status: run.status }).toEqual({
        root: root === link ? "symlink" : "direct",
        status: 3,
      });
      expect(run.stderr).toContain("usage: --token-file needs a PATH argument");
      expect(run.stdout).toBe("");
    }
  }, 120_000);
});

describe("runSessionInfo exit paths, end to end — D3", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bad invocation: exit 3 with usage on stderr; no lock taken, no token read, no tunnel", async () => {
    attachConsoleProbe();
    const { deps, captured } = harness(undefined, new Error("token must not be read"));
    const code = await runSessionInfo(["--token-file"], deps);
    expect(code).toBe(3);
    expect(captured.stderr.join("\n")).toContain("usage: --token-file needs a PATH argument");
    expect(captured.lockAcquired).toBe(0);
    expect(captured.tunnelsStarted).toBe(0);
    expect(captured.stdout).toEqual([]);
  });

  it("lock state undeterminable (plain Error from the acquirer): exit 10, reason named; no token read, no tunnel", async () => {
    attachConsoleProbe();
    const { deps, captured } = harness(
      new Error("EACCES: permission denied, open '/tmp/test-myco-win11.vm.lock'"),
      new Error("token must not be read"),
    );
    const code = await runSessionInfo([], deps);
    expect(code).toBe(10);
    expect(captured.stderr.join("\n")).toContain("REFUSED_VM_LOCKED: lock state undeterminable");
    expect(captured.stderr.join("\n")).toContain("EACCES");
    expect(captured.tunnelsStarted).toBe(0);
    expect(captured.stdout).toEqual([]);
  });

  it("connect() throws (tunnel unreachable): exit 3, reason on stderr, lock released", async () => {
    attachConsoleProbe();
    const { deps, captured, agent } = harness();
    agent.connectError = new AgentUnreachableError(
      "ssh tunnel exited with code 255 before becoming healthy",
    );
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(captured.stderr.join("\n")).toContain("exited with code 255");
    expect(captured.stdout).toEqual([]);
    expect(captured.lockAcquired).toBe(1);
    expect(captured.lockReleased).toBe(1);
  });

  it("malformed result: exit 3, malformed-result reason on stderr, tunnel and lock released", async () => {
    attachConsoleProbe();
    const { deps, captured, agent } = harness();
    agent.result = { session_id: "1", window_station: "WinSta0" };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    expect(captured.stderr.join("\n")).toContain('malformed session_info result: session_id "1"');
    expect(captured.tunnelsStopped).toBe(1);
    expect(captured.lockReleased).toBe(1);
  });
});

/** A tunnel stand-in for `productionDeps`'s `makeTunnel` seam: records the
 * options it was built with and every request, and answers with `respond`. */
function recordingTunnel(respond: (request: AgentRequest) => AgentResponse) {
  const record = {
    options: [] as SshTunnelOptions[],
    requests: [] as AgentRequest[],
    started: 0,
    stopped: 0,
  };
  const makeTunnel = (options: SshTunnelOptions): SessionInfoTunnel => {
    record.options.push(options);
    return {
      start: async () => {
        record.started++;
      },
      stop: async () => {
        record.stopped++;
      },
      call: async (request: AgentRequest) => {
        record.requests.push(request);
        return respond(request);
      },
    };
  };
  return { record, makeTunnel };
}

/** `productionDeps` with only the lock and the output channels replaced, and a
 * real token file holding `token`; the tunnel comes from the seam. */
function productionHarness(
  makeTunnel: (options: SshTunnelOptions) => SessionInfoTunnel,
  token = SENTINEL,
) {
  const dir = mkdtempSync(join(tmpdir(), "myco-tif209-prod-"));
  const tokenPath = join(dir, "token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const out = { stdout: [] as string[], stderr: [] as string[], released: 0 };
  const deps: SessionInfoDeps = {
    ...productionDeps({ makeTunnel }),
    acquireLock: () => ({
      path: "/tmp/test-myco-win11.vm.lock",
      holder: "12345 session-info.ts",
      release: () => {
        out.released++;
      },
    }),
    stdout: (text: string) => out.stdout.push(text),
    stderr: (text: string) => out.stderr.push(text),
  };
  return { deps, out, argv: ["--token-file", tokenPath] };
}

describe("productionDeps: the token comes only from the file; the ssh child gets a scrubbed env — D2", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a stale MYCO_AGENT_TOKEN in process env is ignored and absent from the tunnel's env", async () => {
    attachConsoleProbe();
    vi.stubEnv("MYCO_AGENT_TOKEN", ENV_TOKEN);
    vi.stubEnv("MYCO_TEST_CARRIER", `carrier-${SENTINEL}-carrier`);
    const { record, makeTunnel } = recordingTunnel((request) => ({
      ok: true,
      id: request.id,
      result: HAPPY,
    }));
    const { deps, out, argv } = productionHarness(makeTunnel);
    const code = await runSessionInfo(argv, deps);
    expect(code).toBe(0);
    // The agent authenticated with the file's token, not the exported one.
    expect(record.requests.map((r) => [r.op, r.token === SENTINEL, r.token === ENV_TOKEN])).toEqual(
      [["session_info", true, false]],
    );
    // The tunnel was built with an explicit, scrubbed env (not inherited, not
    // process.env as-is). Boolean checks only: a failure must not print the
    // real environment into the test log.
    expect(record.options).toHaveLength(1);
    const childEnv = record.options[0]?.env;
    expect(childEnv).toBeDefined();
    const values = Object.values(childEnv ?? {});
    expect("MYCO_AGENT_TOKEN" in (childEnv ?? {})).toBe(false);
    expect("MYCO_TEST_CARRIER" in (childEnv ?? {})).toBe(false);
    expect(values.some((v) => v?.includes(SENTINEL))).toBe(false);
    expect(values.some((v) => v?.includes(ENV_TOKEN))).toBe(false);
    // Everything else is inherited, so ssh still finds its config and agent.
    expect(childEnv?.PATH).toBe(process.env.PATH);
    expect(record.started).toBe(1);
    expect(record.stopped).toBe(1);
    expect(out.released).toBe(1);
    expect([...out.stdout, ...out.stderr].join("\n")).not.toContain(SENTINEL);
  });

  it("SshTunnel hands options.env to the spawned process (real spawn of a stand-in ssh)", async () => {
    vi.stubEnv("MYCO_AGENT_TOKEN", ENV_TOKEN);
    const dir = mkdtempSync(join(tmpdir(), "myco-tif209-spawn-"));
    const namesOut = join(dir, "names");
    const script = join(dir, "fake-ssh");
    // Writes only variable NAMES (never values) plus one marker value, to a
    // path that exists only in the env we pass. If SshTunnel dropped
    // options.env, the child would inherit process env, the path variable would
    // be unset, and nothing would be written.
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'out="$MYCO_TEST_NAMES_OUT"',
        '[ -n "$out" ] || exit 0',
        '/usr/bin/env | /usr/bin/cut -d= -f1 > "$out"',
        'printf "%s" "$MYCO_TEST_MARK" > "$out.mark"',
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const options = tunnelOptionsFor(SENTINEL, {
      PATH: "/usr/bin:/bin",
      MYCO_AGENT_TOKEN: SENTINEL,
      MYCO_TEST_NAMES_OUT: namesOut,
      MYCO_TEST_MARK: "mark-42",
    });
    // localPort 1: nothing listens there, so start() never mistakes another
    // listener (e.g. a live 8765 tunnel) for health; the stand-in exits at once.
    const tunnel = new SshTunnel({ ...options, sshPath: script, localPort: 1 });
    await expect(tunnel.start(5_000)).rejects.toThrow(/exited with code 0/);
    await tunnel.stop();
    const names = readFileSync(namesOut, "utf8").split("\n").filter(Boolean);
    expect(readFileSync(`${namesOut}.mark`, "utf8")).toBe("mark-42");
    expect(names).toContain("MYCO_TEST_MARK");
    expect(names).not.toContain("MYCO_AGENT_TOKEN");
    expect(names).not.toContain("HOME");
  });
});

describe("redaction sink: escaped and partial echoes — D4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts the raw token, its JSON-escaped form, and fragments of 12+ characters; not shorter ones", () => {
    const escaped = JSON.stringify(QUOTED_TOKEN).slice(1, -1);
    expect(escaped).not.toBe(QUOTED_TOKEN);
    expect(redactToken(`raw ${QUOTED_TOKEN} end`, QUOTED_TOKEN)).toBe("raw [REDACTED] end");
    expect(redactToken(`json "${escaped}" end`, QUOTED_TOKEN)).toBe('json "[REDACTED]" end');
    expect(redactToken(`head:${SENTINEL.slice(0, 12)}`, SENTINEL)).toBe("head:[REDACTED]");
    expect(redactToken(`mid ${SENTINEL.slice(5, 20)} end`, SENTINEL)).toBe("mid [REDACTED] end");
    // Documented limit: an 11-character fragment is left alone.
    expect(redactToken(`short ${SENTINEL.slice(0, 11)}`, SENTINEL)).toBe(
      `short ${SENTINEL.slice(0, 11)}`,
    );
    expect(redactToken("no token here", "")).toBe("no token here");
  });

  it("a truncated malformed-NDJSON echo (half the token) never reaches stderr (FAULT)", async () => {
    attachConsoleProbe();
    const { deps, captured, agent } = harness();
    const line = `{"id":1,"token":"${SENTINEL}","op":"session_info"}`;
    // What SocketTransport does with a malformed line: the first N characters.
    const cut = line.slice(0, line.indexOf(SENTINEL) + 15);
    agent.error = new AgentUnreachableError(`agent sent malformed NDJSON: ${cut}`);
    const code = await runSessionInfo([], deps);
    expect(code).toBe(3);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("malformed NDJSON");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain(SENTINEL.slice(0, 12));
  });

  it("a token with quote and backslash, echoed inside the result JSON, is redacted in escaped form (FAULT)", async () => {
    attachConsoleProbe();
    const { deps, captured, agent } = harness();
    agent.token = QUOTED_TOKEN;
    agent.result = { ...HAPPY, debug_token: QUOTED_TOKEN };
    const code = await runSessionInfo([], deps);
    expect(code).toBe(0);
    const stdout = captured.stdout.join("\n");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain(JSON.stringify(QUOTED_TOKEN).slice(1, -1));
    expect(stdout).not.toContain(QUOTED_TOKEN);
  });
});

describe("ok:true with no result — D5", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 3 with the malformed-result reason (real AgentClient), not a TypeError; nothing on stdout", async () => {
    attachConsoleProbe();
    const { record, makeTunnel } = recordingTunnel(
      (request) => ({ ok: true, id: request.id }) as unknown as AgentResponse,
    );
    const { deps, out, argv } = productionHarness(makeTunnel);
    const code = await runSessionInfo(argv, deps);
    expect(code).toBe(3);
    const stderr = out.stderr.join("\n");
    expect(stderr).toContain("malformed session_info result");
    expect(stderr).not.toMatch(/TypeError|Cannot read|undefined \(reading/);
    expect(out.stdout).toEqual([]);
    expect(record.stopped).toBe(1);
    expect(out.released).toBe(1);
  });
});
