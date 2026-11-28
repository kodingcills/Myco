import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

// Runs scripts/reset-trial-vm.sh against a STUB vm.sh/wait-ssh.sh/vssh, with the
// VM lock and the process-detection tools stubbed too. It never contacts the real
// VM: the script refuses to fall back to the real VM when MYCO_VM_SCRIPTS is set
// but not executable, and every guest interaction goes through $VM_SCRIPTS.
const SCRIPT = join(__dirname, "..", "scripts", "reset-trial-vm.sh");

function run(
  snapshot?: string,
  opts: {
    egress?: "closed" | "open-guest" | "missing";
    env?: Record<string, string>;
    /** Guest CPU seconds the gate reports at the first ssh answer, one per boot; "none" prints no line. */
    gateCpu?: (number | "none")[];
    /** The gate's exit code (after it prints its first-ssh line). */
    gateRc?: number;
    /** After a `vm.sh stop`, status keeps reporting "started" (a VM that will not stop). */
    neverStops?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "myco-reset-allowlist-"));
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(stubs);
  mkdirSync(bin);
  const stub = (name: string, body: string) =>
    writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // vm.sh logs every call; `status` reports a stopped VM so the script proceeds.
  stub(
    "vm.sh",
    `echo "vm.sh $*" >> "${log}"
${opts.neverStops ? `[ "$1" = stop ] && touch "${dir}/stuck"` : ""}
if [ "$1" = status ]; then if [ -e "${dir}/stuck" ]; then echo started; else echo stopped; fi; fi
exit 0`,
  );
  // The readiness gate prints its first-ssh line to stderr, as the real one does; one
  // scripted CPU value per boot (default: one cold boot at 280 s).
  const cpu = (opts.gateCpu ?? [280]).map(String).join(" ");
  stub(
    "wait-guest-ready.sh",
    `echo "wait-guest-ready.sh $*" >> "${log}"
n=$(cat "${dir}/gate.count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/gate.count"
set -- ${cpu}; eval "c=\\\${$n:-}"
if [ -n "$c" ] && [ "$c" != none ]; then echo "wait-guest-ready: first ssh answer after 140s (guest CPU \${c}s)" >&2; fi
exit ${opts.gateRc ?? 0}`,
  );
  stub("vssh", `echo "vssh" >> "${log}"\nexit 0`);
  // TIF-275 egress check: closed by default; "open-guest" models a guest that
  // booted with egress open; "missing" leaves the script out entirely.
  if (opts.egress !== "missing") {
    stub(
      "guest-egress.sh",
      `echo "guest-egress.sh $*" >> "${log}"\n${opts.egress === "open-guest" ? 'echo "egress is OPEN" >&2\nexit 1' : "exit 0"}`,
    );
  }
  // Keep the lock guard independent of whatever is running on the host.
  writeFileSync(join(bin, "pgrep"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "ps"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const args = snapshot === undefined ? [SCRIPT] : [SCRIPT, snapshot];
  const result = spawnSync("bash", args, {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      MYCO_VM_SCRIPTS: stubs,
      MYCO_VM_LOCK_PATH: join(dir, "test.lock"),
      MYCO_VM_LOCK_OWNER: "",
      MYCO_STOP_TIMEOUT: "2",
      MYCO_SSH_WAIT_TIMEOUT: "2",
      // Never inherit the host's choice of default snapshot.
      MYCO_TRIAL_SNAPSHOT: "",
      ...opts.env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { ...result, calls };
}

describe("reset-trial-vm.sh snapshot allowlist", () => {
  // Guards against dropping a protected name from the allowlist.
  it.each([
    "clean-base",
    "clean-base-live",
    "m1-agent-live",
    "cua-c1-base",
    "trial-base-v2",
    "trial-base-v3",
    "trial-base-v4",
  ])("restores the allowed snapshot %s", (name) => {
    const r = run(name);
    expect(r.stderr).not.toContain("refusing to restore");
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`vm.sh restore ${name}`);
    expect(r.stdout).toContain(`ready on '${name}'`);
  });

  // TIF-98 / TIF-734: the default trial snapshot is trial-base-v4 (cold-boot rebuild with HCU);
  // trial-base-v3, trial-base-v2 and clean-base stay selectable. Guards against the default
  // silently changing again.
  it("defaults to trial-base-v4 when no snapshot is given", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore trial-base-v4");
    expect(r.calls).not.toContain("vm.sh restore trial-base-v3");
    expect(r.calls).not.toContain("vm.sh restore trial-base-v2");
    expect(r.calls).not.toContain("vm.sh restore clean-base");
    expect(r.stdout).toContain("ready on 'trial-base-v4'");
  });

  it("MYCO_TRIAL_SNAPSHOT=trial-base-v3 rolls the default back to trial-base-v3", () => {
    const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: "trial-base-v3" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore trial-base-v3");
    expect(r.calls).not.toContain("vm.sh restore trial-base-v4");
    expect(r.stdout).toContain("ready on 'trial-base-v3'");
  });

  it("MYCO_TRIAL_SNAPSHOT=trial-base-v2 rolls the default back to trial-base-v2", () => {
    const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: "trial-base-v2" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore trial-base-v2");
    expect(r.calls).not.toContain("vm.sh restore trial-base-v4");
    expect(r.stdout).toContain("ready on 'trial-base-v2'");
  });

  it("MYCO_TRIAL_SNAPSHOT=clean-base rolls the default back to clean-base", () => {
    const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: "clean-base" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore clean-base");
    expect(r.stdout).toContain("ready on 'clean-base'");
  });

  it("an explicit argument wins over MYCO_TRIAL_SNAPSHOT", () => {
    const r = run("cua-c1-base", { env: { MYCO_TRIAL_SNAPSHOT: "clean-base" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore cua-c1-base");
    expect(r.calls).not.toContain("vm.sh restore clean-base");
  });

  // Round 1 N2 / N3.
  it("refuses an explicit empty argument instead of falling back to the default", () => {
    const r = run("");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing an empty snapshot argument");
    expect(r.calls).toBe("");
  });

  it("refuses a live snapshot as the default from MYCO_TRIAL_SNAPSHOT; an explicit argument still may", () => {
    const viaEnv = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: "clean-base-live" } });
    expect(viaEnv.status).toBe(1);
    expect(viaEnv.stderr).toContain("a live snapshot is never the default");
    expect(viaEnv.calls).toBe("");
    const explicit = run("clean-base-live", { env: { MYCO_TRIAL_SNAPSHOT: "clean-base-live" } });
    expect(explicit.status).toBe(0);
    expect(explicit.calls).toContain("vm.sh restore clean-base-live");
  });

  it.each(["trial-base-v5", "clean-base;true", "../clean-base"])(
    "MYCO_TRIAL_SNAPSHOT=%j is held to the same allowlist, without touching the VM",
    (name) => {
      const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: name } });
      expect(r.status).toBe(1);
      // Refused before the allowlist since #529 nit 1 (not a trial base as the default).
      expect(r.stderr).toContain(`refusing MYCO_TRIAL_SNAPSHOT=${name}`);
      expect(r.calls).toBe("");
    },
  );

  // Guards the refuse-anything-else behaviour: a refused name must exit non-zero,
  // say why, and never call into the VM at all (no kill, no restore).
  it.each([
    "cua-c1-base2",
    "cua-c1",
    "Cua-C1-Base",
    "cua-c1-base ",
    "xcua-c1-base",
    "clean-base-evil",
    "clean-base2",
    "trial-base",
    "trial-base-v5",
    "Trial-Base-V2",
    "m1-agent",
    "../clean-base",
    "cua-c1-base;true",
    "*",
  ])("refuses the unexpected snapshot %j without touching the VM", (name) => {
    const r = run(name);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to restore unexpected snapshot");
    expect(r.calls).toBe("");
  });
});

// TIF-275: no reset calls a guest ready unless its egress is proven closed.
describe("reset-trial-vm.sh guest egress check (TIF-275)", () => {
  it("verifies egress on every reset before calling the guest ready", () => {
    const r = run("clean-base");
    expect(r.status).toBe(0);
    expect(r.calls).toContain("guest-egress.sh verify");
    // Order: boot gate, then egress, then the clock resync.
    expect(r.calls.indexOf("wait-guest-ready.sh")).toBeLessThan(r.calls.indexOf("guest-egress.sh"));
    expect(r.calls.indexOf("guest-egress.sh")).toBeLessThan(r.calls.indexOf("vssh"));
  });

  it("refuses a guest that booted with egress open", () => {
    const r = run("clean-base", { egress: "open-guest" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("guest egress is not closed");
    expect(r.stdout).not.toContain("ready on");
    expect(r.calls).not.toContain("vssh");
  });

  it("refuses when the egress check itself is missing", () => {
    const r = run("clean-base", { egress: "missing" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("egress check not found");
    expect(r.stdout).not.toContain("ready on");
  });

  it("skips the check only on an explicit MYCO_GUEST_EGRESS=open, loudly", () => {
    const r = run("clean-base", { egress: "open-guest", env: { MYCO_GUEST_EGRESS: "open" } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("WARNING MYCO_GUEST_EGRESS=open");
    expect(r.calls).not.toContain("guest-egress.sh");
  });
});

// TIF-98 fast-reset guard: the first start after a UTM config write boots the restored disk
// with most of Windows' boot work skipped (4 s guest CPU at the first ssh answer vs 272-312 s).
describe("reset-trial-vm.sh cold-boot check", () => {
  const restores = (calls: string) =>
    calls.split("\n").filter((l) => l.startsWith("vm.sh restore")).length;

  it("calls a boot at or above the threshold cold and reports it", () => {
    const r = run("clean-base", { gateCpu: [280] });
    expect(r.status).toBe(0);
    expect(restores(r.calls)).toBe(1);
    expect(r.stderr).toContain(
      "reset-trial-vm: boot class=cold first_ssh_s=140 guest_cpu_first_ssh_s=280 attempts=1",
    );
    expect(r.stdout).toContain("ready on 'clean-base'");
  });

  it("on a fast boot, stops by request and boots once more; a cold second boot is accepted", () => {
    const r = run("clean-base", { gateCpu: [4, 287] });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("fast boot (guest CPU 4s at the first ssh answer, under 100s)");
    expect(restores(r.calls)).toBe(2);
    expect(r.calls).toContain("vm.sh stop");
    expect(r.calls.indexOf("vm.sh stop")).toBeLessThan(r.calls.lastIndexOf("vm.sh restore"));
    expect(r.stderr).toContain(
      "boot class=cold first_ssh_s=140 guest_cpu_first_ssh_s=287 attempts=2",
    );
    expect(r.stdout).toContain("ready on 'clean-base'");
  });

  it("refuses a second fast boot (fail closed)", () => {
    const r = run("clean-base", { gateCpu: [4, 4] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fast boot again on attempt 2");
    expect(r.stdout).not.toContain("ready on");
    expect(r.calls).not.toContain("guest-egress.sh");
  });

  it("refuses a boot whose first-ssh guest CPU cannot be read", () => {
    const r = run("clean-base", { gateCpu: ["none"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read the guest CPU at the first ssh answer");
    expect(r.stdout).not.toContain("ready on");
  });

  it("puts the boundary at the threshold: 100 s is cold, 99 s is fast", () => {
    expect(run("clean-base", { gateCpu: [100] }).stderr).toContain("class=cold");
    expect(run("clean-base", { gateCpu: [99, 99] }).status).toBe(1);
  });

  it("refuses a threshold override that is not a whole number", () => {
    const r = run("clean-base", { env: { MYCO_COLD_MIN_GUEST_CPU: "abc" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not a whole number of seconds");
  });
});

// TIF-98: the callers that follow the default really do follow it.
describe("trial drivers use the default trial snapshot", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  // Round 2: the drivers resolve the snapshot themselves (scripts/trial-snapshot.sh, the
  // same rule: MYCO_TRIAL_SNAPSHOT, else trial-base-v4), pin it in OUT and pass it
  // explicitly. test/trial-snapshot.test.ts covers that path.
  it.each(["scripts/m1-sweep.sh", "scripts/m1-corrupt-suite.sh"])(
    "%s resets through ts_reset with the resolved snapshot",
    (driver) => {
      expect(read(driver)).toContain('ts_reset "$SNAP" "$PROGRESS"');
    },
  );

  it("trial-snapshot.sh resolves the same default as reset-trial-vm.sh", () => {
    expect(read("scripts/trial-snapshot.sh")).toContain(
      "local snap=$" + "{MYCO_TRIAL_SNAPSHOT:-trial-base-v4}",
    );
  });

  it("scripts/reset-bench.sh benches trial-base-v4 unless MYCO_BENCH_SNAPSHOT says otherwise", () => {
    // Split so the shell ${...} is not read as a JS template placeholder.
    expect(read("scripts/reset-bench.sh")).toContain(
      "SNAPSHOT=$" + "{MYCO_BENCH_SNAPSHOT:-trial-base-v4}",
    );
  });
});

// #529 nit 1: as the default (no argument), MYCO_TRIAL_SNAPSHOT may only name a trial base.
describe("reset-trial-vm.sh MYCO_TRIAL_SNAPSHOT as the default", () => {
  it.each(["cua-c1-base", "m1-agent-live"])(
    "refuses MYCO_TRIAL_SNAPSHOT=%s with no argument",
    (name) => {
      const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: name } });
      expect(r.status).toBe(1);
      expect(r.calls).toBe("");
    },
  );

  it.each(["trial-base-v4", "trial-base-v3", "trial-base-v2", "clean-base"])(
    "accepts MYCO_TRIAL_SNAPSHOT=%s as the default",
    (name) => {
      const r = run(undefined, { env: { MYCO_TRIAL_SNAPSHOT: name } });
      expect(r.status).toBe(0);
      expect(r.calls).toContain(`vm.sh restore ${name}`);
    },
  );

  it("still accepts cua-c1-base as an explicit argument", () => {
    const r = run("cua-c1-base", { env: { MYCO_TRIAL_SNAPSHOT: "cua-c1-base" } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore cua-c1-base");
  });
});

// #546 round 1 D2 / D3: the override is bounded, and the two untested fail-closed paths.
describe("reset-trial-vm.sh cold-boot check, round 2", () => {
  it.each(["99", "0", "272"])(
    "refuses MYCO_COLD_MIN_GUEST_CPU=%s (outside the measured gap 100-271 s)",
    (t) => {
      const r = run("clean-base", { env: { MYCO_COLD_MIN_GUEST_CPU: t }, gateCpu: [4] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is outside 100-271 s");
      expect(r.stdout).not.toContain("ready on");
    },
  );

  it("accepts an override at either edge of the gap", () => {
    expect(
      run("clean-base", { env: { MYCO_COLD_MIN_GUEST_CPU: "100" }, gateCpu: [280] }).status,
    ).toBe(0);
    expect(
      run("clean-base", { env: { MYCO_COLD_MIN_GUEST_CPU: "271" }, gateCpu: [280] }).status,
    ).toBe(0);
  });

  it("refuses a gate that fails after printing a cold first-ssh line (ssh answered but never held)", () => {
    const r = run("clean-base", { gateCpu: [280], gateRc: 1 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not reach a real boot");
    expect(r.stdout).not.toContain("ready on");
    expect(r.calls).not.toContain("guest-egress.sh");
  });

  it("refuses when the VM will not stop after a fast boot (no second boot on a running VM)", () => {
    const r = run("clean-base", {
      gateCpu: [4, 280],
      neverStops: true,
      env: { MYCO_FAST_STOP_TIMEOUT: "2" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("VM did not stop after a fast boot");
    expect(r.calls.split("\n").filter((l) => l.startsWith("vm.sh restore")).length).toBe(1);
    expect(r.stdout).not.toContain("ready on");
  });
});
