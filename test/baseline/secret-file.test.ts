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
 * Strip shell comments, quote-aware: a `#` starts a comment only outside single and
 * double quotes and only at the start of a word (line start or after whitespace or an
 * operator), so `echo "step #2"` and `${#arr[@]}` keep their text. CRLF and LF line
 * continuations are joined first, so a split statement is one line.
 */
function stripShellComments(text: string): string {
  const joined = text.replace(/\r\n/g, "\n").replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .map((line) => {
      let quote: '"' | "'" | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === "'") {
          if (c === "'") quote = null;
        } else if (quote === '"') {
          if (c === "\\") i++;
          else if (c === '"') quote = null;
        } else if (c === "\\") {
          i++;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1] ?? ""))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * The ONLY statements allowed to mention the secrets file: the variable `SECRETS`, the
 * key-file variable `MYCO_ANTHROPIC_KEY_FILE`, `anthropic.env` or the `.myco/secrets`
 * directory. Every other line naming one of those, in ANY scripts/*.sh, is a violation.
 * This is an allow-list on purpose: a deny-list of loading idioms (`source`, `export
 * $(… | xargs)`, `env $(cat …)`, `while read … done <`, …) can never be complete.
 * Each entry is a whole trimmed line, matched exactly, taken from the committed launchers.
 */
const SECRETS_FILE_ALLOWED_LINES: [RegExp, string][] = [
  [
    /^SECRETS="\$HOME\/\.myco\/secrets\/anthropic\.env"$/,
    "assigns the PATH to an unexported shell variable; reads nothing",
  ],
  [
    /^if \[ -z "\$\{ANTHROPIC_API_KEY:-\}" \] && ! \{ \[ -f "\$SECRETS" \] && grep -Eq '\^\[\[:space:\]\]\*\(export\[\[:space:\]\]\+\)\?ANTHROPIC_API_KEY=\.\+' "\$SECRETS"; \}; then$/,
    "presence check: grep -q runs in a child, prints nothing and assigns nothing in the shell",
  ],
  [
    /^echo "ERROR: ANTHROPIC_API_KEY required in \$SECRETS for paid Sonnet planner" >&2$/,
    "error message: expands the PATH, never the file's contents",
  ],
  [
    /^export MYCO_ANTHROPIC_KEY_FILE="\$SECRETS"$/,
    "exports the PATH; the planner reads the file at the point of use (secret-file.ts)",
  ],
];
const SECRETS_FILE_MENTION =
  /\bSECRETS\b|\bMYCO_ANTHROPIC_KEY_FILE\b|anthropic\.env|\.myco\/secrets/;

/**
 * Whole-file static check of a shell script for leaks of the Anthropic key (TIF-212).
 * Returns one entry per offending line; an empty list means the file passes. With
 * `launcher: false` (every scripts/*.sh that is not a marker-carrying launcher), the
 * secrets-file allow-list and the source/eval rule apply, but not the allexport rule:
 * scripts/deploy-verify-myco-todo.sh runs `set -a; source /run/myco/gui.env` inside a
 * guest heredoc, a GUI environment file that holds no key.
 *
 * COVERED, anywhere in the file once comments are stripped (quote-aware) and line
 * continuations (LF or CRLF) are joined:
 *  1. Any reference to the secrets file outside the allow-list above. This catches, with
 *     no idiom list, `export $(grep -v '^#' "$SECRETS" | xargs)`, `env $(cat "$SECRETS")
 *     node …`, `source`/`.`/`eval` of `$MYCO_ANTHROPIC_KEY_FILE`, `while … read … done <
 *     "$SECRETS"`, and `export OTHER="$(cut -d= -f2- "$SECRETS")"` (the key's VALUE under
 *     another name), because each has to name the file to read it.
 *  2. Exporting the literal name: `export`, `declare`, `typeset`, `readonly` or `local` in
 *     command position with ANTHROPIC_API_KEY later in the same statement, including
 *     `export OTHER=$ANTHROPIC_API_KEY`.
 *  3. `source`, `.` or `eval` of `$SECRETS`, `$MYCO_ANTHROPIC_KEY_FILE`, `.myco/secrets` or
 *     `anthropic.env` (redundant with 1, kept as a named rule).
 *  4. Launchers only: `set -a` / `set -o allexport` ANYWHERE in the file, including after
 *     other flags (`set -o pipefail -a`). No launcher needs allexport, and under it every
 *     later assignment is exported to every child.
 *  5. Assigning the literal name: `=`/`+=` after line start, whitespace, a quote or an
 *     operator (prefix assignments and `env NAME=x` included), `${ANTHROPIC_API_KEY:=…}`,
 *     and `read` / `printf -v` / `mapfile` / `readarray` targeting it, also after a prefix
 *     assignment such as `IFS='=' read -r _ ANTHROPIC_API_KEY`.
 *
 * ALLOWED, and why:
 *  - The four allow-listed lines above, each with its reason.
 *  - READING an ambient ANTHROPIC_API_KEY, e.g. `[ -z "${ANTHROPIC_API_KEY:-}" ]`, the
 *    documented back-compat path. The caller already put it in the environment; the
 *    launcher neither creates nor widens it.
 *
 * NOT COVERED. This is a textual lint over one file, like the TIF-202 guard. It does not
 * follow sourced helpers, so a helper that reads the file is checked only as its own
 * scripts/*.sh. It cannot see indirection: `n=ANTHROPIC_API_KEY; export "$n"`, a path
 * built from pieces (`d=.myco; f="$HOME/$d/secr""ets/…"`), or a value copied out of an
 * already-exported ambient key into another name without naming it (`export
 * OTHER="$(printenv | grep …)"`). Exporting the value under another name IS caught when
 * the line names the secrets file or the literal key name; it is not caught otherwise.
 */
function launcherKeyViolations(text: string, opts: { launcher?: boolean } = {}): string[] {
  const launcher = opts.launcher ?? true;
  const code = stripShellComments(text);
  const cmd = String.raw`(?:^|[;&|({!\x60]|\b(?:then|do|else|exec|command|builtin|env|nohup)\b)\s*`;
  // Zero or more prefix assignments (`IFS='=' `, `LC_ALL=C `) before a command word.
  const prefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|]*)\s+)*`;
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
        String.raw`${cmd}${prefix}(?:source|\.|eval)\s[^\n;&|]*(?:\$\{?(?:SECRETS|MYCO_ANTHROPIC_KEY_FILE)\b|\.myco/secrets|anthropic\.env)`,
        "m",
      ),
    ],
    ...(launcher
      ? ([
          [
            "enables allexport",
            new RegExp(
              String.raw`${cmd}set\s+(?:[^\n;&|]*\s)?(?:-[A-Za-z]*a[A-Za-z]*\b|-o\s+allexport\b)`,
              "m",
            ),
          ],
        ] as [string, RegExp][])
      : []),
    ["assigns the key", /(?:^|[\s"';&|({!`])ANTHROPIC_API_KEY\+?=/m],
    ["assigns the key by default expansion", /\$\{ANTHROPIC_API_KEY:?=/],
    [
      "reads into the key",
      new RegExp(
        String.raw`${cmd}${prefix}(?:read|printf\s+-v|mapfile|readarray)\s[^\n;&|]*\bANTHROPIC_API_KEY\b`,
        "m",
      ),
    ],
  ];
  return code.split("\n").flatMap((line) => {
    const found = rules.filter(([, re]) => re.test(line)).map(([label]) => label);
    const trimmed = line.trim();
    if (
      SECRETS_FILE_MENTION.test(trimmed) &&
      !SECRETS_FILE_ALLOWED_LINES.some(([re]) => re.test(trimmed))
    ) {
      found.push("references the secrets file outside the allow-list");
    }
    return found.map((label) => `${label}: ${trimmed}`);
  });
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
  // Every OTHER script too (TIF-212 round 2): a helper with no marker must not be able to
  // read or source the secrets file unchecked. The allexport rule is launcher-only; see
  // launcherKeyViolations for why.
  const others = globSync("scripts/*.sh", { cwd: REPO_ROOT })
    .map((rel) => join(REPO_ROOT, rel))
    .filter((path) => !launchers.includes(path))
    .sort();
  it("checks every non-launcher scripts/*.sh (TIF-212)", () => {
    expect(others.length).toBeGreaterThan(0);
    const violations = others.flatMap((path) =>
      launcherKeyViolations(readFileSync(path, "utf8"), { launcher: false }).map(
        (v) => `${basename(path)}: ${v}`,
      ),
    );
    expect(violations, violations.join(" | ")).toEqual([]);
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
    "set -o pipefail -a",
    "export \\\r\n  ANTHROPIC_API_KEY",
    // Round-1 verifier rows (TIF-212): each passed the old deny-list.
    "export $(grep -v '^#' \"$SECRETS\" | xargs)",
    'env $(cat "$SECRETS") node run.js',
    'caffeinate -dimsu env $(cat "$MYCO_ANTHROPIC_KEY_FILE") node --import tsx run.ts',
    'source "$MYCO_ANTHROPIC_KEY_FILE"',
    '. "$MYCO_ANTHROPIC_KEY_FILE"',
    'eval "$(cat "$MYCO_ANTHROPIC_KEY_FILE")"',
    'export ANTHROPIC_KEY="$(cut -d= -f2- "$SECRETS")"',
    'while IFS=\'=\' read -r k v; do export "$k=$v"; done < "$SECRETS"',
    "IFS='=' read -r _ ANTHROPIC_API_KEY < f",
    'echo "step #2"; export ANTHROPIC_API_KEY=x',
  ];
  for (const line of forbidden) {
    it(`flags ${JSON.stringify(line)}`, () => {
      expect(launcherKeyViolations([...allowed, line].join("\n")).length).toBeGreaterThan(0);
    });
  }
  it("strips comments quote-aware", () => {
    expect(launcherKeyViolations("echo 'a # b' # export ANTHROPIC_API_KEY=x")).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(launcherKeyViolations("n=${#arr[@]} # export ANTHROPIC_API_KEY=x")).toEqual([]);
    expect(launcherKeyViolations('echo "a \\" # b"; export ANTHROPIC_API_KEY=x')).not.toEqual([]);
  });
  it("non-launcher mode skips only the allexport rule", () => {
    expect(launcherKeyViolations("set -a", { launcher: false })).toEqual([]);
    expect(launcherKeyViolations('source "$SECRETS"', { launcher: false }).length).toBe(2);
  });
});
