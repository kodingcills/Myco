# myco-agent

The guest half of Myco's Milestone 1 control plane: a stdlib-only Python process
that runs inside the Windows VM's **interactive session** and exposes desktop
operations to the macOS host over newline-delimited JSON. Spec:
`docs/env/windows.md` §Control plane design. The agent holds **no policy, no
retries, no verdicts** — only ops; all decisions live host-side (ADR-0001).

## Protocol

- TCP on `127.0.0.1:8765` (reached from macOS via a UTM port forward or an
  `ssh -L` tunnel — both terminate on the same guest loopback).
- One request JSON object per line, one response JSON object per line.
- Every request carries `token`, read from a file ACL'd to `myco` only
(`MYCO_AGENT_TOKEN_FILE` env var or `--token-file`; default
`C:\ProgramData\Myco\agent.token`).

Request/response shapes:

```json
{"id": 1, "token": "...", "op": "ping", "params": {}}
{"ok": true, "id": 1, "result": {"agent_version": "0.1.0", "session_id": "..."}}
{"ok": false, "id": 1, "error": {"code": "AUTH_FAILED", "message": "..."}}
```

Stable error codes: `AUTH_FAILED`, `BAD_REQUEST`, `UNKNOWN_OP`, `OP_FAILED`,
`INTERNAL`. Op failures (backend exceptions) surface as `OP_FAILED`; the server
always answers and keeps serving.

## Ops

| Op | Params | Result |
|---|---|---|
| `ping` | — | `agent_version`, `session_id` |
| `session_info` | — | `session_id`, `window_station`, `desktop`, `user` |
| `launch` | `argv[]`, `cwd?` | `pid` |
| `uia_tree` | `pid?`, `title?`, `depth?=8` | depth-limited UIA subtree |
| `uia_invoke` | `runtime_id[]`, `action` (`invoke`\|`select`\|`set_value`), `value?` | `delivered` |
| `screenshot` | `pid?`, `rect?[x,y,w,h]` | `png_b64` |
| `read_file` | `path` | `data_b64` |
| `write_file` | `path`, `data_b64` | `bytes` |
| `kill` | `pid?` or `image_name` | `killed[]` |
| `uno_eval` | `call`, `sheet?`, `cell?`, `socket?` | UNO readback (`get_value`, `get_string`, `get_error`, `is_modified`) |

`read_file`/`write_file` take arbitrary absolute paths by design — fixtures and
artifacts live outside any single root. The agent is loopback-only and
token-authed; the host is the trusted caller. There is no path sandbox.

## Backends

Every op sits behind `OpsBackend` (`myco_agent/backend.py`) with two
implementations:

- **`WindowsBackend`** — the real thing. Imports `uiautomation`, `comtypes`,
  `pywin32`, and LibreOffice's bundled `uno` **lazily inside methods**, so the
  package imports and tests cleanly on macOS/Linux. Windows-only deps are an
  optional extra: `pip install -e ".[windows]"`.
- **`FakeBackend`** — a scriptable in-memory desktop (fake windows, fake UIA
  tree, fake files under a temp root, `crash_on(op)` to fault-inject). Used by
  the test suite and the host-side fake-app test double on CI.

Selection: `--backend windows|fake`, default auto-detect by platform
(`win32` → windows, else fake).

Server implementation: stdlib `socketserver.ThreadingTCPServer` — requests are
blocking desktop operations (UIA, capture) that parallelize per connection and
gain nothing from an event loop.

## Windows bootstrap

`bootstrap/MycoAgent.xml` registers a Task Scheduler task with
`LogonType=InteractiveToken` for `MYCO-WIN11\myco` (no stored password, per
`docs/env/windows.md` §Layer 2). `bootstrap/install-agent.ps1` (run from an
elevated SSH session) writes `run-agent.cmd`, registers the task, and starts
the agent in the interactive session.

## Recovery

The scheduled task has a `LogonTrigger` and `AllowStartOnDemand`; it is also
the first-boot path. If the agent dies or is wedged, from SSH (session 0):

```
schtasks /run /tn "MycoAgent"
```

then poll the `ping` op on `127.0.0.1:8765` until it answers. Evidence/logs the
agent cannot serve can still be fetched via `scp` or out-of-band
`utmctl file pull` (see `docs/env/windows.md` §Evidence capture).

## Development

```
cd agent
python -m venv .venv && . .venv/bin/activate
pip install -e . pytest
pytest -v
```

Tests exercise the real socket server against `FakeBackend`: protocol
round-trips for every op, auth rejection, malformed NDJSON, base64 file
round-trip, launch → UIA tree → invoke → screenshot → kill against the fake
desktop, op failures returning `OP_FAILED` without killing the server, and
server survival across a mid-request client disconnect.
