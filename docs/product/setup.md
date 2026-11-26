# One-command setup: `myco init`

`myco init` takes a fresh checkout to a gate your MCP clients can call, in one command.
It checks the Linux desktop path, starts the gate once to prove it launches, and writes
the `myco-gate` MCP server entry for Claude Code and Codex into your **project**
directory. It writes nothing outside the project unless you ask for that twice.

```sh
pnpm install --frozen-lockfile        # once, in the Myco checkout
cd /path/to/your/project
/path/to/Myco/bin/myco init --dry-run # every check and every planned change; writes nothing
/path/to/Myco/bin/myco init           # the same, then writes the two project files
```

`pnpm myco init` (from inside the Myco checkout) does the same; it configures the
directory you ran pnpm from (`INIT_CWD`, honoured only when pnpm runs this package's own
`myco` script; `bin/myco init` always means the current directory). `--project <dir>`
names a project explicitly. The project directory must already exist.

## What it does

| Step | What | On failure |
|---|---|---|
| 1. gate launcher | `node_modules/.bin/tsx` and `scripts/myco-gate.ts` exist in this checkout | says to run `pnpm install --frozen-lockfile`; writes nothing; exit 1 |
| 2. Linux desktop path | `soffice --version` names LibreOffice, and `python3 -c 'import uno'` works (the headless Calc path CI's `linux-path` job runs, [linux-path.md](linux-path.md)). `MYCO_SOFFICE` / `MYCO_PYTHON` override the binaries. Skipped off Linux, or with `--skip-desktop`. | names each missing piece and prints the install line CI uses (`sudo apt-get install -y --no-install-recommends libreoffice-calc python3-uno`); the configs are still written; exit 1 |
| 3. gate health check | starts the gate with the **exact launch line it is about to write**, with `PATH` as its only environment variable, and runs an MCP session: `initialize`, `tools/list` (must be exactly `myco_gate_check`), and one `tools/call` naming a task other than the assignment, which must come back `uncertain` / `ASSIGNMENT_MISMATCH` (the gate is bound to its trial and fails closed). The probe reads no evidence. | prints what failed; **writes nothing**; exit 1 |
| 4. MCP client configs | merges the `myco-gate` entry into `<project>/.mcp.json` (Claude Code) and `<project>/.codex/config.toml` (Codex) | a file that cannot be merged safely is a conflict; **no file is written while any conflict remains** (not even the other one); exit 1 |

The entry is the same launch line as
[`examples/mcp-clients/claude-code.mcp.json`](../../examples/mcp-clients/claude-code.mcp.json)
and option 2 of [`codex.config.md`](../../examples/mcp-clients/codex.config.md), with your
paths filled in:

| Flag | Default |
|---|---|
| `--task <id>` | `df-s01` |
| `--run <id>` | `local` |
| `--evidence-root <dir>` | `<project>/.myco/evidence` (the gate reads `<dir>/<run>/<stateFile>`) |

Exit codes: `0` done (or a dry run), `1` a check failed or a config conflicted, `3` usage.

## What it changes, and what it never touches

- **Project mode (the default) reads and writes only inside the project directory** (and
  checks that the launcher exists in the Myco checkout). It never reads or writes
  `~/.claude`, `~/.claude.json` or `~/.codex`. To make sure of that, it:
  - **refuses a project directory that is your home directory** (where
    `.codex/config.toml` *is* the user-level Codex config), or that is inside `~/.claude`,
    `~/.codex` or `$CODEX_HOME`, or whose `.codex` is `$CODEX_HOME`. This is a usage error
    (exit 3) before anything starts. To find out, it resolves links in those paths
    (metadata only); it never opens anything in them;
  - **never follows a symlink** in the project: a `.mcp.json`, `.codex` or
    `.codex/config.toml` that is a link is a conflict, and is not read, backed up or
    written. A cloned repository can ship such a link (say `.codex -> ../../.codex`).
    Reads refuse a link at the last component (`O_NOFOLLOW`), backups and temp files are
    created exclusively, so a link planted there is refused, not written through.
- **Only the `myco-gate` entry changes, and every other byte of the file is kept.** The
  change is one splice of the original text: in `.mcp.json`, the value of
  `mcpServers["myco-gate"]` (or one inserted member, in the file's own indentation); in the
  Codex TOML, a block between `# >>> myco-gate ...` and `# <<< myco-gate <<<` markers.
  Init never re-serialises a file, so key order, indentation, number spelling (a
  20-digit integer stays as written) and comments survive. The result is parsed again
  (`JSON.parse`; a TOML parser, `smol-toml`) and must equal the original document plus the
  entry, or nothing is written.
- **Conflicts fail closed.** Init leaves a file alone and reports a conflict when: it does
  not parse (TOML errors are reported by line and column only, never quoted); it already
  defines `mcp_servers.myco-gate` outside the markers, including inside an
  `[mcp_servers]` table (`myco-gate = {...}` or `myco-gate.command = ...`); its
  `mcp_servers` is not a table; the marked block was edited by hand; a key appears twice;
  an existing JSON `myco-gate` entry has keys init does not manage (an `env`, say); or the
  merged file would not parse to exactly the original plus the entry.
- **Every changed file is backed up first**, to `<file>.myco-backup-<UTC timestamp>` next to
  it (anything already at that name, even a dangling link, is skipped for the next name),
  and the file keeps its permission bits. A newly created file has no backup.
- **Idempotent.** A second run reports both files `unchanged` and writes nothing.
- **The diff is exactly the change**: the bytes removed (`-`) and inserted (`+`) at a
  given line and column, and nothing else of the file. So another server's `env` values
  are never echoed, and what `--global` prints is what `--global --yes` writes.
- **No secrets.** The entry has no `env` table, key or token; the gate needs none. Init
  reads exactly five environment variables (`HOME`, `CODEX_HOME`, `PATH`, `MYCO_SOFFICE`,
  `MYCO_PYTHON`), never enumerates the environment, and gives every process it starts an
  environment of `PATH` alone. It never opens a credentials file. (`soffice` and Python
  themselves may still touch their own caches under your passwd home directory, such as
  `~/.cache/dconf` or `~/.local/lib/python3.*`; init does not control that.)
- **Do not commit the written `.mcp.json`.** It holds absolute paths of your machine (the
  Myco checkout's `tsx`, the evidence root), which usually include your user name.
- **The Windows VM path is out of scope.** Init starts only `soffice`, Python and the gate.
  The VM has a single owner and runs under a lock; set it up separately with
  [quickstart.md](quickstart.md) and [docs/eval-runbook.md](../eval-runbook.md).

## User-level configs: `--global`

```sh
bin/myco init --global        # prints the dry-run diff for the user-level configs; writes nothing
bin/myco init --global --yes  # applies exactly that change, backing up each file first
```

`--global` targets the user-level files instead of the project: `$HOME/.claude.json`
(where `claude mcp add --scope user` keeps user-scoped servers) and
`${CODEX_HOME:-$HOME/.codex}/config.toml`. Without `--yes` it is a dry run, whatever else is
given. `--yes` without `--global` is a usage error. The same splice, conflict, backup and
no-secrets rules apply.

If a user-level config is a **symlink** (a dotfiles setup, say), init writes through to the
file it names, so the link is kept and keeps working, and backs up that target file next to
it. The dry run says so (`note: a symlink to <target>: init writes through to that file`).
A dangling link, or one to something other than a regular file, is a conflict. Prefer the project files: a user-level entry is bound to one task and run for
every project.

## This is a starter config, not a trial harness

The gate judges `<evidence-root>/<run>/<stateFile>`, and a file the agent can write is not
evidence. The default evidence root sits in the project for local development. For a gated
trial, the harness writes a per-trial config that points at a host-side capture the agent
cannot write ([docs/gate/api.md](../gate/api.md), [clients.md §5](../gate/clients.md#5-security-model)),
and the harness, not the client, decides "done" from `accepted`.

## Example (Linux, LibreOffice installed)

```text
$ bin/myco init --project /tmp/demo-project
myco init: project mode
  project: /tmp/demo-project

[1/4] gate launcher
  ok  /path/to/Myco/node_modules/.bin/tsx
  ok  /path/to/Myco/scripts/myco-gate.ts

[2/4] Linux desktop path (headless LibreOffice Calc)
  ok  soffice (soffice): LibreOffice 24.2.7.2 420(Build:2)
  ok  python-uno (python3 -c 'import uno'): ok
  attached: run `pnpm myco-linux --demo` to drive it end to end

[3/4] gate health check (the launch line written below, with PATH as its only environment variable)
  ok  started the gate bound to df-s01/local; MCP handshake answered
  ok  tools/list: exactly myco_gate_check
  ok  a call naming another task: uncertain / ASSIGNMENT_MISMATCH (fails closed)

[4/4] MCP client configs
  Claude Code: /tmp/demo-project/.mcp.json
    create, new file:
    + {
    +   "mcpServers": {
    ...
  wrote /tmp/demo-project/.mcp.json
  wrote /tmp/demo-project/.codex/config.toml
...
myco init: done
```

Tests: `test/init/init.test.ts` (temp HOME and temp project; the last block runs
`bin/myco init` end to end against the real gate).
