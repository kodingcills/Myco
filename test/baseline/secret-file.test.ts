import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretFromFile, resolveAnthropicKey } from "../../src/baseline/secret-file.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** Every scripts/*.sh that loads the Anthropic key. Edit consciously (TIF-212). */
const EXPECTED_LAUNCHERS = ["c1-baseline.sh", "c1-spike.sh"];

/**
 * Whole-file static check of a key-loading launcher (TIF-212). Returns one entry per
 * forbidden statement; an empty list means the file passes.
 *
 * FORBIDDEN, anywhere in the file once comments are stripped:
 *  1. Exporting the key: `export`, `declare`, `typeset`, `readonly` or `local` in command
 *     position with ANTHROPIC_API_KEY later in the same statement. Covers
 *     `export ANTHROPIC_API_KEY=x`, `export FOO ANTHROPIC_API_KEY`, `declare -x
 *     ANTHROPIC_API_KEY`, and `export OTHER=$ANTHROPIC_API_KEY` (the value under a new name).
 *  2. Loading the secrets file into the shell: `source`, `.` or `eval` of `$SECRETS`,
 *     `.myco/secrets` or `anthropic.env`; and `set -a` / `set -o allexport` ANYWHERE.
 *     The rule is stricter than "a set -a enclosing a source": no launcher needs
 *     allexport, and under it every later assignment, including one read from the
 *     secrets file some other way, is exported to every child.
 *  3. Assigning the key: the name followed by `=` or `+=`, preceded by line start,
 *     whitespace, a quote or a shell operator (so a prefix assignment
 *     `ANTHROPIC_API_KEY=x cmd` and `env ANTHROPIC_API_KEY=x cmd` are caught), the
 *     defaulting expansions `${ANTHROPIC_API_KEY:=…}` / `${ANTHROPIC_API_KEY=…}`, and
 *     `read` / `printf -v` / `mapfile` / `readarray` targeting it. Even an unexported
 *     assignment is forbidden: when an ambient key is already exported, assigning it
 *     rewrites the exported value every child inherits.
 *
 * ALLOWED, and why:
 *  - READING an ambient ANTHROPIC_API_KEY, e.g. `[ -z "${ANTHROPIC_API_KEY:-}" ]`. That
 *    is the documented back-compat path (src/baseline/secret-file.ts prefers an explicit
 *    env key). An ambient value is inherited from the caller, who already put it in the
 *    environment; the launcher neither creates nor widens it.
 *  - Naming the variable inside a quoted pattern or message, e.g. the launchers' presence
 *    check `grep -Eq '^…(export[[:space:]]+)?ANTHROPIC_API_KEY=.+' "$SECRETS"` (the key
 *    name is preceded by `?`, and `export` there is followed by `[`, not whitespace) and
 *    `echo "ERROR: ANTHROPIC_API_KEY required in $SECRETS"`. grep reads the file in a
 *    child and prints nothing (-q); nothing is assigned in the shell.
 *  - `export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"`: a path, not the key.
 *
 * LIMITS. This is a textual lint over one file, like the TIF-202 guard: it does not
 * follow sourced helpers, and indirection such as `n=ANTHROPIC_API_KEY; export "$n"` or
 * a `#` inside a quoted string (which the comment stripper treats as a comment) can
 * evade it. It catches the ordinary regression, the re-added export or `set -a; source`.
 */
function launcherKeyViolations(text: string): string[] {
  const code = text
    .replace(/\\\n/g, " ") // join continuation lines so a split statement is one line
    .replace(/(^|\s)#.*$/gm, "$1"); // strip comments
  const cmd = String.raw`(?:^|[;&|({!\x60]|\b(?:then|do|else|exec|command|builtin|env|nohup)\b)\s*`;
  const rules: [string, RegExp][] = [
    [
      "exports the key",
      new RegExp(
        String.raw`${cmd}(?:export|declare|typeset|readonly|local)\s[^\n;&|]*\bANTHROPIC_API_KEY\b`,
        "m",
      ),
    ],
    [
      "sources the secrets file",
      new RegExp(
        String.raw`${cmd}(?:source|\.|eval)\s[^\n;&|]*(?:\$\{?SECRETS\b|\.myco/secrets|anthropic\.env)`,
        "m",
      ),
    ],
    [
      "enables allexport",
      new RegExp(
        String.raw`${cmd}set\s+(?:[-+][A-Za-z]*\s+)*(?:-[A-Za-z]*a[A-Za-z]*\b|-o\s+allexport\b)`,
        "m",
      ),
    ],
    ["assigns the key", /(?:^|[\s"';&|({!`])ANTHROPIC_API_KEY\+?=/m],
    ["assigns the key by default expansion", /\$\{ANTHROPIC_API_KEY:?=/],
    [
      "reads into the key",
      new RegExp(
        String.raw`${cmd}(?:read|printf\s+-v|mapfile|readarray)\s[^\n;&|]*\bANTHROPIC_API_KEY\b`,
        "m",
      ),
    ],
  ];
  return code
    .split("\n")
    .flatMap((line) =>
      rules.filter(([, re]) => re.test(line)).map(([label]) => `${label}: ${line.trim()}`),
    );
}

// Synthetic values only. Nothing here touches a real secrets file. FAKE is a plain
// fixture string, deliberately not key-shaped, so the tracked-file credential scan
// (FORBIDDEN_IN_COMMITTED_FILES) and gitleaks never match it. Nothing below depends on
// the value having a real key's shape.
const FAKE = "fixture-anthropic-key-not-a-real-secret";
const dirs: string[] = [];
function secretsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-secret-file-"));
  dirs.push(dir);
  const path = join(dir, "anthropic.env");
  writeFileSync(path, body);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readSecretFromFile (TIF-206)", () => {
  it("reads plain, exported and quoted NAME=value lines", () => {
    expect(
      readSecretFromFile(secretsFile(`ANTHROPIC_API_KEY=${FAKE}\n`), "ANTHROPIC_API_KEY"),
    ).toBe(FAKE);
    expect(
      readSecretFromFile(
        secretsFile(`# c\nexport ANTHROPIC_API_KEY="${FAKE}"\n`),
        "ANTHROPIC_API_KEY",
      ),
    ).toBe(FAKE);
    expect(
      readSecretFromFile(
        secretsFile(`OTHER=1\r\nANTHROPIC_API_KEY='${FAKE}'\r\n`),
        "ANTHROPIC_API_KEY",
      ),
    ).toBe(FAKE);
  });

  it("errors name the file and variable but never echo the contents", () => {
    const path = secretsFile(`SOMETHING_ELSE=${FAKE}\n`);
    expect(() => readSecretFromFile(path, "ANTHROPIC_API_KEY")).toThrow(
      /ANTHROPIC_API_KEY not found/,
    );
    try {
      readSecretFromFile(path, "ANTHROPIC_API_KEY");
    } catch (e) {
      expect(String(e)).not.toContain(FAKE);
    }
    expect(() =>
      readSecretFromFile(join(tmpdir(), "no-such-myco-file.env"), "ANTHROPIC_API_KEY"),
    ).toThrow(/cannot read secrets file/);
  });
});

describe("resolveAnthropicKey (TIF-206)", () => {
  it("prefers an explicit env key, then the key file, and has no default path", () => {
    const path = secretsFile(`ANTHROPIC_API_KEY=${FAKE}\n`);
    expect(
      resolveAnthropicKey({ ANTHROPIC_API_KEY: "explicit", MYCO_ANTHROPIC_KEY_FILE: path }),
    ).toBe("explicit");
    expect(resolveAnthropicKey({ MYCO_ANTHROPIC_KEY_FILE: path })).toBe(FAKE);
    expect(resolveAnthropicKey({})).toBeUndefined();
  });
});

describe("launchers pass the key file path, not the key (TIF-206)", () => {
  // The key must never be exported into the launcher environment: `ps eww` on the sweep
  // printed it (TIF-193). Run only the key-loading prologue of each launcher, with a
  // fake HOME, and check what the child environment would contain.
  //
  // The launchers are DISCOVERED, not named: every scripts/*.sh that exports the key-file
  // variable is checked, so a new launcher is covered automatically. Not naming them also
  // keeps this file outside the TIF-202 guard in probe-directory.test.ts, which requires
  // any test naming the c1 launcher to spawn it under a private VM lock. This test never
  // spawns a launcher: it runs only the prologue below, which ends before vm-lock.sh is
  // sourced, so it cannot reach the shared lock.
  //
  // The glob is anchored to the repo root (TIF-212), not the cwd, so running vitest from
  // another directory cannot silently discover nothing.
  const launchers = globSync("scripts/*.sh", { cwd: REPO_ROOT })
    .map((rel) => join(REPO_ROOT, rel))
    .filter((path) =>
      readFileSync(path, "utf8").includes('export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"'),
    )
    .sort();
  it("finds exactly the expected key-loading launchers (TIF-212)", () => {
    // An identity, not a floor: adding or removing a key-loading launcher must be a
    // conscious edit here. Basenames only, so this file never names the c1 launcher's
    // repo path and stays outside the TIF-202 guard in probe-directory.test.ts.
    expect(launchers.map((path) => basename(path))).toEqual(EXPECTED_LAUNCHERS);
  });
  for (const script of launchers) {
    const name = basename(script);
    it(`${name}: no statement anywhere in the file exports or assigns the key (TIF-212)`, () => {
      // The prologue test below runs only the key-loading slice. This one reads the WHOLE
      // file, so a key export added after that slice (the round-2 verifier's
      // `export ANTHROPIC_API_KEY=x` after the export line passed 10/10) fails here.
      const violations = launcherKeyViolations(readFileSync(script, "utf8"));
      expect(violations, `${name}: ${violations.join(" | ")}`).toEqual([]);
    });
    it(`${name} exports MYCO_ANTHROPIC_KEY_FILE and not ANTHROPIC_API_KEY`, () => {
      const home = mkdtempSync(join(tmpdir(), "myco-secret-home-"));
      dirs.push(home);
      const secrets = join(home, ".myco", "secrets");
      mkdirSync(secrets, { recursive: true });
      writeFileSync(join(secrets, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE}\n`);
      const src = readFileSync(script, "utf8");
      const start = src.indexOf('SECRETS="$HOME/.myco/secrets/anthropic.env"');
      const end = src.indexOf('export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const prologue = `${src.slice(start, end)}export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"\nenv | cut -d= -f1\n`;
      const env = { PATH: process.env.PATH, HOME: home };
      const run = spawnSync("bash", ["-c", prologue], { encoding: "utf8", env });
      expect(run.status).toBe(0);
      const names = run.stdout.split("\n");
      expect(names).toContain("MYCO_ANTHROPIC_KEY_FILE");
      expect(names).not.toContain("ANTHROPIC_API_KEY");
      expect(`${run.stdout}${run.stderr}`).not.toContain(FAKE);

      const missing = spawnSync("bash", ["-c", prologue], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: join(home, "nowhere") },
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/ANTHROPIC_API_KEY required/);
    });
  }
});

describe("launcherKeyViolations, the whole-file launcher check (TIF-212)", () => {
  // Synthetic launcher text only; nothing here reads or runs a real launcher.
  const allowed = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! { [ -f "$SECRETS" ] && grep -Eq \'^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=.+\' "$SECRETS"; }; then',
    '  echo "ERROR: ANTHROPIC_API_KEY required in $SECRETS for paid Sonnet planner" >&2',
    'export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"',
    'source "$WS/scripts/vm-lock.sh"',
    "set -euo pipefail",
    "# This used to `set -a; source` the file and export ANTHROPIC_API_KEY=x",
  ];
  it("passes the launchers' legitimate lines", () => {
    expect(launcherKeyViolations(allowed.join("\n"))).toEqual([]);
  });
  const forbidden = [
    "export ANTHROPIC_API_KEY=x", // mutation (a)
    'set -a; source "$SECRETS"; set +a', // mutation (b)
    "declare -x ANTHROPIC_API_KEY", // mutation (c)
    "export FOO ANTHROPIC_API_KEY",
    "export \\\n  ANTHROPIC_API_KEY",
    "typeset -x ANTHROPIC_API_KEY=x",
    'export OTHER="$ANTHROPIC_API_KEY"',
    '. "$SECRETS"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'source "${SECRETS}"',
    "source $HOME/.myco/secrets/anthropic.env",
    'eval "$(cat "$SECRETS")"',
    "set -o allexport",
    "set -ea",
    "ANTHROPIC_API_KEY=x",
    "ANTHROPIC_API_KEY=x node run.js",
    "env ANTHROPIC_API_KEY=x node run.js",
    'env "ANTHROPIC_API_KEY=x" node run.js',
    'if true; then ANTHROPIC_API_KEY="$(cat f)"; fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    ': "${ANTHROPIC_API_KEY:=x}"',
    "read -r ANTHROPIC_API_KEY < f",
    'printf -v ANTHROPIC_API_KEY "%s" x',
  ];
  for (const line of forbidden) {
    it(`flags ${JSON.stringify(line)}`, () => {
      expect(launcherKeyViolations([...allowed, line].join("\n")).length).toBeGreaterThan(0);
    });
  }
});
