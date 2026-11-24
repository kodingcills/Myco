/**
 * TIF-209 (F16): the §5 desktop-proof CLI (`src/integration/session-info.ts`).
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  classifySessionInfo,
  DEFAULT_TOKEN_FILE,
  readTokenFile,
  runSessionInfo,
  type SessionInfoConnection,
  type SessionInfoDeps,
  tokenFileFromArgv,
} from "../src/integration/session-info.ts";
import { type VmLock, VmLockedError } from "../src/integration/vm-lock.ts";
import { sshTunnelArgs } from "../src/win/agent-client.ts";

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
      captured.tunnelsStarted++;
      // What production really spawns (SshTunnel → sshTunnelArgs): captured so
      // the leak scan can prove the token never enters a child's argv or env.
      captured.spawnArgv = sshTunnelArgs();
      captured.spawnEnv = {};
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
      return SENTINEL;
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
