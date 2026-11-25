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
 * Strip shell comments with a small quoting lexer over the whole file, matching bash:
 *  - A `#` starts a comment only in code context and only at the start of a word: at the
 *    start of the text, or after whitespace, `;&|()`, or the OPENING backtick of a
 *    command substitution. So `echo "step #2"`, `${#arr[@]}` and `` `true`#x `` keep their
 *    text. A comment ends at the newline, or, inside backticks, at the closing backtick
 *    (`` echo `# c`; export … `` runs the export).
 *  - A stack of contexts follows `'…'`, `"…"` (with `\` escapes), ANSI-C `$'…'` (with `\`
 *    escapes, so `$'a\' #'` is one string), and nested `$(…)`, bare `(…)` and backticks,
 *    whose insides are code again even within double quotes (`"$(printf "%s #" y)"` and
 *    `` "`printf "%s #" y`" `` are one word each). Quoted strings may span lines.
 *  - Line continuation is lexed, not pre-joined: an unescaped `\` before a newline, in
 *    code or `"…"` context only, is deleted with nothing in its place, so `a\⏎#b` is the
 *    word `a#b`. It is NOT a continuation inside a comment (the next line is code), inside
 *    `'…'` (literal), or after an escaped backslash (`\\⏎` ends the line). CRLF is read
 *    as LF.
 *  - Heredoc bodies (`<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`) are copied
 *    verbatim up to the terminator line: bash never treats `#` or quotes in a body as
 *    syntax, so an apostrophe in a body cannot shift the quote state of later lines, and
 *    every body line still goes through the per-line rules.
 * Newlines outside continuations are kept, so each output line is one source line or one
 * continued statement.
 */
function stripShellComments(text: string): string {
  const src = text.replace(/\r\n/g, "\n");
  type Ctx = "sq" | "dq" | "ansi" | "paren" | "bt";
  const stack: Ctx[] = [];
  const pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const next = src[i + 1] ?? "";
    const top = stack[stack.length - 1];
    if (top === "sq") {
      if (c === "'") stack.pop();
    } else if (top === "ansi") {
      if (c === "\\") {
        out += c + next;
        i++;
        continue;
      }
      if (c === "'") stack.pop();
    } else if (top === "dq") {
      if (c === "\\") {
        if (next !== "\n") out += c + next;
        i++;
        continue;
      }
      if (c === '"') stack.pop();
      else if (c === "$" && next === "(") {
        stack.push("paren");
        out += c + next;
        i++;
        continue;
      } else if (c === "`") stack.push("bt");
    } else {
      // Code context: top level, inside `$(…)`/`(…)`, or inside backticks.
      if (c === "\\") {
        if (next !== "\n") out += c + next;
        i++;
        continue;
      }
      const prev = out[out.length - 1];
      if (
        c === "#" &&
        (prev === undefined || /[\s;&|()]/.test(prev) || (prev === "`" && top === "bt"))
      ) {
        const stop = top === "bt" ? /[\n`]/ : /\n/;
        while (i + 1 < src.length && !stop.test(src[i + 1] ?? "")) i++;
        continue;
      }
      if (c === "$" && next === "'") {
        stack.push("ansi");
        out += c + next;
        i++;
        continue;
      }
      if (c === "<" && next === "<" && src[i + 2] !== "<" && src[i - 1] !== "<") {
        // Heredoc operator: read the delimiter word, removing its quotes and escapes.
        let j = i + 2;
        const stripTabs = src[j] === "-";
        if (stripTabs) j++;
        while (src[j] === " " || src[j] === "\t") j++;
        let delim = "";
        while (j < src.length && !/[\s;&|<>()]/.test(src[j] ?? "")) {
          const d = src[j] ?? "";
          if (d === "'" || d === '"') {
            const close = src.indexOf(d, j + 1);
            if (close === -1) break;
            delim += src.slice(j + 1, close);
            j = close + 1;
          } else if (d === "\\") {
            delim += src[j + 1] ?? "";
            j += 2;
          } else {
            delim += d;
            j++;
          }
        }
        if (delim !== "") {
          pendingHeredocs.push({ delim, stripTabs });
          out += src.slice(i, j);
          i = j - 1;
          continue;
        }
      }
      if (c === "\n" && pendingHeredocs.length > 0) {
        // Copy each pending heredoc body verbatim through its terminator line.
        out += c;
        let j = i + 1;
        for (const { delim, stripTabs } of pendingHeredocs.splice(0)) {
          while (j < src.length) {
            const eol = src.indexOf("\n", j);
            const end = eol === -1 ? src.length : eol;
            const line = src.slice(j, end);
            out += src.slice(j, eol === -1 ? end : end + 1);
            j = end + 1;
            if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) break;
          }
        }
        i = j - 1;
        continue;
      }
      if (c === "'") stack.push("sq");
      else if (c === '"') stack.push("dq");
      else if (c === "(") stack.push("paren");
      else if (c === ")" && top === "paren") stack.pop();
      else if (c === "`") {
        if (top === "bt") stack.pop();
        else stack.push("bt");
      }
    }
    out += c;
  }
  return out;
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
  /\bSECRETS\b|\bMYCO_ANTHROPIC_KEY_FILE\b|anthropic\.env|\.myco\/secrets|\.myco\b|\bsecrets\//;

/**
 * Whole-file static check of a shell script for leaks of the Anthropic key (TIF-212).
 * Returns one entry per offending line; an empty list means the file passes. With
 * `launcher: false` (every scripts/*.sh that is not a marker-carrying launcher), EVERY
 * rule below applies except rule 4, allexport: scripts/deploy-verify-myco-todo.sh runs
 * `set -a; source /run/myco/gui.env` inside a guest heredoc, a GUI environment file that
 * holds no key.
 *
 * COVERED, anywhere in the file once comments are stripped (by the quoting lexer in
 * stripShellComments) and line continuations (LF or CRLF) are joined:
 *  1. Any reference to the secrets file outside the allow-list above. This catches, with
 *     no idiom list, `export $(grep -v '^#' "$SECRETS" | xargs)`, `env $(cat "$SECRETS")
 *     node …`, `source`/`.`/`eval` of `$MYCO_ANTHROPIC_KEY_FILE`, `while … read … done <
 *     "$SECRETS"`, and `export OTHER="$(cut -d= -f2- "$SECRETS")"` (the key's VALUE under
 *     another name), because each has to name the file to read it. A mention is any of
 *     `SECRETS`, `MYCO_ANTHROPIC_KEY_FILE`, `anthropic.env`, `.myco` or `secrets/`, so a
 *     path assembled from those pieces (`cd "$HOME/.myco" && cat secrets/*.env`,
 *     `"$HOME"/.myco//secrets/*.env`, `"$HOME/.myco/"secrets/*.env`) counts too (TIF-236).
 *     Deliberate trade-off: ANY `.myco` path (`mkdir -p "$HOME/.myco/logs"`) and ANY
 *     `secrets/` directory (`ls k8s/secrets/`) is flagged, whatever it points at. No
 *     committed script trips this today; a new benign one needs an allow-list entry.
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
 * built from pieces that split every token (`d=.my""co; f="$HOME/$d/secr""ets/…"`), or a
 * value copied out of an already-exported ambient key into another name without naming
 * it (`export OTHER="$(printenv | grep …)"`). Exporting the value under another name IS
 * caught when the line names the secrets file or the literal key name; it is not caught
 * otherwise. The comment lexer is not a full shell parser; each limit below is pinned by
 * a "known limitation" test:
 *  - `)` in a `case` pattern inside `$(…)` closes the substitution early, so
 *    `x="$(case a in a) echo " #";; esac)"; export …` hides the export (a false negative).
 *  - `<<` in arithmetic (`$((1 << 2))`) is read as a heredoc whose terminator is `2`, so
 *    later lines are copied verbatim and their comments are kept. That can only add
 *    false positives, never hide a line.
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
    // TIF-236 (#439 round-2 verifier): each passed the TIF-212 check.
    'export $(cd "$HOME/.myco" && cat secrets/*.env | xargs)',
    'export $(cat "$HOME"/.myco//secrets/*.env | xargs)',
    'export $(cat "$HOME/.myco/"secrets/*.env | xargs)',
    'X="$(printf "%s #" y)"; export ANTHROPIC_API_KEY=x',
    "echo $'a\\' #'; export ANTHROPIC_API_KEY=x",
    'echo "line one\n #still quoted"; export ANTHROPIC_API_KEY=x',
    // TIF-236 round 2, D1 (#447 verifier item 6): backslash-newline is lexed like bash.
    "# path note \\\nexport ANTHROPIC_API_KEY=x", // no continuation inside a comment
    'true # see C:\\\nexport $(cat "$HOME/.myco/secrets/anthropic.env" | xargs)',
    "echo a\\\n#b; export ANTHROPIC_API_KEY=x", // joins to the word a#b, not a comment
    'echo a\\\\\nprintf -v ANTHROPIC_API_KEY %s "$v"', // `\\` then a newline ends the line
    // TIF-236 round 2, D2: each documented lexer behaviour, as a row that fails if broken.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    "n=${#arr[@]}; export ANTHROPIC_API_KEY=x", // `${#` is not a comment
    "echo `# c`; export ANTHROPIC_API_KEY=x", // a comment in backticks ends at the backtick
    "echo `true`#x; export ANTHROPIC_API_KEY=x", // a CLOSING backtick is not a word start
    'X="`printf "%s #" y`"; export ANTHROPIC_API_KEY=x', // backticks in "…" are code
    'X="$( (true) ; printf "%s #" y)"; export ANTHROPIC_API_KEY=x', // bare (…) nests
    // N2: heredoc bodies are opaque, so a quote in one cannot hide a later line.
    "cat <<EOF\nit's\nEOF\necho 'q #'; export ANTHROPIC_API_KEY=x",
    'cat <<EOF\nsay "hi\nEOF\necho "q #"; export ANTHROPIC_API_KEY=x',
    "cat <<-'EOF'\n\tit's\n\tEOF\necho 'q #'; export ANTHROPIC_API_KEY=x",
    'node x.js <<EOF\n$(cat "$HOME/.myco/secrets/k.env")\nEOF', // body lines are still checked
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
    // TIF-236: nested, ANSI-C and multi-line strings; real comments after them still strip.
    expect(launcherKeyViolations('X="$(printf "%s" y)" # export ANTHROPIC_API_KEY=x')).toEqual([]);
    expect(launcherKeyViolations("echo $'a\\'' # export ANTHROPIC_API_KEY=x")).toEqual([]);
    // TIF-236 round 2: an OPENING backtick is a word start, so this comment is stripped.
    expect(launcherKeyViolations("echo `# export ANTHROPIC_API_KEY=x`")).toEqual([]);
    // A continuation inside "…" joins with nothing; the comment after the string strips.
    expect(launcherKeyViolations('echo "a\\\nb" # export ANTHROPIC_API_KEY=x')).toEqual([]);
    // A heredoc body is data: a `#` line in it is kept, and the line after the
    // terminator is code again.
    expect(launcherKeyViolations("cat <<EOF\n# header line\nvalue=1\nEOF\n# c")).toEqual([]);
    expect(
      launcherKeyViolations("cat <<EOF\n# export ANTHROPIC_API_KEY=x\nEOF").length,
    ).toBeGreaterThan(0);
    expect(
      launcherKeyViolations(
        'echo "one\ntwo" # export ANTHROPIC_API_KEY=x\nexport ANTHROPIC_API_KEY=y',
      ),
    ).toEqual([
      "exports the key: export ANTHROPIC_API_KEY=y",
      "assigns the key: export ANTHROPIC_API_KEY=y",
    ]);
  });
  // Known limitations, pinned at today's output (see NOT COVERED). If one of these starts
  // failing, the checker changed: update the doc comment along with the assertion.
  it("known limitation: a case-pattern `)` inside $(…) closes it early (false negative)", () => {
    expect(
      launcherKeyViolations('x="$(case a in a) echo " #";; esac)"; export ANTHROPIC_API_KEY=x'),
    ).toEqual([]);
  });
  it("known limitation: `<<` in arithmetic opens a heredoc (false positives only)", () => {
    expect(
      launcherKeyViolations("echo $((1 << 2))\necho hi # export ANTHROPIC_API_KEY=x").length,
    ).toBeGreaterThan(0);
  });
  it("known limitation: indirection that splits every token is not seen", () => {
    expect(
      launcherKeyViolations('d=.my""co; f="$HOME/$d/secr""ets/k.env"; export $(cat "$f" | xargs)'),
    ).toEqual([]);
    expect(launcherKeyViolations('n=ANTHROPIC_API_KEY; export "$n"')).toEqual([]);
  });
  it("non-launcher mode applies every rule except allexport (TIF-236)", () => {
    expect(launcherKeyViolations("set -a", { launcher: false })).toEqual([]);
    expect(launcherKeyViolations('source "$SECRETS"', { launcher: false }).length).toBe(2);
    expect(launcherKeyViolations("export ANTHROPIC_API_KEY=x", { launcher: false }).length).toBe(2);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(launcherKeyViolations(': "${ANTHROPIC_API_KEY:=x}"', { launcher: false })).not.toEqual(
      [],
    );
    expect(launcherKeyViolations("read -r ANTHROPIC_API_KEY < f", { launcher: false })).not.toEqual(
      [],
    );
    expect(
      launcherKeyViolations('cd "$HOME/.myco" && cat secrets/*.env', { launcher: false }),
    ).not.toEqual([]);
  });
});
