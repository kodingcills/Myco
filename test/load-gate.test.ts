/**
 * TIF-218: the sweep load gate measures NET load (host 1-min load minus the
 * guest's own QEMU cores), with thresholds from the 2026-11-26 measurement in
 * docs/research/experiments/tif-218-load-gate-2026-11-26/. These tests pin the
 * gate decision (scripts/load-gate.sh) on the measured cases, its fail-closed
 * behaviour, that every copy of the gate uses it, and that the committed
 * summary is what the summary script recomputes from the raw samples.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const LIB = join(ROOT, "scripts", "load-gate.sh");
const EVIDENCE = join(ROOT, "docs", "research", "experiments", "tif-218-load-gate-2026-11-26");

/** Runs `source load-gate.sh; <fn> <args>` and returns stdout and the exit status. */
function gate(fn: string, ...args: string[]): { out: string; status: number | null } {
  const r = spawnSync("bash", ["-c", `source "$0"; ${fn} "$@"`, LIB, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return { out: r.stdout.trim(), status: r.status };
}

describe("lg_decide (pause gate, checked before each trial)", () => {
  it("does not pause on the guest's own load: raw 14.54 with QEMU at 2.5 cores is net 12.04", () => {
    // The old raw gate paused at 14.54 (op2 sweep, 00:16Z). QEMU's share was not measured then;
    // 2.5 cores is an assumed value, near the measured reset median (2.51).
    const r = gate("lg_decide", "14.54", "2.5", "1600");
    expect(r.status).toBe(0);
    expect(r.out).toBe("ok net=12.04 load1=14.54 qemu=2.5");
  });

  it("passes the measured worst guest-only case: back-to-back resets, raw 13.23 with QEMU at 2.06", () => {
    expect(gate("lg_decide", "13.23", "2.06", "1691").status).toBe(0);
  });

  it("pauses on host contention the guest does not explain (exit 4)", () => {
    // The 16.33 sample in v2-idle, with QEMU at 2% of a core.
    const r = gate("lg_decide", "16.33", "0.02", "1683");
    expect(r.status).toBe(4);
    expect(r.out).toBe("PAUSED_LOAD net=16.31 load1=16.33 qemu=0.02");
  });

  it("pauses strictly above 14: net 14.00 passes, net 14.01 pauses", () => {
    expect(gate("lg_decide", "16.00", "2.00", "1600").status).toBe(0);
    expect(gate("lg_decide", "16.01", "2.00", "1600").status).toBe(4);
  });

  it("subtracts nothing when the QEMU share is unreadable (falls back to the raw load)", () => {
    expect(gate("lg_decide", "14.5", "", "1600").status).toBe(4);
    expect(gate("lg_decide", "14.5", "n/a", "1600").status).toBe(4);
  });

  it("fails closed on an unreadable load (exit 4)", () => {
    const r = gate("lg_decide", "", "1.0", "1600");
    expect(r.status).toBe(4);
    expect(r.out).toBe("PAUSED_LOAD load1=unreadable");
  });

  it("pauses under memory pressure whatever the load: swap free below 300 MB (exit 6)", () => {
    expect(gate("lg_decide", "1.0", "0.5", "299").status).toBe(6);
    expect(gate("lg_decide", "1.0", "0.5", "300").status).toBe(0);
  });

  it("fails closed on unreadable swap (exit 6)", () => {
    const r = gate("lg_decide", "1.0", "0.5", "");
    expect(r.status).toBe(6);
    expect(r.out).toBe("PAUSED_SWAP free=unreadableM");
    // Non-numeric text (a changed sysctl format) must pause too, not compare as a string.
    expect(gate("lg_decide", "1.0", "0.5", "n/a").status).toBe(6);
  });
});

describe("lg_resume_sample_ok (resume gate: 7 consecutive samples under it)", () => {
  it("counts a guest-loaded host as clear: raw 12.5 with QEMU at 2.6 is net 9.9", () => {
    expect(gate("lg_resume_sample_ok", "12.5", "2.6").status).toBe(0);
  });

  it("requires net strictly under 10", () => {
    expect(gate("lg_resume_sample_ok", "10.0", "0").status).toBe(1);
    expect(gate("lg_resume_sample_ok", "9.99", "0").status).toBe(0);
  });

  it("is not clear on an unreadable load", () => {
    expect(gate("lg_resume_sample_ok", "", "0").status).toBe(1);
  });

  it("keeps a hysteresis band: the resume line is below the pause line", () => {
    const r = spawnSync("bash", ["-c", 'source "$0"; echo "$LG_RESUME_NET $LG_PAUSE_NET"', LIB], {
      encoding: "utf8",
    });
    const [resume, pause] = r.stdout.trim().split(" ").map(Number);
    expect(resume).toBe(10);
    expect(pause).toBe(14);
  });
});

describe("every copy of the gate uses scripts/load-gate.sh", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  for (const driver of ["scripts/m1-sweep.sh", "scripts/m1-corrupt-suite.sh"]) {
    it(`${driver} decides with lg_now_decide and keeps no raw-load gate`, () => {
      const s = read(driver);
      expect(s).toContain('source "$WS/scripts/load-gate.sh"');
      expect(s).toContain("GATE=$(lg_now_decide); GATE_RC=$?");
      expect(s).not.toMatch(/l>14\.0/);
      expect(s).not.toMatch(/SWAP_FREE:-9999/);
    });
  }

  it("scripts/reset-bench.sh gates on net load", () => {
    const s = read("scripts/reset-bench.sh");
    expect(s).toContain('source "$REPO/scripts/load-gate.sh"');
    expect(s).toMatch(/l=\$\(net_load\)\n\s+over "\$l" \|\| return 0/);
  });

  it("the runbook's supervisor resumes on lg_resume_sample_ok", () => {
    const s = read("docs/eval-runbook.md");
    expect(s).toContain('if lock_free && lg_resume_sample_ok "$l" "$q"; then');
    expect(s).not.toContain("awk -v l=\"$l\" 'BEGIN{exit !(l<10)}'");
  });
});

describe("the committed evidence summary is recomputable", () => {
  it("summary.md is what load-gate-summary.py prints for samples.jsonl", () => {
    const r = spawnSync(
      "python3",
      [join(ROOT, "scripts", "load-gate-summary.py"), join(EVIDENCE, "samples.jsonl")],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    expect(readFileSync(join(EVIDENCE, "summary.md"), "utf8")).toBe(r.stdout);
  });
});

// ---------------------------------------------------------------------------
// Round 2 (verifier D1, D2, N3, N5, N6): the host readers and the drivers' gate
// blocks, executed against a fake `sysctl` and `ps` put first on PATH.

const FAKE = mkdtempSync(join(tmpdir(), "myco-load-gate-"));
afterAll(() => rmSync(FAKE, { recursive: true, force: true }));
writeFileSync(
  join(FAKE, "sysctl"),
  `#!/bin/bash
case "$*" in
  "-n vm.loadavg") [ -n "\${FAKE_SYSCTL_FAIL:-}" ] && exit 1; printf '%s\\n' "\${FAKE_LOADAVG:-}" ;;
  "-n vm.swapusage") printf '%s\\n' "\${FAKE_SWAP:-}" ;;
  *) exit 1 ;;
esac
`,
  { mode: 0o755 },
);
// Prints FAKE_PS verbatim, whatever the -o format asked for (the readers ask for pcpu=,comm=).
writeFileSync(join(FAKE, "ps"), `#!/bin/bash\nprintf '%s\\n' "\${FAKE_PS:-}"\n`, { mode: 0o755 });

const SWAP_OK = "total = 4096.00M  used = 2413.44M  free = 1682.56M  (encrypted)";
const LAUNCHER =
  "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher";

/** Runs bash with the library sourced and the fakes first on PATH. */
function host(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `source "$0"; ${script}`, LIB], {
    encoding: "utf8",
    env: { PATH: `${FAKE}:/usr/bin:/bin`, ...env },
  });
  return { out: r.stdout.trim(), status: r.status };
}

describe("host readers (fake sysctl / ps)", () => {
  // Two real QEMULauncher processes (one guest runs as 2), a launcher under a path with
  // spaces, and look-alikes that must NOT be subtracted.
  const PS = [
    `  12.0 ${LAUNCHER}`,
    `  250.0 ${LAUNCHER}`,
    "  55.0 /Applications/My Apps/UTM copy.app/QEMULauncher",
    "  99.0 /usr/local/bin/myqemu",
    "  77.0 /opt/homebrew/bin/qemu-img",
    "  66.0 /opt/homebrew/bin/qemu-system-aarch64",
    "  44.0 /x/myQEMULauncher",
    "  33.0 /x/QEMULauncherX",
    "  22.0 /x/QEMULauncher.sh",
    "  5.0 /usr/sbin/syslogd",
  ].join("\n");

  it("lg_qemu_cores sums exact-basename QEMULauncher processes only, in cores (/100)", () => {
    // 12 + 250 + 55 = 317 %cpu = 3.17 cores; every look-alike is ignored.
    expect(host("lg_qemu_cores", { FAKE_PS: PS }).out).toBe("3.17");
  });

  it("lg_qemu_cores is 0.00 when no guest runs", () => {
    expect(host("lg_qemu_cores", { FAKE_PS: "  5.0 /usr/sbin/syslogd" }).out).toBe("0.00");
  });

  it("lg_load1 takes the 1-minute field (field 2 of `{ 1m 5m 15m }`)", () => {
    expect(host("lg_load1", { FAKE_LOADAVG: "{ 5.55 4.90 4.33 }" }).out).toBe("5.55");
  });

  it("lg_swap_free_mb reads the free field, not used or total", () => {
    expect(host("lg_swap_free_mb", { FAKE_SWAP: SWAP_OK }).out).toBe("1682.56");
  });

  it("lg_swap_free_mb is empty on an unexpected format", () => {
    expect(host("lg_swap_free_mb", { FAKE_SWAP: "weird" }).out).toBe("");
    expect(host("lg_swap_free_mb", { FAKE_SWAP: "free = 2.00G" }).out).toBe("");
  });

  it("lg_now_decide end to end: the guest's share is subtracted (raw 15.20, QEMU 3.17 -> net 12.03 ok)", () => {
    const r = host("lg_now_decide", {
      FAKE_LOADAVG: "{ 15.20 9.00 8.00 }",
      FAKE_SWAP: SWAP_OK,
      FAKE_PS: PS,
    });
    expect(r.status).toBe(0);
    expect(r.out).toBe("ok net=12.03 load1=15.20 qemu=3.17");
  });

  it("lg_now_decide end to end: host contention with a light guest pauses (raw 20, QEMU 0.50 -> net 19.50)", () => {
    const r = host("lg_now_decide", {
      FAKE_LOADAVG: "{ 20.00 9.00 8.00 }",
      FAKE_SWAP: SWAP_OK,
      FAKE_PS: `  50.0 ${LAUNCHER}`,
    });
    expect(r.status).toBe(4);
    expect(r.out).toBe("PAUSED_LOAD net=19.50 load1=20.00 qemu=0.50");
  });

  it("lg_now_decide end to end: sysctl failing pauses (exit 4), unreadable swap pauses (exit 6)", () => {
    expect(host("lg_now_decide", { FAKE_SYSCTL_FAIL: "1", FAKE_SWAP: SWAP_OK }).status).toBe(4);
    expect(
      host("lg_now_decide", { FAKE_LOADAVG: "{ 3.00 3.00 3.00 }", FAKE_SWAP: "weird" }).status,
    ).toBe(6);
  });

  it("lg_now_resume_ok end to end: raw 12.50 with QEMU 2.60 is net 9.90, clear", () => {
    expect(
      host("lg_now_resume_ok", {
        FAKE_LOADAVG: "{ 12.50 9.00 8.00 }",
        FAKE_PS: `  260.0 ${LAUNCHER}`,
      }).status,
    ).toBe(0);
  });
});

describe("gate edge cases (N3, N6, floor)", () => {
  it("lg_net floors at 0 when QEMU exceeds the load", () => {
    expect(host("lg_net 3 15").out).toBe("0.00");
  });

  it("prints qemu=unreadable for a non-numeric QEMU share (nan), and subtracts nothing", () => {
    const r = host("lg_decide 14.5 nan 1600");
    expect(r.status).toBe(4);
    expect(r.out).toBe("PAUSED_LOAD net=14.50 load1=14.5 qemu=unreadable");
  });

  it("a non-numeric threshold override pauses instead of comparing as a string", () => {
    expect(host("lg_decide 50 0 1600", { LG_PAUSE_NET: "abc" }).out).toBe(
      "PAUSED_LOAD gate-config-invalid",
    );
    expect(host("lg_decide 1 0 1600", { LG_MIN_SWAP_FREE_MB: "abc" }).status).toBe(4);
    expect(host("lg_resume_sample_ok 1 0", { LG_RESUME_NET: "abc" }).status).toBe(1);
  });
});

/** The driver's own gate block, taken from its source: GATE=... through its closing fi. */
function gateBlock(driver: string): string {
  const s = readFileSync(join(ROOT, driver), "utf8");
  const m = s.match(/\n( {2}GATE=\$\(lg_now_decide\); GATE_RC=\$\?\n[\s\S]*?\n {2}fi\n)/);
  if (!m?.[1]) throw new Error(`no gate block in ${driver}`);
  return m[1];
}

describe("the drivers' gate blocks, executed (D2)", () => {
  for (const driver of ["scripts/m1-sweep.sh", "scripts/m1-corrupt-suite.sh"]) {
    const run = (env: Record<string, string>) => {
      const progress = join(FAKE, `${driver.replace(/\W/g, "_")}.progress`);
      writeFileSync(progress, "");
      const r = host(`PROGRESS="${progress}"; i=7\n${gateBlock(driver)}echo REACHED_TRIAL`, env);
      return { ...r, progress: readFileSync(progress, "utf8") };
    };

    it(`${driver}: a load pause exits 4 and logs it`, () => {
      const r = run({ FAKE_LOADAVG: "{ 20.00 1 1 }", FAKE_SWAP: SWAP_OK, FAKE_PS: "" });
      expect(r.status).toBe(4);
      expect(r.out).not.toContain("REACHED_TRIAL");
      expect(r.progress).toMatch(/^PAUSED_LOAD net=20\.00 load1=20\.00 qemu=0\.00 at trial 7 /);
    });

    it(`${driver}: a swap pause exits 6, and unreadable load exits 4`, () => {
      expect(
        run({ FAKE_LOADAVG: "{ 2.00 1 1 }", FAKE_SWAP: "total = 1M  used = 1M  free = 120.00M" })
          .status,
      ).toBe(6);
      expect(run({ FAKE_SYSCTL_FAIL: "1", FAKE_SWAP: SWAP_OK }).status).toBe(4);
    });

    it(`${driver}: a clear gate falls through to the trial`, () => {
      const r = run({
        FAKE_LOADAVG: "{ 13.00 1 1 }",
        FAKE_SWAP: SWAP_OK,
        FAKE_PS: `  250.0 ${LAUNCHER}`,
      });
      expect(r.status).toBe(0);
      expect(r.out).toBe("REACHED_TRIAL");
      expect(r.progress).toBe("");
    });
  }

  it("the runbook supervisor resumes only after exit 4 (a swap pause, 6, stops it)", () => {
    expect(readFileSync(join(ROOT, "docs", "eval-runbook.md"), "utf8")).toContain(
      '[ "$rc" -ne 4 ] && break',
    );
  });

  /** reset-bench.sh's own net_load and over definitions, taken from its source. */
  function benchGate(): string {
    const s = readFileSync(join(ROOT, "scripts", "reset-bench.sh"), "utf8");
    const net = s.match(/\nnet_load\(\) \{.*\}\n/)?.[0];
    const over = s.match(/\nover\(\) \{.*\}\n/)?.[0];
    if (!net || !over) throw new Error("reset-bench.sh: net_load/over not found");
    return `LOAD_LIMIT=10\n${net}${over}`;
  }

  it("reset-bench.sh: an unreadable load reads as 999 and holds the gate (fail closed)", () => {
    const r = host(`${benchGate()}n=$(net_load); echo "$n"; over "$n" && echo HOLD`, {
      FAKE_SYSCTL_FAIL: "1",
    });
    expect(r.out).toBe("999\nHOLD");
  });

  it("reset-bench.sh: net_load subtracts the guest (raw 12.00, QEMU 3.00 -> 9.00, no hold)", () => {
    const r = host(`${benchGate()}n=$(net_load); echo "$n"; over "$n" && echo HOLD`, {
      FAKE_LOADAVG: "{ 12.00 1 1 }",
      FAKE_PS: `  300.0 ${LAUNCHER}`,
    });
    expect(r.out).toBe("9.00");
  });
});
