# Dogfood Runtime Runbook: Operating on the RT-020 Desktop

**Status:** Ratified 2026-11-22 for Dogfood Phase 1 (DF-005 / TIF-27).  
**Backlog References:** [DF-005 (TIF-27)](../backlog/dogfood.md#df-005-tif-27-phase-1-run-df-s01df-s05-through-the-real-runtime), [RT-020 (TIF-56)](../backlog/runtime.md#rt-020-tif-56-arbitrary-agent-obtains-a-safe-isolated-desktop-end-to-end), [RT-011 (TIF-40)](../backlog/runtime.md#rt-011-tif-40-end-to-end-integration-test-thinnest-north-star-path).  
**State Docs:** [docs/coordination/dogfood-state.md](../coordination/dogfood-state.md), [docs/coordination/runtime-state.md](../coordination/runtime-state.md).

---

## 1. Overview & Architecture

The Myco Desktop Runtime (RT-020) provides an isolated, disposable desktop environment executing inside a hardware-virtualized Linux ARM64 QEMU+HVF guest on macOS (Ubuntu Server 24.04 LTS, Xvfb :0, Openbox window manager, AT-SPI2 accessibility bus, and xdotool input synthesis).

### Surface Split per ADR-0013:
1. **MCP Server (`myco-rt-mcp`)** — Primary agent surface (for the Dogfood agent under test, e.g. Oh My Pi / LLM agent). JSON-RPC 2.0 over stdio with typed tool schemas and session memory.
2. **CLI (`myco-rt`)** — Primary harness surface (for Dogfood host-side test drivers, runners, and oracles). JSON in / JSON out on stdin/stdout, stateless per call via `$MYCO_RT_STATE`.

### Workspace Auto-Discovery (RT-020):
Both binaries implement workspace discovery ($MYCO_HOME → upward traversal from `cwd` → upward traversal from binary location). Dogfood agents and test runners can invoke the runtime from any directory without requiring a manual `cd`.

---

## 2. Binaries & Build

The runtime crates live in `runtime/crates/`:
- CLI: `runtime/target/debug/myco-rt`
- MCP Server: `runtime/target/debug/myco-rt-mcp`

To build or verify the binaries on the host:
```bash
cargo build --manifest-path runtime/Cargo.toml -p myco-rt-cli -p myco-rt-mcp
# or from the runtime workspace directory:
(cd runtime && cargo build -p myco-rt-cli -p myco-rt-mcp)
```

---

## 3. MCP Server Surface (Agent Under Test)

The MCP server speaks JSON-RPC 2.0 over stdio:
```bash
runtime/target/debug/myco-rt-mcp
```

### Handshake
Call `initialize` followed by `tools/list`. The server reports 7 tools:
`["create", "observe", "act", "evidence", "read_file", "reset", "destroy"]`.
Six are the v0 lifecycle; `read_file` is an opt-in seventh (RT-015) that only
works for a session created with `read_root`.

### Tool Calling (`tools/call`)

#### 1. `create` — Provision Desktop
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create",
    "arguments": {
      "session_id": "df-s01-run-1"
    }
  }
}
```
- **Response:** `{"ok": true, "session_id": "df-s01-run-1"}`
- **Timing:** ~108s cold boot (includes cloud-init and X11 session initialization).

#### 2. `observe` — Read Accessibility Tree & Screenshot
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "observe",
    "arguments": {
      "session_id": "df-s01-run-1"
    }
  }
}
```
- **Response:**
  - `state_version`: monotonic integer (e.g. 2).
  - `a11y_tree`: AT-SPI hierarchy containing nodes with stable `ref` identifiers (e.g. `n1`, `n2`, `n4`).
  - `screenshot`: path to PNG file on host (e.g. `/tmp/myco-observe-2.png`).
  - `processes`: list of `{pid, name}`.
  - `windows`: list of `{id, title, pid}`.

#### 3. `act` — Desktop Actuation with Read-Back Verification
Every action returns a three-way outcome: `delivered_verified`, `delivered_unverified`, or `failed` (with reason).

- **Launch Process:**
  ```json
  {
    "name": "act",
    "arguments": {
      "session_id": "df-s01-run-1",
      "action": {
        "kind": "launch",
        "command": "python3",
        "args": ["/home/myco/myco-todo/myco_todo.py"]
      }
    }
  }
  ```
- **Type Text into Node Ref:**
  ```json
  {
    "name": "act",
    "arguments": {
      "session_id": "df-s01-run-1",
      "action": {
        "kind": "typeText",
        "target": "n4",
        "text": "clean desk"
      }
    }
  }
  ```
- **Click Node Ref:**
  ```json
  {
    "name": "act",
    "arguments": {
      "session_id": "df-s01-run-1",
      "action": {
        "kind": "click",
        "target": "n5"
      }
    }
  }
  ```
- **Key Press:**
  ```json
  {
    "name": "act",
    "arguments": {
      "session_id": "df-s01-run-1",
      "action": {
        "kind": "keyPress",
        "keys": "Return"
      }
    }
  }
  ```

#### 4. `evidence` — Fetch Run Artifacts
```json
{
  "name": "evidence",
  "arguments": {
    "session_id": "df-s01-run-1"
  }
}
```
- **Response:**
  - `trace`: absolute path to `runs/<session_id>/trace.jsonl` (strict newline-delimited JSON events).
  - `result`: absolute path to `runs/<session_id>/result.json` (`recordKind: "session"`, no `verdict` field, conforming to M1 schema).

#### 5. `reset` — Clean Desktop Restoration
```json
{
  "name": "reset",
  "arguments": {
    "session_id": "df-s01-run-1"
  }
}
```
- **Behavior:** Discards ephemeral qcow2 overlay, reboots, and recovers desktop session.
- **Timing:** ~52s.

#### 6. `destroy` — Teardown & Process Cleanup
```json
{
  "name": "destroy",
  "arguments": {
    "session_id": "df-s01-run-1"
  }
}
```
- **Behavior:** Clean guest shutdown, qemu process termination, overlay deletion.
- **Timing:** ~1.1s.

#### 7. `read_file` — Bounded Guest File Read (RT-015, opt-in)

Only available for a session created with `read_root`:
`create {"session_id": "...", "read_root": "/home/ubuntu/project"}`. An absolute
directory is required; `/` is refused, because a grant rooted there is not a grant.

```json
{
  "name": "read_file",
  "arguments": {
    "session_id": "df-s01-run-1",
    "path": "out/build.log"
  }
}
```
- **Behavior:** `path` is resolved with `openat2` under `RESOLVE_BENEATH`, so it
  cannot escape the grant root; symlinks are refused (`NO_SYMLINKS`) and so is
  crossing into another mount (`NO_XDEV`). Traversal components and absolute paths
  are rejected before any syscall, and anything that is not a regular file is
  refused. Content is returned base64 with `raw_bytes` (the pre-encoding length);
  files over 1 MiB are refused.
- **Without a grant:** a session created without `read_root` has no filesystem
  reach at all — this is deliberate, so an agent gets no host-adjacent reads unless
  the harness asked for them at `create` time.
- **Timing:** one guest round trip (~0.1s).

---

## 4. CLI Surface (Dogfood Test Harness & Oracles)

The CLI front end is `runtime/target/debug/myco-rt`. It tracks the active session in `$MYCO_RT_STATE` (defaults to `<repo>/runtime/state/session.json`).

### Standard Commands

```bash
# 1. Create a session
myco-rt create '{"session_id": "df-s01-harness"}'

# 2. Observe current state
myco-rt observe

# 3. Launch the target app
myco-rt act '{"kind": "launch", "command": "python3", "args": ["/home/myco/myco-todo/myco_todo.py"]}'

# 4. Act by Accessible Widget Name (CLI resolves name against observation tree)
myco-rt act '{"kind": "typeText", "name": "sanity-entry", "text": "myco-df-probe"}'

# 5. Retrieve evidence paths
myco-rt evidence

# 6. Reset session
myco-rt reset

# 7. Destroy session
myco-rt destroy
```

---

## 5. Host-Side Guest Access for Dogfood Oracles

Dogfood scenarios require host-side oracle checks against guest state (REQ-08, REQ-10, REQ-11) without depending on agent claims:

- **Host Port Forward:** `127.0.0.1:10022`
- **Guest User:** `myco`
- **Private Key:** `runtime/guest/keys/id_ed25519` (permissions `0600`)

> **If the private key is missing** (it is gitignored, so a fresh clone has only
> `README.md` and `id_ed25519.pub`), every command below fails with
> `Identity file not accessible`. Generate it per
> [`runtime/guest/keys/README.md`](../../runtime/guest/keys/README.md) and
> re-provision the guest — cloud-init bakes the public key in, so a key generated
> after provisioning will not authenticate.

### Standard SSH Execution Command
```bash
ssh -i runtime/guest/keys/id_ed25519 \
    -p 10022 \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    myco@localhost '<guest-command>'
```

### REQ-08: Host-Side Guest File Read (Oracle Inspection)
To inspect the application's persisted state JSON:
```bash
ssh -i runtime/guest/keys/id_ed25519 -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    myco@localhost 'cat /home/myco/myco-todo/store.json'
```
Or copy to host:
```bash
scp -i runtime/guest/keys/id_ed25519 -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    myco@localhost:/home/myco/myco-todo/store.json ./runs/store-check.json
```

### REQ-10: Guest File Edit (Bug Fix / Injection)
```bash
scp -i runtime/guest/keys/id_ed25519 -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    dogfood/apps/myco-todo/myco_todo.py \
    myco@localhost:/home/myco/myco-todo/myco_todo.py
```

### REQ-11: Guest Shell Exec (Headless Self-Test / Verification)
```bash
ssh -i runtime/guest/keys/id_ed25519 -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    myco@localhost 'python3 /home/myco/myco-todo/myco_todo.py --self-test'
```

---

## 6. Target Application Deployment (`myco-todo`)

To deploy and smoke-test `myco-todo` in an active desktop session:
```bash
bash scripts/deploy-verify-myco-todo.sh --go
```
This script:
1. Verifies guest SSH availability.
2. Transfers `dogfood/apps/myco-todo/myco_todo.py` and checks SHA-256 integrity.
3. Sources the interactive GUI environment `/run/myco/gui.env` (`DISPLAY=:0`, `DBUS_SESSION_BUS_ADDRESS`).
4. Executes `python3 myco_todo.py --self-test` (verifying seeded bug `BUG in parser` dropped).
5. Starts the app and verifies the visible X11 window using `xdotool`.

---

## 7. Operational Discipline & VM Lock Protocol

- **Shared VM Lock:** All live guest operations must respect `/tmp/myco-win11.vm.lock` via [`scripts/vm-lock.sh`](../../scripts/vm-lock.sh).
- **Coordinator GO:** Live VM execution is permitted only within a Coordinator-approved window. Do not touch or start `myco-win11` (UTM).
- **No Lingering VMs:** Every test run must conclude with `destroy` (or `runtime/guest/shutdown.sh`). Ensure `pgrep -f qemu-system-aarch64` reports no processes.
