/**
 * TIF-218: the sweep load gate measures NET load (host 1-min load minus the
 * guest's own QEMU cores), with thresholds from the 2026-11-26 measurement in
 * docs/research/experiments/tif-218-load-gate-2026-11-26/. These tests pin the
 * gate decision (scripts/load-gate.sh) on the measured cases, its fail-closed
 * behaviour, that every copy of the gate uses it, and that the committed
 * summary is what the summary script recomputes from the raw samples.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    // The old raw gate paused here (op2 sweep, 00:16Z at 14.54).
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
