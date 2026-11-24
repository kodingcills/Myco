/**
 * Tests must not touch a live run directory (TIF-194).
 *
 * While checking exit codes I ran the real launcher against
 * `~/Projects/myco-runs/c1-r6` — a live, paid run — and its five refusals were appended
 * to that run's own `progress.log`. The ledger was untouched, but a run's record is
 * evidence, and evidence a probe can write to is not evidence.
 *
 * This is a static guard rather than a behavioural one: it reads the test sources and
 * fails if any of them names a shared or live run path. A behavioural test could only
 * catch the paths it happens to exercise; this catches the whole class, including a test
 * added later by someone who has not read this file.
 *
 * The itch it scratches is real and recurring: `watch-prior-spend.test.ts` failed CI
 * twice on environment assumptions (a developer's secrets file, then `tmpdir()` being
 * `/tmp` on Linux but not macOS) before it was made hermetic. Anything that reaches out
 * of a temporary directory is a portability and contamination hazard at once.
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_ROOT = join(process.cwd(), "test");

/** Every test source, so a new file is covered without being listed here. */
function testSources(): { path: string; text: string }[] {
  return globSync("**/*.{ts,tsx,py,sh}", { cwd: TEST_ROOT })
    .map((rel) => ({
      path: join(TEST_ROOT, rel),
      text: readFileSync(join(TEST_ROOT, rel), "utf8"),
    }))
    .filter(({ path }) => !path.endsWith("probe-directory.test.ts"));
}

describe("no test writes into a live run", () => {
  it("names no run directory outside a temporary one", () => {
    // The real run locations. A test has no business naming any of them: this one is
    // exempted above, because it has to talk about them to forbid them.
    const livePaths = [/\/myco-runs\//, /c1-r6/, /c1-arm003d/, /m1-013-sweep/];
    const offenders = testSources()
      .filter(({ text }) => livePaths.some((pattern) => pattern.test(text)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("builds its run directories from a temporary base, not a shared one", () => {
    // A `c1-baseline.sh <dir>` call with a literal path would write into that path. The
    // accepted forms all derive the directory from mkdtemp or a fixture helper.
    const invocations = testSources().filter(({ text }) => /c1-baseline\.sh/.test(text));
    expect(invocations.length).toBeGreaterThan(0);
    for (const { path, text } of invocations) {
      // Every mention must be inside a spawn whose arg is an identifier, not a literal
      // path. A quoted absolute path is the thing that produced the incident.
      const literalPath = /"\/[^"]*c1-baseline|\/Users\/|\/home\//.test(text);
      expect({ path, literalPath }).toEqual({ path, literalPath: false });
    }
  });

  it("never lets a test write the SHARED VM lock", () => {
    // TIF-202. `scripts/c1-baseline.sh` sources `scripts/vm-lock.sh`, which acquires
    // `$MYCO_VM_LOCK_PATH` or the shared `/tmp/myco-win11.vm.lock`. A test that spawns the
    // launcher without setting that variable takes the REAL lock, writes its own pid into
    // it, and exits - leaving metadata that names a dead process and looks exactly like a
    // live sweep. Measured: the shared lock's text changed to `25410 c1-baseline.sh`, then
    // `57102 c1-baseline.sh`, then `4939 c1-baseline.sh`, all dead, all from test runs,
    // while a real arm was live.
    //
    // WHAT THIS CHECK IS AND IS NOT. It is TEXTUAL, and two rounds of review established
    // that no textual check can establish this property. A verifier defeated an earlier
    // version with an alias:
    //
    //     const LAUNCHER = (() => { spawnSync("echo", []); return "scripts/c1-baseline.sh"; })();
    //     spawnSync(LAUNCHER, [dir, "--coordinator-go", "--resume"], { env: { ...process.env } });
    //
    // one launcher literal, a `spawnSync(` in the lookback, one lock-path site - and then
    // it MEASURED that spawn reaching `vm_lock_acquire` on the shared lock. So this check
    // catches the ordinary mistake (a second literal, an obvious second spawn) and NOT a
    // determined evasion through aliasing. It is not air-tight and does not claim to be.
    //
    // THE REAL GUARANTEE IS BEHAVIOURAL and lives in `watch-prior-spend.test.ts`:
    // `spawnLauncher` assigns `MYCO_VM_LOCK_PATH` AFTER spreading overrides, so no caller
    // can displace, blank, or redirect it, and it checks the assembled environment before
    // starting a process. That is enforced by tests that fail if the ORDER changes; this
    // file is a cheap lint on top of it, not the defence.
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const { path, text } of testSources()) {
      const code = stripComments(text);
      const at = code.indexOf("scripts/c1-baseline.sh");
      if (at < 0) continue;
      // Exactly one reference...
      const references = [...code.matchAll(/scripts\/c1-baseline\.sh/g)].length;
      expect({ path, references }).toEqual({ path, references: 1 });
      // ...and it must be an ARGUMENT TO A SPAWN, not a stray literal that happens to be
      // the only mention. The previous version accepted `const x = "scripts/c1-baseline.sh"`
      // in a file that never spawned it - and, worse, would accept a spawn built some
      // other way. Looking back for the call is what ties the reference to the spawn.
      const before = code.slice(Math.max(0, at - 300), at);
      expect({ path, spawning: before.includes("spawnSync(") }).toEqual({
        path,
        spawning: true,
      });
      // And the wrapper must still SET the private path. Dropping that line leaves the
      // spawn intact and the reference count unchanged, so it needs its own assertion -
      // an earlier rewrite of this guard lost this check and a mutation walked through.
      //
      // Counting the ASSIGNMENT (`MYCO_VM_LOCK_PATH: privateLockPath()`) rather than every
      // mention of the key: tests legitimately NAME it in override literals - that is how
      // the displacement guarantee is tested - and counting those made the guard fail on
      // its own new tests.
      const assignments = [...code.matchAll(/MYCO_VM_LOCK_PATH:\s*privateLockPath\(\)/g)].length;
      expect({ path, assignments }).toEqual({ path, assignments: 1 });
    }
  });

  it("creates the directory it hands to the launcher, rather than reusing one", () => {
    // Narrower than a general cleanup rule, and deliberately so: that rule fires on
    // pre-existing tests that leak a temp dir, which is a different (and harmless)
    // property from the one this file exists for. What matters is that a test invoking
    // the real launcher cannot be pointed at a directory it does not own.
    for (const { path, text } of testSources()) {
      if (!/c1-baseline\.sh|watch-c1-arm\.sh/.test(text)) continue;
      const makesOwnDirectory = /mkdtempSync|ledgerDir\(|directory\(\)/.test(text);
      expect({ path, makesOwnDirectory }).toEqual({ path, makesOwnDirectory: true });
    }
  });
});
