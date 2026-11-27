# One-command setup: `myco init`

`myco init` takes a fresh checkout to a gate your MCP clients can call, in one command.
It checks the Linux desktop path, starts the gate once to prove it launches, and writes
the `myco-gate` MCP server entry for Claude Code and Codex into your **project**
directory. It writes nothing outside the project unless you ask for that twice.

<!-- newcomer-path: setup -->
```sh
pnpm install --frozen-lockfile        # once, in the Myco checkout (the full install: see below)
cd /path/to/your/project
/path/to/Myco/bin/myco init --dry-run # every check and every planned change; writes nothing
/path/to/Myco/bin/myco init           # the same, then writes the two project files
```

`pnpm myco init` (from inside the Myco checkout) does the same; it configures the
directory you ran pnpm from (`INIT_CWD`, honoured only when pnpm runs this package's own
`myco` script; `bin/myco init` always means the current directory). `--project <dir>`
names a project explicitly. The project directory must already exist.

Init needs the checkout's full install. Myco is a private package with no runtime-only
dependency set: `tsx`, which runs every script including the gate, and `smol-toml`, which
init uses to re-parse Codex configs, are both devDependencies, so `pnpm install --prod` is
not a supported install.

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
| `--tasks <file>` | none: only the built-in `df-s01` / `df-s02`. An operator tasks file the gate loads (`myco-gate --tasks`, `{ "tasks": [ { id, family, stateFile, spec } ] }`), e.g. a `calc-record-edit` task for the Linux Calc path. Resolved against the project; init passes the path and never reads the file. |

`--tasks` is an operator flag of the gate, like `--evidence-root`: it decides which tasks
the gate knows. What the agent sends is unchanged (`taskId`, `runId`, `claim`), and the gate
stays bound to the one `--task` / `--run` assignment.

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
    created exclusively, so a link planted there is refused, not written through;
  - **never reads a hard-linked target**: a `.mcp.json` or `.codex/config.toml` with more
    than one hard link (another name of it may be `~/.claude.json`) is a conflict, and is
    not read, backed up or written. A target that is not a regular file (a directory, a
    FIFO) is a conflict too. The read itself checks the opened file (`fstat`: a regular
    file with one link) and opens non-blocking, so a FIFO swapped in is refused instead of
    hanging.
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
- **Line endings are the file's own.** In a file that uses CRLF, the inserted entry or
  block uses CRLF too, so the file never ends up with mixed line endings.
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
A dangling link, or one to something other than a regular file, is a conflict. So is a
user-level config with more than one hard link: the atomic rename would split the link and
leave its other names stale.

Prefer the project files: a user-level entry is bound to one task and run for every
project.

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

## The Linux path in one command

The default config binds the gate to the built-in `df-s01`. To bind it to the Linux Calc
path instead ([linux-path.md](linux-path.md)), point init at the task file the checkout
ships, [`examples/linux-path/tasks.json`](../../examples/linux-path/tasks.json) (task
`linux-calc-edit`: set record `EMP-0007`, column `name`, to `REVISED-269269` in
`saved.csv`, the same edit `pnpm myco-linux --demo` makes). From your project:

<!-- newcomer-path: linux -->
```sh
/path/to/Myco/bin/myco init --task linux-calc-edit --tasks /path/to/Myco/examples/linux-path/tasks.json
```

This replaces the `myco-gate` entry the quickstart wrote (same splice, backup first). The
gate then judges `<project>/.myco/evidence/local/saved.csv`: the file Calc saves, never the
agent's claim.

## macOS

Init configures the same gate on macOS. Step 2 is skipped there, and init says so:
`skipped: the Linux desktop path runs on Linux`. The run still exits 0, and the other
three steps are the same. Prerequisites: Node 24 or later and pnpm 10, nothing else. From
an empty directory:

<!-- newcomer-path: macos -->
```sh
git clone https://github.com/kodingcills/Myco.git myco
cd myco
pnpm install --frozen-lockfile
```

then the quickstart block at the top of this page, as written. This is the clone block of
[linux-path.md §2](linux-path.md#2-install-and-check) without its Linux-only
`pnpm myco-linux --check`.

## The newcomer path in CI

The `newcomer path (ubuntu-latest)` job (not a required check) follows these docs on a
clean runner, with nothing but the documented prerequisites installed (Node 24, pnpm 10 and
the LibreOffice line above). `test/init/newcomer-path.test.ts` runs, in order and as
written, every command of the blocks marked `<!-- newcomer-path: ... -->`:

1. [linux-path.md §2](linux-path.md#2-install-and-check): `git clone`, `cd myco`,
   `pnpm install --frozen-lockfile`, `pnpm myco-linux --check`. The only rewrite is the
   clone URL, which points at the commit under test;
2. the quickstart block at the top of this page (`--dry-run` must write nothing; the real
   run must print the four steps of the table above and write exactly `.mcp.json` and
   `.codex/config.toml`);
3. the README's [Quickstart: one command](../../README.md#quickstart-one-command) block,
   whose commands must all appear in step 2's block; run a second time, it must change no
   byte (the idempotency promise above);
4. the Linux path block above, then a **simulated** task: scripted agents (`honest`,
   `skips-save`) drive a real headless Calc on the file under the written evidence root,
   and the official MCP client, spawned exactly from the written `.mcp.json`, must get
   `verified` for the honest save and `refuted` for the unsaved edit.

The `newcomer path (macos-latest)` job (not required either) runs the same test on a clean
macOS runner with only Node 24 and pnpm 10 installed:

1. the [macOS](#macos) block above, from an empty directory (the same clone URL rewrite);
2. the quickstart block, with the same checks as step 2 above. In addition, step 2 of init's
   output must say it was skipped on darwin;
3. the README block, as in step 3 above;
4. a **simulated** `df-s01` task through the config the quickstart wrote: a scripted agent
   drives the mock desktop (no Calc on macOS) and the harness puts its saved store under the
   written evidence root. The official MCP client, spawned exactly from the written
   `.mcp.json`, must get `verified` for the honest save (`honest`) and `refuted` for a save
   that drops an item (`drops-item`).

Each command runs with `PATH` and a fresh empty `HOME` (plus the documented `MYCO_PYTHON` /
`MYCO_SOFFICE` overrides and proxy settings, if set), so nothing outside the docs helps it.
The documented placeholders `/path/to/Myco` and `/path/to/your/project` are the only
substitutions; any other `/path/to/...`, a command that exits non-zero, or a missing step
fails the job: that is a manual step the docs did not write down. Every command is timed,
and the run fails if clone to the first verified verdict takes longer than
`MYCO_NEWCOMER_BUDGET_S` (default 600 s). The timings are uploaded as the
`newcomer-path` artifact. The verdicts are SIMULATED (a scripted agent, no model, $0) and
are never evidence.

`test/init/newcomer-docs.test.ts` runs on every PR and catches drift without a clone:
every marked block exists and parses as init flags; the README quickstart is a subset of
this page's; the LibreOffice install line is the same in init, this page, linux-path.md and
the CI job; the Node and pnpm versions agree between `package.json`, the README,
linux-path.md and the CI job; this page's step table matches init's step headers; and the
shipped task file is the Linux demo task.

## End to end on the Linux path

`test/init/init-linux-e2e.test.ts` runs the whole chain on Linux with a real headless
LibreOffice Calc and no model ($0):

1. `bin/myco init --task linux-calc-edit --run e2e --tasks tasks.json`, without
   `--skip-desktop`, in a temp project with a temp HOME: the desktop check attaches Calc, the
   health check starts the real gate, and both project configs are written;
2. the test parses the **written** `.mcp.json` and `.codex/config.toml` and takes the evidence
   root, task, run and tasks file from the args init wrote;
3. the Linux path's own pieces (the fixture, the scripted agents `honest`, `wrong-row` and
   `skips-save`, and the Calc actuator `scripts/linux/calc_actuator.py`) drive Calc to open
   the fixture CSV at `<evidence-root>/<run>/saved.csv`, type the edit and save it (or not),
   so the bytes the gate reads are the bytes Calc wrote;
4. the official MCP client (`@modelcontextprotocol/sdk`) spawns the server exactly from each
   written config (environment `PATH` alone) and calls `myco_gate_check` with only
   `taskId` / `runId` / `claim`;
5. the verdicts must be `verified` (ORACLE_PASS) for the honest edit, and `refuted` with
   oracle codes (TARGET_MISMATCH, plus DOCUMENT_COLLATERAL for the wrong row) for the other
   two. Each result's evidence digest must equal the sha256 of the file Calc persisted.

It is opt-in like the Linux path suite (`MYCO_LINUX_PATH=1`), skips without soffice or
Python-UNO, and FAILS instead of skipping under `MYCO_LINUX_PATH_REQUIRED=1`, which the
`linux path (ubuntu-latest)` CI job sets; that job runs it as its own step and uploads the
transcript with the Linux path runs.

```sh
MYCO_LINUX_PATH=1 pnpm exec vitest run test/init/init-linux-e2e.test.ts
```

Tests: `test/init/init.test.ts` (temp HOME and temp project; the last block runs
`bin/myco init` end to end against the real gate) and the end-to-end test above.
