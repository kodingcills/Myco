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
 *    start of the text, or after an UNESCAPED blank or `;&|`, a bare `(`, the `)` of a
 *    subshell, `$(`, or the OPENING backtick of a command substitution. So `echo "step
 *    #2"`, `${#arr[@]}`, `` `true`#x ``, `$(true)#x` (the `)` of `$(…)` does not end the
 *    word) and `\ #` / `\;#` (an escaped character is word text) keep their text (TIF-248
 *    round 2). A comment ends at the newline, or, inside backticks, at the closing
 *    backtick (`` echo `# c`; export … `` runs the export).
 *  - Backticks end like bash: the next unescaped backtick closes the innermost open
 *    backtick substitution, whatever was opened inside it (`"`, `'`, `${`, `$(`, a bare
 *    `(`), because bash finds it with a flat scan before parsing the inside (TIF-248
 *    round 2: `` `${x:- #`# `` and `` `( #` `` end at their second backtick).
 *  - A stack of contexts follows `'…'`, `"…"` (with `\` escapes), ANSI-C `$'…'` (with `\`
 *    escapes, so `$'a\' #'` is one string), and nested `$(…)`, bare `(…)` and backticks,
 *    whose insides are code again even within double quotes (`"$(printf "%s #" y)"` and
 *    `` "`printf "%s #" y`" `` are one word each). Quoted strings may span lines.
 *  - Parameter expansion `${…}`, in code or inside `"…"`, is its own context (TIF-248, #447
 *    round-3 D7): in it `'…'`, `"…"`, `$'…'`, `$(…)`, backticks and a nested `${…}` open
 *    their own contexts, a `#` is an operator or literal (never a comment), a bare `(` is
 *    literal, and the matching `}` closes it. So `"${x:-" #"}"` is ONE word, as in bash
 *    5, not a string, a comment and a stray quote.
 *  - Line continuation is lexed, not pre-joined: an unescaped `\` before a newline, in
 *    code or `"…"` context only, is deleted with nothing in its place, so `a\⏎#b` is the
 *    word `a#b`. It is NOT a continuation inside a comment (the next line is code), inside
 *    `'…'` (literal), or after an escaped backslash (`\\⏎` ends the line). CRLF is read
 *    as LF.
 *  - Heredoc bodies (`<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`) are copied
 *    verbatim up to the terminator line: bash never treats `#` or quotes in a body as
 *    syntax, so an apostrophe in a body cannot shift the quote state of later lines, and
 *    every body line still goes through the per-line rules. Several heredocs on one line
 *    are read in order. The terminator matches like bash: `<<-` strips leading tabs
 *    (plain `<<` does not); with an unquoted delimiter a body line ending in an odd run
 *    of backslashes joins the next before matching (D3); a `WORD\r` line (CRLF file)
 *    never terminates a `WORD` heredoc (D4). On a CRLF operator line (`cat <<WORD\r`) the
 *    CR is part of the delimiter, so only a `WORD\r` line terminates it (TIF-248, #447
 *    round-3 N1). An unterminated body runs to the end of the text, verbatim.
 *    `opts.heredocs: false` turns detection off (strategy (b) in launcherKeyViolations).
 * Newlines outside continuations are kept, so each output line is one source line or one
 * continued statement.
 */
function stripShellComments(text: string, opts: { heredocs?: boolean } = {}): string {
  const heredocs = opts.heredocs ?? true;
  // CRLF is read as LF, but remember which LFs had a CR before them: bash does not end a
  // heredoc at a `WORD\r` line (D4).
  const crBefore = new Set<number>();
  let src = "";
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "\r" && text[k + 1] === "\n") {
      crBefore.add(src.length);
      continue;
    }
    src += text[k];
  }
  // "paren" is `$(…)`, "sub" a bare `(…)` subshell: bash ends a word after the `)` of a
  // subshell, not after the `)` of a command substitution (`$(true)#x` is one word).
  type Ctx = "sq" | "dq" | "ansi" | "paren" | "sub" | "bt" | "brace";
  const stack: Ctx[] = [];
  const pendingHeredocs: { delim: string; stripTabs: boolean; quoted: boolean }[] = [];
  let out = "";
  // `out.length` at the last word start in code context. A `#` starts a comment only
  // there. Tracked as an index, not by looking at the last character of `out`, because an
  // escaped blank or operator (`\ `, `\;`) is word text, not a break (TIF-248 round 2 BS).
  let wordStartAt = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const next = src[i + 1] ?? "";
    const top = stack[stack.length - 1];
    // bash finds the end of a backtick substitution with a flat scan: the next unescaped
    // backtick ends it, whatever quotes, `${`, `$(` or `(` were opened inside (TIF-248
    // round 2 R1 and backtick-paren). So while a `bt` is open, a backtick in ANY context
    // closes the innermost `bt` and everything opened inside it, and `\` escapes even
    // inside '…'.
    const btAt = stack.lastIndexOf("bt");
    if (btAt !== -1) {
      if (top === "sq" && c === "\\") {
        out += c + next;
        i++;
        continue;
      }
      if (c === "`") {
        stack.length = btAt;
        out += c;
        continue;
      }
    }
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
      else if (c === "$" && (next === "(" || next === "{")) {
        stack.push(next === "(" ? "paren" : "brace");
        out += c + next;
        i++;
        wordStartAt = out.length;
        continue;
      } else if (c === "`") {
        stack.push("bt");
        out += c;
        wordStartAt = out.length;
        continue;
      }
    } else if (top === "brace") {
      // Inside `${…}`, in code or in "…" (D7): quotes, `$'…'`, `$(…)`, backticks and a
      // nested `${` open their own contexts, so `"${x:-" #"}"` is one word. A `#` here is
      // an operator or literal, never a comment; a bare `(` is literal; `}` closes.
      if (c === "\\") {
        if (next !== "\n") out += c + next;
        i++;
        continue;
      }
      if (c === "$" && (next === "(" || next === "{" || next === "'")) {
        stack.push(next === "(" ? "paren" : next === "{" ? "brace" : "ansi");
        out += c + next;
        i++;
        wordStartAt = out.length;
        continue;
      }
      if (c === "}") stack.pop();
      else if (c === "'") stack.push("sq");
      else if (c === '"') stack.push("dq");
      else if (c === "`") {
        stack.push("bt");
        out += c;
        wordStartAt = out.length;
        continue;
      }
    } else {
      // Code context: top level, inside `$(…)`/`(…)`, or inside backticks.
      if (c === "\\") {
        // An escaped character is word text, so it never moves wordStartAt: `\ #` and
        // `\;#` are words in bash, not a comment (BS). `\⏎` is deleted outright, so
        // `echo \⏎#c` is still a comment, as in bash.
        if (next !== "\n") out += c + next;
        i++;
        continue;
      }
      if (c === "#" && out.length === wordStartAt) {
        const stop = btAt !== -1 ? /[\n`]/ : /\n/;
        while (i + 1 < src.length && !stop.test(src[i + 1] ?? "")) i++;
        continue;
      }
      if (c === "$" && (next === "'" || next === "{" || next === "(")) {
        stack.push(next === "'" ? "ansi" : next === "{" ? "brace" : "paren");
        out += c + next;
        i++;
        if (next === "(") wordStartAt = out.length;
        continue;
      }
      if (heredocs && c === "<" && next === "<" && src[i + 2] !== "<" && src[i - 1] !== "<") {
        // Heredoc operator: read the delimiter word, removing its quotes and escapes.
        let j = i + 2;
        const stripTabs = src[j] === "-";
        if (stripTabs) j++;
        while (src[j] === " " || src[j] === "\t") j++;
        let delim = "";
        let quoted = false;
        while (j < src.length && !/[\s;&|<>()]/.test(src[j] ?? "")) {
          const d = src[j] ?? "";
          if (d === "'" || d === '"') {
            quoted = true;
            const close = src.indexOf(d, j + 1);
            if (close === -1) break;
            delim += src.slice(j + 1, close);
            j = close + 1;
          } else if (d === "\\") {
            quoted = true;
            delim += src[j + 1] ?? "";
            j += 2;
          } else {
            delim += d;
            j++;
          }
        }
        // A CRLF operator line: bash keeps the CR in the delimiter word (N1).
        if (src[j] === "\n" && crBefore.has(j)) delim += "\r";
        if (delim !== "") {
          pendingHeredocs.push({ delim, stripTabs, quoted });
          out += src.slice(i, j);
          i = j - 1;
          continue;
        }
      }
      if (c === "\n" && pendingHeredocs.length > 0) {
        // Copy each pending heredoc body verbatim through its terminator line.
        out += c;
        let j = i + 1;
        for (const { delim, stripTabs, quoted } of pendingHeredocs.splice(0)) {
          while (j < src.length) {
            // One logical body line. With an unquoted delimiter bash removes `\⏎` from
            // the body BEFORE it looks for the terminator, so a line ending in an odd
            // run of backslashes swallows the next one (D3).
            let line = "";
            let crEnd = false;
            for (;;) {
              const eol = src.indexOf("\n", j);
              const end = eol === -1 ? src.length : eol;
              const phys = src.slice(j, end);
              out += src.slice(j, eol === -1 ? end : end + 1);
              j = end + 1;
              crEnd = crBefore.has(end);
              const trailing = /\\*$/.exec(phys)?.[0].length ?? 0;
              if (!quoted && !crEnd && trailing % 2 === 1 && eol !== -1) {
                line += phys.slice(0, -1);
                continue;
              }
              line += phys;
              break;
            }
            const body = stripTabs ? line.replace(/^\t+/, "") : line;
            if (body + (crEnd ? "\r" : "") === delim) break;
          }
        }
        i = j - 1;
        wordStartAt = out.length;
        continue;
      }
      // Word breaks: an unescaped blank or `;&|`, a bare `(`, the `)` of a subshell or a
      // stray `)` (case patterns), and an OPENING backtick. NOT the `)` of `$(…)`: bash
      // keeps `$(true)#x` as one word (TIF-248 round 2). A closing backtick is handled
      // above and is not a break either (`` `true`#x `` is one word).
      let brk = /[\s;&|]/.test(c);
      if (c === "'") stack.push("sq");
      else if (c === '"') stack.push("dq");
      else if (c === "(") {
        stack.push("sub");
        brk = true;
      } else if (c === ")") {
        if (top === "paren") stack.pop();
        else {
          if (top === "sub") stack.pop();
          brk = true;
        }
      } else if (c === "`") {
        stack.push("bt");
        brk = true;
      }
      out += c;
      if (brk) wordStartAt = out.length;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Strategy (c): origin/main b5d9dd78's per-line stripper, kept verbatim. It is quote-aware
 * for flat quotes on ONE line only, and joins continuations with a space first. It is
 * weaker on its own, but it resets its quote state at every line, so no construct can
 * carry a misread quote from one line into the next (the round-2 D3/D4 heredoc hides).
 * TIF-248 left it verbatim on purpose: it misreads `"${x:-" #"}"` (#447 round-3 D7) like
 * main did, but the union needs only one strategy to catch a line, and (a)/(b) now do.
 * Teaching (c) the same `${…}` rule would make it a second copy of (a)'s logic and remove
 * the independence that makes it useful: its value is that it fails DIFFERENTLY.
 * One exception (TIF-248 round 2, BS): a `#` right after an ESCAPED blank or operator
 * (`\ #`, `\;#`) is word text in bash, and main's copy cut the line there. The fix is one
 * condition (`escapedAt`), reads no new syntax, and can only make (c) strip less, so it
 * adds flags and cannot hide a line the verbatim copy caught. The `)#` and backtick fixes
 * need (a)'s context stack and stay out of (c).
 */
function stripShellCommentsPerLine(text: string): string {
  const joined = text.replace(/\r\n/g, "\n").replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .map((line) => {
      let quote: '"' | "'" | null = null;
      let escapedAt = -1; // TIF-248 round 2 BS: an escaped blank is not a word break
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === "'") {
          if (c === "'") quote = null;
        } else if (quote === '"') {
          if (c === "\\") i++;
          else if (c === '"') quote = null;
        } else if (c === "\\") {
          i++;
          escapedAt = i;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (
          c === "#" &&
          (i === 0 || (/[\s;&|()]/.test(line[i - 1] ?? "") && escapedAt !== i - 1))
        ) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * The lexing strategies launcherKeyViolations runs; a line is a violation if ANY of them
 * reports it (fail closed). See launcherKeyViolations.
 */
type Strategy = "whole-file" | "no-heredoc" | "per-line";
const STRATEGIES: Strategy[] = ["whole-file", "no-heredoc", "per-line"];
function stripBy(text: string, strategy: Strategy): string {
  if (strategy === "per-line") return stripShellCommentsPerLine(text);
  return stripShellComments(text, { heredocs: strategy === "whole-file" });
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
 * FAIL CLOSED (TIF-236 round 3). The file is stripped of comments three ways, every rule
 * is applied to each result, and the violations are UNIONED, so a line is flagged if ANY
 * strategy flags it. A line hidden from one strategy by a lexing quirk has to fool all
 * three at once:
 *  (a) "whole-file": stripShellComments, the quoting lexer with heredoc bodies opaque.
 *  (b) "no-heredoc": the same lexer with heredoc detection off, so heredoc bodies and
 *      anything a stray `<<` swallows (`$((1<<EOF))`) are lexed as code. This is the
 *      d06ca02a behaviour; it catches the arithmetic-`<<` hide (round-2 D5).
 *  (c) "per-line": origin/main's per-line stripper (stripShellCommentsPerLine). No quote
 *      state crosses a newline, so it catches any hide that relies on carrying a misread
 *      quote into a later line (round-2 D3/D4, a case-pattern `)` that leaves a quote
 *      open on the next line).
 * The cost is false positives: each strategy's mistakes add flags, none removes one.
 *
 * COVERED, anywhere in the file, after comments are stripped by each strategy above
 * (strategies (a) and (b) lex continuations; (c) joins them with a space):
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
 * otherwise. None of the three strippers is a full shell parser. A line is missed only
 * when ALL THREE misread it. The list below is NOT exhaustive: it names the cases known
 * today, each pinned by a "known limitation" test, and other misreads may exist:
 *  - `)` in a `case` pattern inside `$(…)` closes the substitution early in (a) and (b),
 *    and (c) misreads the same line, so `x="$(case a in a) echo " #";; esac)"; export …`
 *    hides the export (a false negative of the union).
 *  - `<<` in arithmetic (`$((1<<EOF))`) is read as a heredoc by (a), so (a) ALONE can
 *    hide a later line (round-2 D5: `X='`, `EOF`, `#'; export …`). The union catches
 *    that case through (b); no proof covers every arithmetic form.
 *  - Comments in a heredoc body are kept by (a) and stripped by (b) and (c), so a key
 *    export written in a body (which bash never runs) is flagged: a false positive.
 */
function launcherKeyViolations(
  text: string,
  opts: { launcher?: boolean; strategies?: Strategy[] } = {},
): string[] {
  const launcher = opts.launcher ?? true;
  const found = new Set<string>();
  for (const strategy of opts.strategies ?? STRATEGIES) {
    for (const v of violationsInStripped(stripBy(text, strategy), launcher)) found.add(v);
  }
  return [...found];
}

/** Apply every rule to each line of already-stripped text. */
function violationsInStripped(code: string, launcher: boolean): string[] {
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
  // Exact-output assertions about lexer (a) alone; the union adds the other strategies'
  // false positives on top (e.g. (c) has no backtick word start).
  const wholeFile = (t: string) => launcherKeyViolations(t, { strategies: ["whole-file"] });
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
    // TIF-236 round 3 (#447 round-2 verifier). D3: `foo\` swallows the next line, so the
    // first `EOF` is body text and the second ends the heredoc.
    "cat <<EOF\nfoo\\\nEOF\nit's\nEOF\necho 'q #'; export ANTHROPIC_API_KEY=x",
    // D4: `EOF\r` is not a terminator in bash.
    "cat <<EOF\nEOF\r\nit's\nEOF\necho 'q #'; export ANTHROPIC_API_KEY=x",
    // D5: `<<` in arithmetic; bash assigns X the three lines and runs the export.
    "echo $((1<<EOF))\nX='\nEOF\n#'; export ANTHROPIC_API_KEY=x",
    "echo $((1 << 2))\nX='\n2\n#'; export ANTHROPIC_API_KEY=x",
    // D6, each built so the per-line strategy (c) misses it too, so the row fails if the
    // named lexer behaviour is mutated. M14: `\⏎` inside "…" is deleted.
    'export "ANTHROPIC_\\\nAPI_KEY=x"',
    // M16: `\` is literal inside '…', so 'C:\' ends at the second quote.
    "echo 'C:\\'; X=\"it's\n #\"; export ANTHROPIC_API_KEY=x",
    // M17: `<<-` strips the tab, so `\tEOF` ends the body, not the later `EOF`.
    "cat <<-EOF\n\tit's\n\tEOF\nX=\"a'\nEOF\n#\"; export ANTHROPIC_API_KEY=x",
    // M17b: plain `<<` does NOT strip tabs, so `\tEOF` is body text.
    "cat <<EOF\nit's 'x\n\tEOF\nX=\"a'\nEOF\nY=\"b\n #\"; export ANTHROPIC_API_KEY=x",
    // M22b: both heredocs on one line are read, in order.
    "cat <<A <<B\na\nA\nit's\nB\nX=\"b'\n #\"; export ANTHROPIC_API_KEY=x",
    // TIF-248 (#447 round-3 D7): nested quotes inside "${…}". Each was clean under the
    // union at 9b11dc25 (all three strategies misread it) and bash 5.2.21 runs the export.
    // The per-line strategy (c) still misses each, so the row fails if the `${` context is
    // mutated away.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-" #"}"; export ANTHROPIC_API_KEY=x', // round-3 D7 minimal form
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-\'" #\'}"; export ANTHROPIC_API_KEY=x', // '…' inside ${…} inside "…"
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-\'}" #\'}"; export ANTHROPIC_API_KEY=x', // a quoted '}' does not close ${…}
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-${y:-" #"}}"; export ANTHROPIC_API_KEY=x', // nested ${…${…}…}
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-${y:-"a"}" #"}"; export ANTHROPIC_API_KEY=x', // nested, then quotes
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'x=a; echo "${x/"a"/" #"}"; export ANTHROPIC_API_KEY=x', // ${x/pat/rep}
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'x=a; echo "${x#*" #"}"; export ANTHROPIC_API_KEY=x', // ${x#…} with # and quotes
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-"a\n #"}"; export ANTHROPIC_API_KEY=x', // the nested string spans lines
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-" #"}"; read -r ANTHROPIC_API_KEY <<< x', // another rule after the prefix
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    "echo ${x:- #}; export ANTHROPIC_API_KEY=x", // unquoted ${…} in code: the `#` is literal
    // TIF-248 (#447 round-3 N1): bash's delimiter is `EOF\r`, so the LF `EOF` is body.
    "cat <<EOF\r\nEOF\nit's\nEOF\r\necho 'q #'; export ANTHROPIC_API_KEY=x",
    // A second unquoted ${…} in code (#460 round-1 nit); (c) misses it, so it pins the
    // code-context `${` rule.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    "x=a; echo ${x/a/ #}; export ANTHROPIC_API_KEY=x",
    // TIF-248 round 2 (#460 round-1 verifier). Each was checked against GNU bash 5.3.20,
    // which runs the export. R1: bash ends a backtick substitution at the next unescaped
    // backtick, even inside a `${` opened in it, so the `#` after it is word text. Flagged
    // at 9b11dc25, clean at f18fdd22; (c) misses both, so they pin the fix.
    "echo `${x:- #`#; export ANTHROPIC_API_KEY=x",
    "echo `echo ${x:- #`#; export ANTHROPIC_API_KEY=x",
    // BS: a `#` after an ESCAPED blank or operator is word text, not a comment. Clean
    // under the union at 9b11dc25 and f18fdd22. The last row hides from (c) through the
    // D7 prefix, so it fails if (a)/(b) regress.
    "echo \\ #; export ANTHROPIC_API_KEY=x",
    "echo \\;#; export ANTHROPIC_API_KEY=x",
    "echo \\|#; export ANTHROPIC_API_KEY=x",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    'echo "${x:-" #"}"; echo \\ #; export ANTHROPIC_API_KEY=x',
    // `)#`: the `)` of `$(…)` does not end the word, so the `#` is word text. Clean at
    // 9b11dc25 and f18fdd22; (c) misses each.
    "echo $(true)#; export ANTHROPIC_API_KEY=x",
    "echo x$(echo a)#y; export ANTHROPIC_API_KEY=x",
    "echo $()#; export ANTHROPIC_API_KEY=x",
    // Backtick-paren: a bare `(` inside backticks cannot hide the closing backtick. A
    // comment opened inside the `(` still ends at that backtick (first two rows), and the
    // backtick closes the substitution rather than opening a new one, so a `#` after it
    // is word text (last two rows). Clean at 9b11dc25 and f18fdd22; (c) misses each.
    "echo `( #`; export ANTHROPIC_API_KEY=x",
    "echo `(true; ( #`; export ANTHROPIC_API_KEY=x",
    "echo `( #`#; export ANTHROPIC_API_KEY=x",
    "echo `(true; ( #`#; export ANTHROPIC_API_KEY=x",
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
    expect(wholeFile("echo $'a\\'' # export ANTHROPIC_API_KEY=x")).toEqual([]);
    // TIF-236 round 2: an OPENING backtick is a word start, so this comment is stripped.
    expect(wholeFile("echo `# export ANTHROPIC_API_KEY=x`")).toEqual([]);
    // TIF-248 round 2: the `)` of a SUBSHELL ends a word (unlike `$(…)`'s), and `\⏎` is
    // deleted, so a `#` after either is still a comment, as in bash.
    expect(launcherKeyViolations("(true) # export ANTHROPIC_API_KEY=x")).toEqual([]);
    expect(launcherKeyViolations("echo \\\n# export ANTHROPIC_API_KEY=x")).toEqual([]);
    // A continuation inside "…" joins with nothing; the comment after the string strips.
    expect(launcherKeyViolations('echo "a\\\nb" # export ANTHROPIC_API_KEY=x')).toEqual([]);
    // A heredoc body is data: a `#` line in it is kept, and the line after the
    // terminator is code again.
    expect(launcherKeyViolations("cat <<EOF\n# header line\nvalue=1\nEOF\n# c")).toEqual([]);
    expect(
      launcherKeyViolations("cat <<EOF\n# export ANTHROPIC_API_KEY=x\nEOF").length,
    ).toBeGreaterThan(0);
    expect(
      wholeFile('echo "one\ntwo" # export ANTHROPIC_API_KEY=x\nexport ANTHROPIC_API_KEY=y'),
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
  it("known limitation: `<<` in arithmetic opens a heredoc in (a); the union still flags", () => {
    const d5 = "echo $((1<<EOF))\nX='\nEOF\n#'; export ANTHROPIC_API_KEY=x";
    expect(wholeFile(d5)).toEqual([]); // (a) alone is fooled (round-2 D5)
    expect(launcherKeyViolations(d5).length).toBeGreaterThan(0); // (b) catches it
    // And the lines (a) wrongly copies verbatim keep their comments: a false positive.
    expect(wholeFile("echo $((1 << 2))\necho hi # export ANTHROPIC_API_KEY=x").length).toBe(1);
  });
  it("known limitation: comments in a heredoc body are flagged (false positive)", () => {
    expect(launcherKeyViolations("cat <<EOF\n# export ANTHROPIC_API_KEY=x\nEOF").length).toBe(1);
  });
  it("fails closed: a line hidden from one strategy is still flagged by the union", () => {
    // Only (c) catches this: a case-pattern `)` closes `$(` early in (a) and (b), whose
    // quote state then spills into line 2 and hides its export. bash 4+ runs the export
    // (bash 3.2 cannot parse `case` inside `$(…)`).
    const onlyPerLine =
      'x="$(case a in a) echo "it\'s";; esac)"\necho \'q #\'; export ANTHROPIC_API_KEY=x';
    expect(
      launcherKeyViolations(onlyPerLine, { strategies: ["whole-file", "no-heredoc"] }),
    ).toEqual([]);
    expect(launcherKeyViolations(onlyPerLine, { strategies: ["per-line"] }).length).toBe(2);
    expect(launcherKeyViolations(onlyPerLine).length).toBeGreaterThan(0);
    // Only (b) catches round-2 D5 (see the arithmetic limitation above).
    const onlyNoHeredoc = "echo $((1<<EOF))\nX='\nEOF\n#'; export ANTHROPIC_API_KEY=x";
    expect(
      launcherKeyViolations(onlyNoHeredoc, { strategies: ["whole-file", "per-line"] }),
    ).toEqual([]);
    expect(launcherKeyViolations(onlyNoHeredoc, { strategies: ["no-heredoc"] }).length).toBe(2);
    expect(launcherKeyViolations(onlyNoHeredoc).length).toBeGreaterThan(0);
  });
  it("strategy (a) alone handles round-2 D3 and D4", () => {
    expect(
      wholeFile("cat <<EOF\nfoo\\\nEOF\nit's\nEOF\necho 'q #'; export ANTHROPIC_API_KEY=x").length,
    ).toBe(2);
    expect(
      wholeFile("cat <<EOF\nEOF\r\nit's\nEOF\necho 'q #'; export ANTHROPIC_API_KEY=x").length,
    ).toBe(2);
    // A quoted delimiter keeps `\` literal: `foo\` does not swallow the terminator.
    expect(wholeFile("cat <<'EOF'\nfoo\\\nEOF\n# export ANTHROPIC_API_KEY=x")).toEqual([]);
  });
  it("strategy (a) alone handles a CRLF heredoc operator line (TIF-248, #447 round-3 N1)", () => {
    // bash keeps the CR in the delimiter, so the LF `EOF` line is body text and only the
    // `EOF\r` line ends the heredoc; reading the delimiter as `EOF` would let `it's` open a
    // quote that hides the export.
    expect(
      wholeFile("cat <<EOF\r\nEOF\nit's\nEOF\r\necho 'q #'; export ANTHROPIC_API_KEY=x").length,
    ).toBe(2);
    // An all-CRLF heredoc still ends at its `EOF\r` line: the body line is kept (flagged)
    // and the comment after the terminator strips.
    expect(
      wholeFile(
        "cat <<EOF\r\n# export ANTHROPIC_API_KEY=x\r\nEOF\r\n# export ANTHROPIC_API_KEY=y\r\n",
      ),
    ).toEqual(["assigns the key: # export ANTHROPIC_API_KEY=x"]);
  });
  it("strategy (a) alone reads nested quotes in a parameter expansion (TIF-248, #447 round-3 D7)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(wholeFile('echo "${x:-" #"}"; export ANTHROPIC_API_KEY=x').length).toBe(2);
    // A real comment after the expansion still strips, and `${#…}` / `${x#…}` stay text.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(wholeFile('echo "${x:-" #"}" # export ANTHROPIC_API_KEY=x')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(wholeFile("echo ${x#*#} ${#x} # export ANTHROPIC_API_KEY=x")).toEqual([]);
    // A `}` inside a nested quote does not close the expansion.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text, not a JS template
    expect(wholeFile('echo "${x/b/"}"}" # export ANTHROPIC_API_KEY=x')).toEqual([]);
  });
  it("each strategy reads the TIF-248 round-2 word-break classes like bash 5 (#460)", () => {
    const noHeredoc = (t: string) => launcherKeyViolations(t, { strategies: ["no-heredoc"] });
    const perLine = (t: string) => launcherKeyViolations(t, { strategies: ["per-line"] });
    // (a) and (b): R1, BS, `)#` and backtick-paren each leave the export visible.
    for (const t of [
      "echo `${x:- #`#; export ANTHROPIC_API_KEY=x",
      "echo \\ #; export ANTHROPIC_API_KEY=x",
      "echo $(true)#; export ANTHROPIC_API_KEY=x",
      "echo `( #`; export ANTHROPIC_API_KEY=x",
    ]) {
      expect(wholeFile(t).length, t).toBe(2);
      expect(noHeredoc(t).length, t).toBe(2);
    }
    // (c) learns BS only (a one-condition change to the verbatim copy): an escaped blank
    // or operator before `#` is not a word break.
    expect(perLine("echo \\ #; export ANTHROPIC_API_KEY=x").length).toBe(2);
    expect(perLine("echo \\;#; export ANTHROPIC_API_KEY=x").length).toBe(2);
  });
  it("heredoc delimiters are unquoted before matching (false positives only if broken)", () => {
    // The body line is kept (flagged); the line after the terminator is code again and
    // its comment strips. A delimiter left quoted would never match, keeping both.
    for (const op of ["<<'EOF'", '<<"EOF"', "<<\\EOF", '<<E"O"F', "<<EOF"]) {
      expect(
        launcherKeyViolations(
          `cat ${op}\n# export ANTHROPIC_API_KEY=x\nEOF\n# export ANTHROPIC_API_KEY=y`,
        ),
      ).toEqual(["assigns the key: # export ANTHROPIC_API_KEY=x"]);
    }
  });
  it("a comment starts at text start and after ; & | ( ) (false positives only if broken)", () => {
    for (const t of [
      "#export ANTHROPIC_API_KEY=x",
      "true;#export ANTHROPIC_API_KEY=x",
      "true&#export ANTHROPIC_API_KEY=x",
      "true|#export ANTHROPIC_API_KEY=x",
      "(#export ANTHROPIC_API_KEY=x\ntrue)",
      "(true)#export ANTHROPIC_API_KEY=x",
    ]) {
      expect(launcherKeyViolations(t), t).toEqual([]);
    }
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
