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

LibreOffice quirk: through the MSAA→UIA proxy, controls report empty
RuntimeIds, so `uia_invoke` also accepts a JSON descriptor
(`{"hwnd":…, "control_type":…, "name":…}`) in place of a runtime id. Descriptors
go stale fast — e.g. after typing, the Name Box renames itself (`A1`→`A2`) —
so re-observe (`uia_tree`) after each mutation instead of caching descriptors.

### Timeouts (ADR-0003)

Every UIA call runs on an `IUIAutomation2` client with
`SetConnectionTimeout`/`SetTransactionTimeout` applied before any query, so a
killed or wedged app fails bounded with `OP_FAILED` (`...TIMEOUT after Ns...`)
instead of hanging. Config: `MYCO_UIA_CONNECT_TIMEOUT_MS` (default 5000),
`MYCO_UIA_TRANSACTION_TIMEOUT_MS` (default 10000).

LibreOffice specifics handled by the backend: the MSAA
`AccessibleObjectFromWindow(OBJID_CLIENT)` wake before each tree walk
(otherwise UIA sees only the title bar), and bring-to-front (Esc on shell
flyouts, Alt tap, `AttachThreadInput` + `SetForegroundWindow`, verify) before
any invoke. Screenshots are raw GDI BitBlt + GDI+ PNG — no Pillow needed.

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

### Interpreter: LibreOffice's bundled Python (required)

The agent MUST run under LibreOffice's bundled interpreter,
`C:\Program Files\LibreOffice\program\python.exe` — not the system Python
3.12. `pyuno` (`uno.py` / `pyuno.pyd`, the `uno_eval` op's dependency) is
built against LibreOffice's bundled Python ABI; importing it from the system
interpreter fails. All bootstrap scripts write `run-agent.cmd` accordingly,
and the agent's runtime deps (uiautomation, comtypes, pywin32) must be
installed into LO Python's site-packages (`& "C:\Program Files\LibreOffice\program\python.exe" -m pip install ...`).

### Deploying to the live VM (clean-deploy sequence)

Resets restore the `clean-base-live` snapshot, which wipes any deployed agent
(`docs/coordination/m1-state.md`), so always deploy onto a freshly reset VM:

```
~/VMs/myco-win11/scripts/reset.sh live   # guest clean, desktop logged in (~10s)
agent/bootstrap/deploy-to-vm.sh          # foreground; ends with "DEPLOY OK"
```

`deploy-to-vm.sh` copies the agent into the guest via scp, writes a fresh
per-deploy token file, registers the MycoAgent scheduled task from
`bootstrap/MycoAgent.xml`, starts the agent in the interactive session under
LO's bundled Python, and verifies `ping` through `ssh -L 8765:127.0.0.1:8765`.
Run it in the foreground and read the output; do not background it.

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
