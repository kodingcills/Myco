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
