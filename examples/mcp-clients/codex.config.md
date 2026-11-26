# Codex CLI: `myco-gate` MCP server config

Run on 2026-11-26 with `codex-cli 0.168.0`. The transcript is in
[codex-transcript.md](codex-transcript.md). The placeholders are the same as in the
[README](README.md).

## Option 1: command-line overrides (what was run)

This changes no config file. `--ignore-user-config` skips only the user's
`$CODEX_HOME/config.toml`. Project-level (`.codex/`) and admin or managed config can
still load, so run from an empty working directory (`-C`) that has no `.codex/`, as the
recorded run did:

```sh
codex exec --ignore-user-config --ephemeral --json -s read-only \
  -C /path/to/empty-workdir \
  -c approval_policy='"never"' \
  -c 'mcp_servers.myco-gate.command="/path/to/Myco/node_modules/.bin/tsx"' \
  -c 'mcp_servers.myco-gate.args=["/path/to/Myco/scripts/myco-gate.ts","mcp","--evidence-root","/path/to/evidence","--task","df-s01","--run","run-42","--audit","/path/to/gate-decisions.jsonl"]' \
  'Call myco_gate_check with taskId "df-s01" and runId "run-42", then report the verdict.' \
  < /dev/null
```

`codex exec` reads extra prompt input from stdin when stdin is not a terminal. Without
`< /dev/null` (or a piped prompt) it waits forever.

## Option 2: the same as TOML

These are the same keys, for a harness-owned Codex profile or config. Do not let the agent
edit this file (see the security model in [clients.md](../../docs/gate/clients.md#5-security-model)):

```toml
[mcp_servers.myco-gate]
command = "/path/to/Myco/node_modules/.bin/tsx"
args = [
  "/path/to/Myco/scripts/myco-gate.ts", "mcp",
  "--evidence-root", "/path/to/evidence",
  "--task", "df-s01",
  "--run", "run-42",
  "--audit", "/path/to/gate-decisions.jsonl",
]
```

The server needs no environment variables, so the config has no environment-variable
table. Do not add secrets to it.

Gate "done" on `accepted` and `reasonCodes` from `structured_content`. In Codex's `--json`
events, MCP `isError: true` shows up as the `mcp_tool_call` item's `"status":"failed"`;
`result` carries only `content` and `structured_content` (see the transcript).
