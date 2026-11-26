/**
 * TIF-98 round 2: the M1 trial drivers pin their snapshot per OUT, refuse a
 * resume on a different one, keep comparison runs on clean-base, and put the
 * snapshot the reset reported ready on into every row. These tests run the real
 * scripts/trial-snapshot.sh functions, the drivers' own prelude lines (taken from
 * their source), and both row writers.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corruptionPlan } from "../scripts/m1-corrupt-suite-params.ts";

const ROOT = join(import.meta.dirname, "..");
const LIB = join(ROOT, "scripts", "trial-snapshot.sh");
const DRIVERS = ["scripts/m1-sweep.sh", "scripts/m1-corrupt-suite.sh"];

/** Runs bash with trial-snapshot.sh sourced, in a fresh OUT dir; env is exactly what is given. */
function ts(script: string, env: Record<string, string> = {}, setup?: (out: string) => void) {
  const out = mkdtempSync(join(tmpdir(), "myco-trial-snapshot-"));
  setup?.(out);
  const r = spawnSync("bash", ["-c", `source "$0"; OUT="$1"; ${script}`, LIB, out], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: out, ...env },
  });
  return { out, status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

describe("ts_resolve", () => {
  it("defaults to trial-base-v2 and honours MYCO_TRIAL_SNAPSHOT", () => {
    expect(ts("ts_resolve").stdout).toBe("trial-base-v2");
    expect(ts("ts_resolve", { MYCO_TRIAL_SNAPSHOT: "clean-base" }).stdout).toBe("clean-base");
  });

  it("refuses a live snapshot from the variable (exit 11)", () => {
    const r = ts("ts_resolve", { MYCO_TRIAL_SNAPSHOT: "clean-base-live" });
    expect(r.status).toBe(11);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("REFUSED_SNAPSHOT");
  });

  it("refuses a comparison run unless MYCO_TRIAL_SNAPSHOT is explicitly clean-base", () => {
    expect(ts("ts_resolve", { MYCO_COMPARISON_RUN: "1" }).status).toBe(11);
    expect(
      ts("ts_resolve", { MYCO_COMPARISON_RUN: "1", MYCO_TRIAL_SNAPSHOT: "trial-base-v2" }).status,
    ).toBe(11);
    const ok = ts("ts_resolve", { MYCO_COMPARISON_RUN: "1", MYCO_TRIAL_SNAPSHOT: "clean-base" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("clean-base");
  });
});

describe("ts_pin", () => {
  it("pins the snapshot in OUT/snapshot on the first run", () => {
    const r = ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2');
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.out, "snapshot"), "utf8")).toBe("trial-base-v2\n");
  });

  it("accepts a resume on the pinned snapshot", () => {
    const r = ts('ts_pin "$OUT" "$OUT/trials.jsonl" clean-base', {}, (out) =>
      writeFileSync(join(out, "snapshot"), "clean-base\n"),
    );
    expect(r.status).toBe(0);
  });

  it("refuses a resume on a different snapshot (exit 11) and leaves the pin alone", () => {
    const r = ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2', {}, (out) =>
      writeFileSync(join(out, "snapshot"), "clean-base\n"),
    );
    expect(r.status).toBe(11);
    expect(r.stderr).toContain("REFUSED_SNAPSHOT_MISMATCH");
    expect(readFileSync(join(r.out, "snapshot"), "utf8")).toBe("clean-base\n");
  });

  it("refuses an unpinned OUT that already has rows unless MYCO_TRIAL_SNAPSHOT names it", () => {
    const rows = (out: string) => writeFileSync(join(out, "trials.jsonl"), '{"index": 0}\n');
    const refused = ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2', {}, rows);
    expect(refused.status).toBe(11);
    expect(refused.stderr).toContain("REFUSED_SNAPSHOT_UNKNOWN");
    const named = ts(
      'ts_pin "$OUT" "$OUT/trials.jsonl" clean-base',
      { MYCO_TRIAL_SNAPSHOT: "clean-base" },
      rows,
    );
    expect(named.status).toBe(0);
    expect(readFileSync(join(named.out, "snapshot"), "utf8")).toBe("clean-base\n");
    // Round 3 (N-d): every unpinned OUT predates the switch, so only clean-base may name it.
    const wrong = ts(
      'ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2',
      { MYCO_TRIAL_SNAPSHOT: "trial-base-v2" },
      rows,
    );
    expect(wrong.status).toBe(11);
    expect(wrong.stderr).toContain("REFUSED_SNAPSHOT_UNKNOWN");
  });

  // Round 3 (N-c): never write or read the pin through a symlink, dangling or not.
  it("refuses a symlink at OUT/snapshot and never writes through it", () => {
    const dangling = ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2', {}, (out) =>
      symlinkSync(join(out, "elsewhere"), join(out, "snapshot")),
    );
    expect(dangling.status).toBe(11);
    expect(dangling.stderr).toContain("REFUSED_SNAPSHOT_PIN");
    expect(existsSync(join(dangling.out, "elsewhere"))).toBe(false);
    const toFile = ts('ts_pin "$OUT" "$OUT/trials.jsonl" clean-base', {}, (out) => {
      writeFileSync(join(out, "real"), "clean-base\n");
      symlinkSync(join(out, "real"), join(out, "snapshot"));
    });
    expect(toFile.status).toBe(11);
  });
});

// Round 3 (D1' a): the comparison flag is strict; a typo never means "not a comparison".
describe("ts_resolve: strict MYCO_COMPARISON_RUN", () => {
  it.each(["1 ", " 1", "true", "yes", "01", "TRUE", "on", " "])(
    "MYCO_COMPARISON_RUN=%j is refused (exit 11)",
    (value) => {
      const r = ts("ts_resolve", { MYCO_COMPARISON_RUN: value, MYCO_TRIAL_SNAPSHOT: "clean-base" });
      expect(r.status).toBe(11);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("is not empty, 0 or 1");
    },
  );

  it("empty and 0 mean no comparison (the default applies)", () => {
    expect(ts("ts_resolve", { MYCO_COMPARISON_RUN: "" }).stdout).toBe("trial-base-v2");
    expect(ts("ts_resolve", { MYCO_COMPARISON_RUN: "0" }).stdout).toBe("trial-base-v2");
  });
});

// Round 3 (N-a): only a Myco trial base resolves, so a typo fails at pin time.
describe("ts_resolve: allowlist", () => {
  it.each([
    "Clean-Base",
    "cua-c1-base",
    "trial-base-v3",
    "m1-agent-live",
    "$(touch pwned)",
    "../clean-base",
  ])("MYCO_TRIAL_SNAPSHOT=%j is refused at resolve time (exit 11)", (name) => {
    const r = ts("ts_resolve", { MYCO_TRIAL_SNAPSHOT: name });
    expect(r.status).toBe(11);
    expect(r.stdout).toBe("");
    expect(existsSync(join(r.out, "pwned"))).toBe(false);
  });
});

describe("ts_reset", () => {
  /**
   * A stub reset script that prints `ready on '<what>'` and exits <rc>. With
   * ready = "$1" it echoes back the snapshot it was given, the way the real reset
   * does, so a ts_reset that drops the argument is caught (round 2 V1).
   */
  function stub(out: string, ready: string, rc = 0): string {
    const p = join(out, "reset.sh");
    writeFileSync(
      p,
      `#!/bin/bash\necho "reset-trial-vm: timing total=1"\n${ready ? `echo "reset-trial-vm: ready on '${ready}'"` : ""}\nexit ${rc}\n`,
      { mode: 0o755 },
    );
    return p;
  }
  const run = (ready: string, rc = 0) => {
    const out = mkdtempSync(join(tmpdir(), "myco-ts-reset-"));
    const script = stub(out, ready, rc);
    return ts(
      'ts_reset trial-base-v2 "$OUT/progress.log"; echo "rc=$? ready=$TS_READY"; cat "$OUT/progress.log"',
      { MYCO_RESET_SCRIPT: script },
    );
  };

  it("passes the snapshot to the reset as its argument (the stub echoes $1)", () => {
    const r = run("$1");
    expect(r.stdout.split("\n")[0]).toBe("rc=0 ready=trial-base-v2");
  });

  it("passes the snapshot explicitly and sets TS_READY from the ready line", () => {
    const r = run("trial-base-v2");
    expect(r.stdout.split("\n")[0]).toBe("rc=0 ready=trial-base-v2");
    expect(r.stdout).toContain("reset-trial-vm: ready on 'trial-base-v2'");
  });

  it("returns 12 when the reset reports ready on a different snapshot", () => {
    const r = run("clean-base");
    expect(r.stdout.split("\n")[0]).toBe("rc=12 ready=clean-base");
    expect(r.stderr).toContain("SNAPSHOT_READY_MISMATCH");
  });

  it("returns the reset's own failure, with no ready snapshot", () => {
    expect(run("", 1).stdout.split("\n")[0]).toBe("rc=1 ready=");
  });
});

describe("the drivers use it", () => {
  for (const driver of DRIVERS) {
    const src = readFileSync(join(ROOT, driver), "utf8");

    it(`${driver}: pins before any trial, resets only through ts_reset, aborts on a ready mismatch`, () => {
      expect(src).toContain('source "$WS/scripts/trial-snapshot.sh"');
      expect(src).toContain('SNAP=$(ts_resolve 2>>"$PROGRESS") || exit 11');
      expect(src).toContain('ts_pin "$OUT" "$LOG" "$SNAP" 2>>"$PROGRESS" || exit 11');
      expect(src.indexOf("ts_pin")).toBeLessThan(src.indexOf("=== trial"));
      expect(src).toContain('ts_reset "$SNAP" "$PROGRESS" 2>>"$PROGRESS"; RESET_RC=$?');
      expect(src).toMatch(
        /if \[ "\$RESET_RC" -eq 12 \]; then\n[^\n]*ABORT_SNAPSHOT_MISMATCH[^\n]*exit 12/,
      );
      expect(src).not.toMatch(/bash scripts\/reset-trial-vm\.sh/);
    });

    it(`${driver}: its own prelude refuses a resume on a different snapshot (exit 11)`, () => {
      const prelude = [
        src.match(/\nSNAP=\$\(ts_resolve[^\n]*\n/)?.[0],
        src.match(/\nts_pin "\$OUT"[^\n]*\n/)?.[0],
      ];
      expect(prelude.every(Boolean)).toBe(true);
      const body = `PROGRESS="$OUT/progress.log"; LOG="$OUT/trials.jsonl"\n${prelude.join("")}echo REACHED`;
      const mismatch = ts(body, {}, (out) => writeFileSync(join(out, "snapshot"), "clean-base\n"));
      expect(mismatch.status).toBe(11);
      expect(mismatch.stdout).not.toContain("REACHED");
      expect(readFileSync(join(mismatch.out, "progress.log"), "utf8")).toContain(
        "REFUSED_SNAPSHOT_MISMATCH",
      );
      const comparison = ts(body, { MYCO_COMPARISON_RUN: "1" });
      expect(comparison.status).toBe(11);
      const fresh = ts(body);
      expect(fresh.stdout).toBe("REACHED");
      expect(readFileSync(join(fresh.out, "snapshot"), "utf8")).toBe("trial-base-v2\n");
    });
  }

  it("m1-sweep.sh passes the ready snapshot to its row writer, and puts it on every echoed row", () => {
    const src = readFileSync(join(ROOT, "scripts/m1-sweep.sh"), "utf8");
    expect(src).toContain('"$FPRINTS" "$AC_POWER" "$TS_READY" "$TS_BOOT" >> "$LOG"');
    const echoed = src.match(/echo "\{\\"index\\": \$i, \\"status\\": [^\n]*/g) ?? [];
    expect(echoed.length).toBe(4);
    // Round 3 (V5): no reset reached ready on param-error / reset-failed, so those are null;
    // deploy-failed / token-failed come after a ready reset and carry its snapshot.
    const byStatus = Object.fromEntries(
      echoed.map((row) => [row.match(/\\"status\\": \\"([a-z-]+)\\"/)?.[1], row]),
    );
    expect(byStatus["param-error"]).toMatch(/\\"snapshot\\": null\}/);
    expect(byStatus["reset-failed"]).toMatch(/\\"snapshot\\": null\}/);
    expect(byStatus["deploy-failed"]).toMatch(/\\"snapshot\\": \\"\$TS_READY\\"\}/);
    expect(byStatus["token-failed"]).toMatch(/\\"snapshot\\": \\"\$TS_READY\\"\}/);
  });

  it("m1-corrupt-suite.sh passes the ready snapshot on every row it records", () => {
    const src = readFileSync(join(ROOT, "scripts/m1-corrupt-suite.sh"), "utf8");
    expect(src).toContain(
      'row=$(python3 "$RECORDER" --record "$PARAMS" "$@" "--snapshot=$TS_READY" "--reset-boot=$TS_BOOT") || exit 1',
    );
  });
});

describe("row writers carry snapshot", () => {
  it("m1-sweep-record.py: the 9th argument becomes `snapshot`; absent, the key is still there as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-sweep-row-"));
    const fp = join(dir, "fp.json");
    writeFileSync(fp, "{}");
    const rec = (...extra: string[]) =>
      JSON.parse(
        spawnSync(
          "python3",
          [
            join(ROOT, "scripts", "m1-sweep-record.py"),
            "3",
            "seed-b",
            "EMP-0001",
            "qty",
            "1",
            join(dir, "none.json"),
            fp,
            ...extra,
          ],
          { encoding: "utf8" },
        ).stdout,
      );
    expect(rec("yes", "trial-base-v2")).toMatchObject({
      snapshot: "trial-base-v2",
      acPower: "yes",
    });
    const bare = rec();
    expect(Object.hasOwn(bare, "snapshot")).toBe(true);
    expect(bare.snapshot).toBeNull();
  });

  it("m1-corrupt-suite-record.py: --snapshot= becomes `snapshot` on report and failure rows alike", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-corrupt-row-"));
    mkdirSync(join(dir, "runs"));
    const manifest = join(dir, "params.json");
    writeFileSync(manifest, JSON.stringify(corruptionPlan()));
    const rec = (...args: string[]) =>
      JSON.parse(
        spawnSync(
          "python3",
          [join(ROOT, "scripts", "m1-corrupt-suite-record.py"), "--record", manifest, ...args],
          {
            encoding: "utf8",
          },
        ).stdout,
      );
    expect(rec("0", "deploy-failed", "--snapshot=trial-base-v2").snapshot).toBe("trial-base-v2");
    const failed = rec("0", "reset-failed", "--snapshot=");
    expect(Object.hasOwn(failed, "snapshot")).toBe(true);
    expect(failed.snapshot).toBeNull();
    expect(rec("0", "report", join(dir, "missing.out"), "--snapshot=clean-base")).toMatchObject({
      snapshot: "clean-base",
      status: "harness-error",
    });
  });
});

// Round 1 N1: the callers that must NOT follow the default name their snapshot explicitly.
describe("explicit-snapshot callers", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  it("C1 resets to RESET_SNAPSHOT = cua-c1-base, passed explicitly", () => {
    expect(read("src/baseline/c1-trial.ts")).toContain(
      'export const RESET_SNAPSHOT = "cua-c1-base";',
    );
    expect(read("scripts/c1-sweep.ts")).toContain(
      'execFileSync("bash", ["scripts/reset-trial-vm.sh", snapshot]',
    );
    expect(read("scripts/c1-spike.ts")).toContain(
      'execFileSync("bash", ["scripts/reset-trial-vm.sh", RESET_SNAPSHOT]',
    );
  });
  it("base-parity.sh and build-trial-base.sh pass their snapshot explicitly", () => {
    expect(read("scripts/base-parity.sh")).toContain('bash scripts/reset-trial-vm.sh "$base"');
    expect(read("scripts/build-trial-base.sh")).toContain(
      'MYCO_GUEST_EGRESS=open bash "$RESET" "$FROM"',
    );
  });
});

// TIF-98 cold-boot record: ts_reset parses the reset's boot and timing lines, and both row
// writers carry the measured reset on every row (null when there is none).
describe("reset boot record (TIF-98 cold-boot check)", () => {
  const stubReset = (lines: string[]) => {
    const out = mkdtempSync(join(tmpdir(), "myco-ts-boot-"));
    const p = join(out, "reset.sh");
    writeFileSync(p, `#!/bin/bash\n${lines.map((l) => `echo "${l}"`).join("\n")}\nexit 0\n`, {
      mode: 0o755,
    });
    return p;
  };
  const tsBoot = (lines: string[]) =>
    ts('ts_reset trial-base-v2 "$OUT/progress.log"; echo "rc=$? boot=$TS_BOOT"', {
      MYCO_RESET_SCRIPT: stubReset(lines),
    }).stdout;

  it("ts_reset sets TS_BOOT to class:first_ssh:cpu:total:attempts", () => {
    expect(
      tsBoot([
        "reset-trial-vm: boot class=cold first_ssh_s=143 guest_cpu_first_ssh_s=291 attempts=2",
        "reset-trial-vm: timing stop=0 restore=3 total=205",
        "reset-trial-vm: ready on 'trial-base-v2'",
      ]),
    ).toBe("rc=0 boot=cold:143:291:205:2");
  });

  it("TS_BOOT is empty when the reset printed no boot line", () => {
    expect(
      tsBoot([
        "reset-trial-vm: timing stop=0 total=160",
        "reset-trial-vm: ready on 'trial-base-v2'",
      ]),
    ).toBe("rc=0 boot=");
  });

  it("m1-sweep-record.py carries the reset record as fields, null when absent or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-sweep-boot-"));
    const fp = join(dir, "fp.json");
    writeFileSync(fp, "{}");
    const rec = (...extra: string[]) =>
      JSON.parse(
        spawnSync(
          "python3",
          [
            join(ROOT, "scripts", "m1-sweep-record.py"),
            "3",
            "seed-b",
            "EMP-0001",
            "qty",
            "1",
            join(dir, "none.json"),
            fp,
            ...extra,
          ],
          { encoding: "utf8" },
        ).stdout,
      );
    expect(rec("yes", "trial-base-v2", "cold:143:291:205:2")).toMatchObject({
      resetBootClass: "cold",
      resetFirstSshS: 143,
      resetGuestCpuFirstSshS: 291,
      resetTotalS: 205,
      resetBootAttempts: 2,
    });
    for (const bad of [
      [],
      ["yes", "trial-base-v2", ""],
      ["yes", "trial-base-v2", "warm:1:2:3:4"],
      ["yes", "trial-base-v2", "cold:1:2"],
    ]) {
      const row = rec(...bad);
      expect(Object.hasOwn(row, "resetBootClass")).toBe(true);
      expect(row.resetBootClass).toBeNull();
      expect(row.resetTotalS).toBeNull();
    }
  });

  it("m1-corrupt-suite-record.py carries --reset-boot= as fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-corrupt-boot-"));
    const manifest = join(dir, "params.json");
    writeFileSync(manifest, JSON.stringify(corruptionPlan()));
    const rec = (...args: string[]) =>
      JSON.parse(
        spawnSync(
          "python3",
          [join(ROOT, "scripts", "m1-corrupt-suite-record.py"), "--record", manifest, ...args],
          {
            encoding: "utf8",
          },
        ).stdout,
      );
    expect(
      rec("0", "deploy-failed", "--snapshot=trial-base-v2", "--reset-boot=cold:150:280:170:1"),
    ).toMatchObject({
      resetBootClass: "cold",
      resetGuestCpuFirstSshS: 280,
      resetTotalS: 170,
    });
    expect(rec("0", "reset-failed", "--snapshot=", "--reset-boot=").resetBootClass).toBeNull();
  });
});

// #529 S4: a deleted pin cannot turn an OUT into a mixed one.
describe("ts_pin with a deleted pin", () => {
  const rows = (snap: string) => (out: string) =>
    writeFileSync(
      join(out, "trials.jsonl"),
      `{"index": 0, "snapshot": "${snap}"}\n{"index": 1, "snapshot": null}\n`,
    );

  it("refuses a resume whose rows record a different snapshot, even as clean-base", () => {
    const r = ts(
      'ts_pin "$OUT" "$OUT/trials.jsonl" clean-base',
      { MYCO_TRIAL_SNAPSHOT: "clean-base" },
      rows("trial-base-v2"),
    );
    expect(r.status).toBe(11);
    expect(r.stderr).toContain("REFUSED_SNAPSHOT_PIN_DELETED");
    expect(existsSync(join(r.out, "snapshot"))).toBe(false);
  });

  it("re-pins when every recorded snapshot is the one this run resolves", () => {
    const r = ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2', {}, rows("trial-base-v2"));
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.out, "snapshot"), "utf8")).toBe("trial-base-v2\n");
  });

  it("refuses rows that record two snapshots", () => {
    const mixed = (out: string) =>
      writeFileSync(
        join(out, "trials.jsonl"),
        '{"snapshot": "trial-base-v2"}\n{"snapshot": "clean-base"}\n',
      );
    expect(ts('ts_pin "$OUT" "$OUT/trials.jsonl" trial-base-v2', {}, mixed).status).toBe(11);
  });
});
