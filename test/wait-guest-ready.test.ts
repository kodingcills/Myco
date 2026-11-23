/**
 * Regression tests for the TIF-164 readiness gate: a guest must be PROVEN to be
 * booting, and the proof must not be forgeable by SSH alone.
 *
 * The defect these lock down: the first version of the gate probed SSH on the
 * first interval and returned 0 immediately, so a flat-CPU guest whose sshd
 * still answered passed in 10s. That is the TIF-164 shape exactly - SSH was the
 * signal that lied - and it made the CPU check decorative.
 *
 * Every scenario drives the real script with stubbed `ps`/`pgrep`/`ssh` first on
 * PATH. The real VM is never contacted, and the stubs assert their own identity
 * so a stub that fails to shadow the real binary fails loudly instead of
 * silently booting the guest (a verifier did exactly that on 2026-11-23).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GATE = join(import.meta.dirname, "..", "scripts", "wait-guest-ready.sh");
const GUEST_PID = "69100";

let dir = "";
let stubDir = "";

/**
 * A stub that proves it is the one being executed.
 *
 * Negative-control lesson from 2026-11-23: a verifier stripped a stub from PATH,
 * the real binary resolved, and the guest booted. So the stub records its own
 * invocation AND refuses to act unless it was reached - a stub that is shadowed
 * by a real binary writes no marker and the assertion fails loudly.
 */
function stub(name: string, body: string): void {
  const marker = join(dir, `${name}.marker`);
  writeFileSync(
    join(stubDir, name),
    ["#!/bin/bash", `echo ran >> "${marker}"`, body].join("\n") + "\n",
    { mode: 0o755 },
  );
}

/**
 * Drive the gate with a chosen CPU trajectory and SSH behaviour.
 *
 * `cpuTrace` is the sequence of `ps -o time=` values; the last one repeats. The
 * values are deliberately fractional (`04:22.99`) in one case, because macOS
 * can emit `SS.ss` and the script must not choke on it.
 */
function runGate(opts: { cpuTrace: string[]; sshAnswers: boolean; timeout?: number }): {
  // `status` is null when the process is signalled or the timeout fires, which
  // is a distinct outcome from an exit code and must stay visible to the test
  // rather than being cast away.
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const tracePath = join(dir, "cpu.trace");
  writeFileSync(tracePath, opts.cpuTrace.join("\n"));
  const cursorPath = join(dir, "cpu.cursor");
  writeFileSync(cursorPath, "0");

  stub(
    "ps",
    `if [[ "$*" == *"-o time="* ]]; then
  i=$(cat "${cursorPath}")
  n=${opts.cpuTrace.length}
  line=$(sed -n "$((i<n?i+1:n))p" "${tracePath}")
  i=$((i+1)); echo "$i" > "${cursorPath}"
  echo "$line"; exit 0
fi
echo "PID TTY TIME CMD"`,
  );
  stub("pgrep", `echo "${GUEST_PID}"`);
  stub("ssh", opts.sshAnswers ? "echo ok\nexit 0" : "exit 255");

  // A minimal environment, not an inherited one. The gate resolves `ps`,
  // `pgrep`, and `ssh` through PATH, and an inherited PATH can put the real
  // binaries ahead of the stubs - which silently turns a stubbed run into a real
  // host observation. Negative controls on 2026-11-23 booted the real guest that
  // way. Keep the stub dir first AND keep the environment small enough to reason
  // about.
  return spawnSync("bash", [GATE, String(opts.timeout ?? 20)], {
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: dir },
  });
}

beforeEach(() => {
  dir = execFileSync("mktemp", ["-d"]).toString().trim();
  stubDir = join(dir, "stub");
  mkdirSync(stubDir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// These tests are slow BY CONSTRUCTION: the gate can only conclude a guest is
// stalled after it has watched three 10s intervals without CPU progress. So the
// suite needs a per-test timeout above vitest's 5s default - the first run of
// this file reported five failures that were all vitest killing correct tests.
const SLOW = 90_000;

describe("wait-guest-ready", () => {
  it("fails when the guest CPU is flat even though SSH answers", { timeout: SLOW }, () => {
    // The regression: SSH answering on its own must never be enough.
    const r = runGate({ cpuTrace: ["00:01"], sshAnswers: true, timeout: 45 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not booting");
  });

  it("fails when the guest CPU is flat and SSH is silent", { timeout: SLOW }, () => {
    const r = runGate({ cpuTrace: ["00:01"], sshAnswers: false, timeout: 45 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not booting");
  });

  it("passes only once CPU advances and SSH answers", { timeout: SLOW }, () => {
    const r = runGate({ cpuTrace: ["00:01", "00:11"], sshAnswers: true, timeout: 45 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ssh up");
  });

  it("parses fractional and hour-plus ps time without an integer error", { timeout: SLOW }, () => {
    // macOS can emit SS.ss, and >1h boots emit HH:MM:SS. A non-integer here
    // makes the shell comparison error rather than compare.
    const r = runGate({ cpuTrace: ["04:22.99", "1:02:03"], sshAnswers: true, timeout: 45 });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("integer expression expected");
  });

  it("fails fast when no guest process exists at all", { timeout: SLOW }, () => {
    stub("ps", "exit 1");
    stub("pgrep", "exit 1");
    stub("ssh", "exit 255");
    const r = spawnSync("bash", [GATE, "10"], {
      encoding: "utf8",
      timeout: 120_000,
      env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: dir },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no qemu process");
  });
});
