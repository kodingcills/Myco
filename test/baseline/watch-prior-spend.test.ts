/**
 * The spend the watchdog reports, and the spend the cap enforces (TIF-192).
 *
 * They were different numbers. `watch-c1-arm.sh` summed the run's ledger alone and
 * printed it against the project ceiling:
 *
 *     [watch] rows=9 committed=$2.2268/$9.00
 *
 * which reads as "the project has spent $2.23 of $9" when the project had committed
 * $6.70. The guard in `src/baseline/sweep.ts` is
 *
 *     priorSpendMicros + charged(ledger.c1) + charged(ledger.c2) + reservation
 *
 * so the ledger alone is only the run-local HALF of it. That understatement is the
 * dangerous direction for a watcher whose entire job is to warn before a cap is hit:
 * it will not fire early, and it reads as though the cap were run-local - which is
 * exactly the misreading it caused.
 *
 * These tests pin the relation between the two, so the watcher cannot drift from the
 * guard again without a failure. They run the watcher's own arithmetic on a synthetic
 * ledger: no VM, no API, no network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A HOME with no secrets file.
 *
 * The launcher loads `~/.myco/secrets/anthropic.env` and exits 1 when the key is
 * missing, which happens BEFORE or AFTER the prior-spend guard depending on where the
 * guard sits. A test that inherits the developer's HOME therefore passes locally and
 * fails in CI - which is exactly what happened: the guard was below the key check, and
 * every assertion here saw exit 1 instead of 6. Pointing HOME at an empty directory
 * makes the test measure the guard rather than the machine.
 */
const DUMMY_KEY = "not-a-real-key";

/**
 * A private VM lock path (TIF-202).
 *
 * `scripts/c1-baseline.sh` sources `scripts/vm-lock.sh`, which acquires
 * `$MYCO_VM_LOCK_PATH` or the SHARED `/tmp/myco-win11.vm.lock`. Without this every test
 * that spawns the launcher would take the REAL lock, write its own pid into it, and exit -
 * leaving stale metadata that names a dead process and mimics a live sweep. Measured: the
 * shared lock's text changed to `25410 c1-baseline.sh` and then `57102 c1-baseline.sh`
 * (both dead) during test runs, and I spent time investigating them as mystery launches
 * while a real arm was live.
 *
 * A test must never write a lock another run depends on.
 */
function privateLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-vmlock-"));
  dirs.push(dir);
  return join(dir, "vm.lock");
}

/**
 * The environment for EVERY launcher spawn in this file.
 *
 * One helper rather than a literal per call site, because the property under test is
 * "no spawn can take the shared lock". Three inline env literals meant a fourth spawn
 * could be added without the lock path and nothing would notice - and a file-level check
 * cannot see the difference, since the other spawns still supply it. Routing all three
 * through here makes the omission impossible to express.
 */
function launcherEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    HOME: bareHome(),
    ANTHROPIC_API_KEY: DUMMY_KEY,
    MYCO_VM_LOCK_PATH: privateLockPath(),
    ...overrides,
  };
}

function bareHome(): string {
  // Registered for cleanup like every other temp directory here. It was not, and a
  // single run of this file left 358 `myco-nohome-*` directories behind in the system
  // temp dir - a leak the outer loop spotted as a "minor nit" that was measured at two
  // orders of magnitude more than that. `dirs` is emptied by the `afterEach` below, so
  // anything created here must go into it.
  const dir = mkdtempSync(join(tmpdir(), "myco-nohome-"));
  dirs.push(dir);
  return dir;
}

const scored = (micros: number) => ({ status: "scored", micros });
/** Every temporary directory this file creates, so `afterEach` can remove all of them. */
const dirs: string[] = [];
function ledgerDir(c1: Record<string, { status: string; micros: number }>, c2 = {}) {
  // Under HOME, NOT `tmpdir()`. The launcher refuses a run directory under /tmp or
  // /var/tmp by design (TIF-164: a reboot took arm-003c's ledger), and `tmpdir()` is
  // `/tmp` on Linux CI but `/var/folders/...` on macOS - so this passed locally and
  // exited 2 on the runner. Any test that spawns the real launcher needs a durable
  // path, which is the launcher's own contract.
  const dir = mkdtempSync(join(homedir(), ".myco-watch-test-"));
  // ASSERT THE CONTRACT rather than trusting where `homedir()` happens to point. The
  // launcher refuses a run directory under /tmp, and on Linux CI `tmpdir()` IS /tmp
  // while on macOS it is /var/folders - so a helper using `tmpdir()` passed here and
  // exited 2 on the runner. A direct check catches that on BOTH platforms instead of
  // only where the two disagree.
  if (dir.startsWith("/tmp/") || dir.startsWith("/var/tmp/"))
    throw new Error(`test run directory must not be under /tmp: ${dir}`);
  dirs.push(dir);
  writeFileSync(
    join(dir, "accounting.json"),
    JSON.stringify({ manifestSha256: "x", c1, c2 }, null, 2),
  );
  // The watcher breaks out of its loop when no sweep holds the directory; a
  // progress.log keeps its initial mtime logic happy.
  writeFileSync(join(dir, "progress.log"), "probe\n");
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The watcher's own arithmetic, extracted by running the script's Python block the
 * way the script does. Kept as a shell invocation rather than a reimplementation so
 * a change to the script is what this test sees.
 */
function watchLine(
  dir: string,
  priorDollars: string,
  limit = "900.00",
): { line: string; code: number } {
  // The block lives inside the script; pull it out and run it with the same argv the
  // script passes, so this exercises the real source text.
  const source = execFileSync(
    "sed",
    ["-n", "/^import glob, json/,/^PY$/p", "scripts/watch-c1-arm.sh"],
    {
      encoding: "utf8",
    },
  )
    .replace(/^PY$/m, "")
    .trim();
  // `spawnSync`, not `execFileSync`: breaching the cap makes the watcher EXIT 9, which
  // is the behaviour under test - a helper that threw on it could not observe the
  // very thing it is checking.
  const run = spawnSync("python3", ["-", dir, limit, "0", "25", priorDollars], {
    input: source,
    encoding: "utf8",
  });
  return { line: (run.stdout ?? "").trim(), code: run.status ?? -1 };
}

/**
 * The wiring, not just the arithmetic (round-1 defects F1 and F3).
 *
 * The unit tests above hand the watcher's Python block its argv directly, so they pin
 * the maths but say nothing about the shell that feeds it. A round-1 verifier found
 * exactly that gap: the suite passed whether or not the launcher passed the prior at
 * all, because the watcher silently defaulted it to 0 - reverting to the run-local
 * understatement this change exists to remove, on the one operator path (a resume shell
 * that forgot to export the variable) most likely to hit it.
 */
describe("a missing prior spend is refused, not defaulted", () => {
  it("the watcher refuses to run without its 4th argument", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = ledgerDir({ "0": scored(100_000) });
    const run = spawnSync("bash", ["scripts/watch-c1-arm.sh", dir, "900.00", "25"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
    // Non-zero, and the message names the argument rather than the script silently
    // reporting a number computed from half the ceiling.
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/prior spend is a required argument/);
  });

  it("the launcher refuses when MYCO_PRIOR_SPEND_MICROS is unset", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = ledgerDir({ "0": scored(100_000) });
    const env = launcherEnv({ MYCO_PRIOR_SPEND_MICROS: undefined });
    const run = spawnSync("bash", ["scripts/c1-baseline.sh", dir, "--coordinator-go", "--resume"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    // Exit 6 is the documented code for this refusal, and it must fire BEFORE the VM
    // lock is attempted: a launch that cannot report spend honestly should not take
    // the VM to discover that.
    expect(run.status).toBe(6);
    expect(`${run.stdout}${run.stderr}`).toMatch(/MYCO_PRIOR_SPEND_MICROS is unset/);
  });
});

/**
 * Set is not the same as numeric (round-2 defects D1 and D2).
 *
 * Both round-1 guards tested only that SOMETHING was supplied, so a value that was
 * present but unparseable walked straight through and reverted to run-local arithmetic
 * - the exact understatement the change removes. `""` converts to 0 in `awk`, and
 * `nan`/`-inf`/negatives make `committed > limit` permanently false, so the trigger is
 * disarmed with no error at all.
 */
describe("a non-numeric prior spend is refused, not converted to zero", () => {
  const badPriors = ["", "   ", "abc", "4.5", "-1", "4e6"];

  for (const bad of badPriors) {
    it(`the launcher refuses MYCO_PRIOR_SPEND_MICROS=${JSON.stringify(bad)}`, async () => {
      const { spawnSync } = await import("node:child_process");
      const dir = ledgerDir({ "0": scored(100_000) });
      const run = spawnSync(
        "bash",
        ["scripts/c1-baseline.sh", dir, "--coordinator-go", "--resume"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          // Set but not numeric. Exit 6, not 10: this must be refused before the VM
          // lock is attempted, so it cannot be confused with "the VM is busy".
          env: launcherEnv({ MYCO_PRIOR_SPEND_MICROS: bad }),
          timeout: 20_000,
        },
      );
      expect(run.status).toBe(6);
      expect(`${run.stdout}${run.stderr}`).toMatch(/MYCO_PRIOR_SPEND_MICROS/);
    });
  }

  for (const bad of ["nan", "inf", "-inf", "-3", "abc"]) {
    it(`the watcher refuses a prior of ${JSON.stringify(bad)}`, async () => {
      const { spawnSync } = await import("node:child_process");
      const dir = ledgerDir({ "0": scored(100_000) });
      const source = execFileSync(
        "sed",
        ["-n", "/^import glob, json/,/^PY$/p", "scripts/watch-c1-arm.sh"],
        { encoding: "utf8" },
      )
        .replace(/^PY$/m, "")
        .trim();
      const run = spawnSync("python3", ["-", dir, "4.00", "0", "20", bad], {
        input: source,
        encoding: "utf8",
      });
      // 11 is the refusal code. Without it these values leave `committed > limit`
      // permanently False and the watcher loops for ever, reporting a figure that can
      // never trigger - worse than no watcher, because it looks like one.
      expect(run.status).toBe(11);
      expect(run.stdout).toMatch(/REFUSED prior spend/);
    });
  }
});

/**
 * The launcher must accept and reject EXACTLY the strings the sweep does.
 *
 * A round-3 verifier caught the earlier comment claiming this while checking only the
 * character class: `parseSpendCeiling` also requires `Number.isSafeInteger`, so
 * `9007199254740992` and above were accepted by the launcher and thrown by the sweep.
 * Claiming agreement without checking it is the same defect class as the one this PR
 * fixes, so the test compares the two implementations directly rather than restating
 * an intention.
 */
describe("the launcher agrees with the sweep about valid prior spend", () => {
  const cases = [
    "",
    "   ",
    "abc",
    "4.5",
    "-1",
    "4e6",
    "0",
    "4480732",
    "9007199254740991", // Number.MAX_SAFE_INTEGER
    "9007199254740992", // 2^53 - the first value the sweep refuses
    "9007199254740993",
    "9999999999999999999",
    "123456789012345678901234567890",
  ];

  // 13 launcher spawns, each a real shell run, so the default 5s is not enough.
  it("accepts/rejects the same strings as parseSpendCeiling", { timeout: 120_000 }, async () => {
    const { parseSpendCeiling } = await import("../../scripts/spend-ceiling.ts");
    const { spawnSync } = await import("node:child_process");

    for (const value of cases) {
      // What the sweep would do.
      let sweepAccepts: boolean;
      try {
        parseSpendCeiling({ MYCO_PRIOR_SPEND_MICROS: value, MYCO_ARM_LIMIT_MICROS: "1" });
        sweepAccepts = true;
      } catch {
        sweepAccepts = false;
      }

      // What the launcher does. 6 is its refusal code; anything else means it got past
      // the guard and reached the VM lock, i.e. it accepted the value.
      const dir = ledgerDir({ "0": scored(100_000) });
      const run = spawnSync(
        "bash",
        ["scripts/c1-baseline.sh", dir, "--coordinator-go", "--resume"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          // Same hermeticity as the other launcher tests: an empty HOME and a dummy
          // key, so the run reaches the guard this test is about rather than stopping
          // at the secrets check that precedes it.
          env: launcherEnv({ MYCO_PRIOR_SPEND_MICROS: value }),
          timeout: 20_000,
        },
      );
      const launcherAccepts = run.status !== 6;

      expect(
        { value, launcherAccepts },
        `${JSON.stringify(value)}: sweep=${sweepAccepts ? "accept" : "throw"}`,
      ).toEqual({ value, launcherAccepts: sweepAccepts });
    }
  });
});

describe("the watchdog measures the same spend the cap does", () => {
  it("adds prior spend to the ledger, rather than reporting the ledger alone", () => {
    // 9 scored rows and two live reservations, the shape r6 was in.
    const dir = ledgerDir({
      "0": scored(113_880),
      "1": scored(124_830),
      "2": { status: "reserved", micros: 607_200 },
      "3": scored(131_430),
    });
    const { line } = watchLine(dir, "4.480732");
    // local is the ledger's own sum: 113,880 + 124,830 + 607,200 + 131,430 = 977,340
    expect(line).toContain("local=$0.9773");
    // committed is prior + local: 4.480732 + 0.977340 = 5.458072
    expect(line).toContain("committed=$5.4581");
  });

  it("reports the ledger alone only when prior spend is genuinely zero", () => {
    const dir = ledgerDir({ "0": scored(500_000) });
    const { line } = watchLine(dir, "0");
    expect(line).toContain("local=$0.5000");
    expect(line).toContain("committed=$0.5000");
  });

  it("counts reservations, not just scored rows", () => {
    // The comment above this behaviour is explicit: an omitted trial made real calls,
    // and a reserved row holds a live reservation. A scored-only figure under-reports
    // by the amount most likely to matter near a cap.
    const dir = ledgerDir({
      "0": scored(100_000),
      "1": { status: "reserved", micros: 607_200 },
      "2": { status: "omitted", micros: 250_000 },
    });
    const { line } = watchLine(dir, "0");
    expect(line).toContain("local=$0.9572");
  });

  it("would fire the spend trigger exactly when the cap is reached", () => {
    // The trigger compares `committed > limit`, so the arithmetic above decides it.
    // Prior spend is what makes the difference: with it included, a run that had spent
    // little locally but sits on a large prior trips; run-local it would not, and the
    // warning would never come.
    //
    // Compared in integer micros, not floats: 4.480732 + 0.1 is not exactly 4.580732
    // in binary floating point, and a test that pins the printed digits would be
    // asserting rounding rather than the property.
    const dir = ledgerDir({ "0": scored(100_000) });
    const limitMicros = 4_500_000;
    const priorMicros = 4_480_732;
    const localMicros = 100_000;
    const { line, code } = watchLine(
      dir,
      String(priorMicros / 1_000_000),
      String(limitMicros / 1_000_000),
    );
    const committedMicros = priorMicros + localMicros;
    // The watcher's printed figure rounds to four places; assert the magnitude, then
    // the property in integers.
    expect(line).toContain("local=$0.1000");
    expect(line).toContain("committed=$4.58");
    expect(committedMicros).toBeGreaterThan(limitMicros);
    // The watcher EXITS 9 on a breach, and now that prior spend is included it does
    // so for this run. Run-local it would not have fired at all.
    expect(code).toBe(9);
    expect(localMicros).toBeLessThan(limitMicros);
  });
});
