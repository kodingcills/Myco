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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(stubDir, name), `#!/bin/bash\necho ran >> "${marker}"\n${body}\n`, {
    mode: 0o755,
  });
}

/**
 * Drive the gate with a chosen CPU trajectory and SSH behaviour.
 *
 * Async `spawn`, never `spawnSync`: a synchronous 30s wait blocks this worker's
 * event loop past vitest's RPC heartbeat, and vitest then reports
 * `Timeout calling "onTaskUpdate"` and exits 1 - which turns a fully passing
 * suite into a red CI run. That was the observed CI failure, and shrinking the
 * intervals only shortened the block rather than removing it.
 *
 * `cpuTrace` is the sequence of `ps -o time=` values; the last one repeats. One
 * case uses fractional values because macOS emits `SS.ss`, and the script must
 * parse it rather than error.
 */
interface GateRun {
  // `status` is null when the process is signalled or our own timeout fires,
  // which is a distinct outcome from an exit code and stays visible here rather
  // than being cast away.
  status: number | null;
  stdout: string;
  stderr: string;
  markers: string[];
}

function runGate(opts: {
  cpuTrace: string[];
  sshAnswers: boolean;
  timeout?: number;
  noProcess?: boolean;
  /**
   * Per-probe SSH outcomes, "ok" or "drop"; the last one repeats. Overrides
   * `sshAnswers`. Models sshd answering once and then dropping while it settles
   * after a cold boot (TIF-220).
   */
  sshTrace?: string[];
}): Promise<GateRun> {
  if (opts.noProcess) {
    stub("ps", "exit 1");
    stub("pgrep", "exit 1");
    stub("ssh", "exit 255");
  } else {
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
    // CRLF, because that is what the guest actually sends. The guest's default
    // shell is PowerShell, so the answer is `ok\r\n`; command substitution strips
    // the `\n` and leaves the `\r`. A stub emitting a bare `\n` cannot catch a
    // comparison that ignores the CR - which is exactly how the CR-intolerant
    // compare shipped, with this suite green.
    if (opts.sshTrace) {
      const sshTracePath = join(dir, "ssh.trace");
      writeFileSync(sshTracePath, opts.sshTrace.join("\n"));
      const sshCursor = join(dir, "ssh.cursor");
      writeFileSync(sshCursor, "0");
      stub(
        "ssh",
        `i=$(cat "${sshCursor}")
n=${opts.sshTrace.length}
v=$(sed -n "$((i<n?i+1:n))p" "${sshTracePath}")
echo $((i+1)) > "${sshCursor}"
if [ "$v" = ok ]; then printf "ok\\r\\n"; exit 0; fi
echo "Connection to 127.0.0.1 closed by remote host." >&2
exit 255`,
      );
    } else {
      stub("ssh", opts.sshAnswers ? 'printf "ok\\r\\n"\nexit 0' : "exit 255");
    }
  }

  return new Promise((resolve) => {
    // A minimal environment, not an inherited one. The gate resolves `ps`,
    // `pgrep`, and `ssh` through PATH, and an inherited PATH can put the real
    // binaries ahead of the stubs - which turns a stubbed run into a real host
    // observation. Negative controls on 2026-11-23 booted the real guest that
    // way. `HOME` points at the temp dir so the SSH config the gate reads does
    // not exist, making a fall-through to real ssh unable to authenticate.
    const child = spawn("bash", [GATE, String(opts.timeout ?? 20)], {
      // MYCO_READY_STABLE_SPACING=0 keeps the TIF-220 stability probes from
      // adding real seconds; the probe count and drop logic are unchanged.
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        HOME: dir,
        MYCO_READY_INTERVAL: "1",
        MYCO_READY_STABLE_SPACING: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr, markers: markerNames() });
    });
  });
}

/** Stubs that actually executed. A stub shadowed by a real binary writes none. */
function markerNames(): string[] {
  return ["ps", "pgrep", "ssh"].filter((n) => existsSync(join(dir, `${n}.marker`)));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-gate-"));
  stubDir = join(dir, "stub");
  mkdirSync(stubDir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The gate concludes a guest is stalled only after three sampling intervals
// without CPU progress. Those intervals are 10s in production, so the tests
// shrink them via MYCO_READY_INTERVAL - otherwise each test takes 30s and the
// suite runs long enough to trip vitest's worker-report timeout, which fails CI
// as an unhandled error even when all tests pass. The timeout below is generous
// relative to the shrunk interval, not a substitute for shrinking it.
const SLOW = 30_000;

describe("wait-guest-ready", () => {
  it("fails when the guest CPU is flat even though SSH answers", { timeout: SLOW }, async () => {
    // The regression: SSH answering on its own must never be enough.
    const r = await runGate({ cpuTrace: ["00:01"], sshAnswers: true, timeout: 45 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not booting");
    // Defect C: the docstring promised this negative control and never asserted
    // it. A stub that is shadowed by a real binary writes no marker, so a run
    // that silently used the host's `ps` fails here instead of passing.
    expect(r.markers).toContain("ps");
    expect(r.markers).toContain("pgrep");
    // SSH is not even probed when CPU never advances - the AND is real.
    expect(r.markers).not.toContain("ssh");
  });

  it("fails when the guest CPU is flat and SSH is silent", { timeout: SLOW }, async () => {
    const r = await runGate({ cpuTrace: ["00:01"], sshAnswers: false, timeout: 45 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not booting");
  });

  it("passes only once CPU advances and SSH answers", { timeout: SLOW }, async () => {
    const r = await runGate({
      cpuTrace: ["00:01", "00:11", "00:21"],
      sshAnswers: true,
      timeout: 45,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ssh up");
    expect(r.markers).toContain("ssh");
  });

  it("fails when CPU advances but SSH never answers", { timeout: SLOW }, async () => {
    // The other direction of the AND: a booting guest whose sshd is down must
    // not be reported ready, however much CPU it burns. The trace outruns the
    // timeout, because a trace that runs out repeats its last value and would
    // then look like a stall - stopping the run for the wrong reason.
    const advancing = Array.from({ length: 40 }, (_, i) => `0:${String(i + 1).padStart(2, "0")}`);
    const r = await runGate({ cpuTrace: advancing, sshAnswers: false, timeout: 9 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("timeout after");
  });

  it("parses fractional and hour-plus ps time without an integer error", {
    timeout: SLOW,
  }, async () => {
    // macOS can emit SS.ss, and >1h boots emit HH:MM:SS. A non-integer here
    // makes the shell comparison error rather than compare.
    const r = await runGate({
      cpuTrace: ["04:22.99", "04:30", "1:02:03"],
      sshAnswers: true,
      timeout: 45,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("integer expression expected");
  });

  it("does not accept a single CPU blip as proof of boot", { timeout: SLOW }, async () => {
    // The verifier's claim-3 trace: one 1s advance then flat forever, with SSH
    // answering. A lone blip is not evidence the guest is running - TIF-164's
    // stalled guest also sat at exactly 00:01.
    const r = await runGate({ cpuTrace: ["00:01", "00:02"], sshAnswers: true, timeout: 45 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not booting");
    expect(r.markers).not.toContain("ssh");
  });

  it("fails fast when no guest process exists at all", { timeout: SLOW }, async () => {
    const r = await runGate({ cpuTrace: [], sshAnswers: false, timeout: 6, noProcess: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no qemu process");
    expect(r.markers).toContain("pgrep");
  });
  // TIF-220: row-8 trial 14's reset passed this gate on one answered probe, and
  // the deploy's first scp seconds later was dropped by the still-settling sshd.
  describe("stable readiness after a cold boot (TIF-220)", () => {
    const booting = ["00:01", "00:11", "00:21"];

    it("does not declare ready on one answer: it re-probes until the answer holds", {
      timeout: SLOW,
    }, async () => {
      const r = await runGate({ cpuTrace: booting, sshAnswers: true, timeout: 45 });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("stable for 3 consecutive probes");
      // The ssh stub appends one marker line per probe.
      const probes = readFileSync(join(dir, "ssh.marker"), "utf8").trim().split("\n");
      expect(probes).toHaveLength(3);
    });

    it("rides out a transient drop right after the first answer", {
      timeout: SLOW,
    }, async () => {
      // The trial-14 shape: answers, drops, then settles. Ready only after
      // three consecutive answers that follow the drop.
      const r = await runGate({
        cpuTrace: booting,
        sshAnswers: true,
        sshTrace: ["ok", "drop", "ok", "ok", "ok"],
        timeout: 45,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("ssh dropped after answering (drop 1/3)");
      expect(r.stdout).toContain("stable for 3 consecutive probes");
    });

    it("fails loudly, and fast, when sshd keeps dropping after it answered", {
      timeout: SLOW,
    }, async () => {
      // A persistent drop is a broken guest, not a settling one: it must not be
      // retried into a "ready", and must not burn the whole budget either.
      const r = await runGate({
        cpuTrace: booting,
        sshAnswers: true,
        sshTrace: ["ok", "drop"],
        timeout: 600,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("dropped 3 times");
      expect(r.stderr).toContain("guest or UTM unhealthy");
      expect(r.stdout).not.toContain("ssh up");
    });
  });
});
