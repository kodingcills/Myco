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
        "args": ["/tmp/myco_todo.py"]
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

##### Targetless variants (RT-008 / Discovery S0)

Some toolkits publish **no** accessibility nodes — Tk registers zero AT-SPI nodes
(RT-003) — so an app's entry field can hold focus with no ref to aim at. `typeText`
requires a `target` and `keyPress` only sends key names, which left no way to type a
single character into such an app. Two variants close that:

| Kind | Payload | Use |
|---|---|---|
| `typeTextGlobal` | `{"text": "..."}` | Type into the focused window via XTEST. |
| `clickAt` | `{"x": N, "y": N}` | Click a raw guest screen coordinate. |

```json
{"name": "act", "arguments": {"session_id": "df-s01-run-1",
  "action": {"kind": "typeTextGlobal", "text": "buy milk"}}}
```
```json
{"name": "act", "arguments": {"session_id": "df-s01-run-1",
  "action": {"kind": "clickAt", "x": 320, "y": 240}}}
```

- **Neither takes a ref**, so neither is bound to a state version and neither can be
  refused as `stale_ref`. That is deliberate: they address focus or a screen point,
  not an element from an observation.
- Both report **`delivered_unverified`**. The reason they exist is that the toolkit
  exposes nothing to read back, so a verification claim would be untrue. Confirm by
  reading app state — the Tk app publishes its widget contents to a file.
- Coordinates are guest screen coordinates; negative values are refused.
- Both are in `Permissions::default()`'s allowed set.

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

# NOTE (TIF-158): the DF-005 runner deploys the fixture itself to /tmp/myco_todo.py,
# under the session's read_root grant (/tmp), and launches it from there. The
# examples below use that path. The manual deploy in section 6 still works for
# ad-hoc use, but the runner no longer depends on it — and it must not, because
# the runner's own preflight (app-deployed) checks this path before it takes a slot.

# 3. Launch the target app
myco-rt act '{"kind": "launch", "command": "python3", "args": ["/tmp/myco_todo.py"]}'

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

> **If the private key is missing** (both keys are gitignored, so a fresh clone has
> only `README.md`), every command below fails with `Identity file not accessible`.
> Re-provision with `runtime/guest/provision.sh`, following
> [§6 Step -1 — provision](#step--1--provision-only-if-the-guest-does-not-exist)
> (`provision.sh --check` reports what is missing and exits non-zero until
> everything is present). Do not generate a key by hand over an existing overlay:
> cloud-init authorizes the key only on the overlay's first boot, so a hand-made key
> will not authenticate. `provision.sh` discards the old overlay when it has to
> re-key (see [`runtime/guest/keys/README.md`](../../runtime/guest/keys/README.md)).

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
    myco@localhost 'cat /tmp/df-s01.json'
```
Or copy to host:
```bash
scp -i runtime/guest/keys/id_ed25519 -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    myco@localhost:/tmp/df-s01.json ./runs/store-check.json
```

### REQ-10: Guest File Edit (Bug Fix / Injection)
```bash
scp -i runtime/guest/keys/id_ed25519 -P 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    dogfood/apps/myco-todo/myco_todo.py \
    myco@localhost:/tmp/myco_todo.py
```

### REQ-11: Guest Shell Exec (Headless Self-Test / Verification)
```bash
ssh -i runtime/guest/keys/id_ed25519 -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    myco@localhost 'python3 /tmp/myco_todo.py --self-test'
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

### Step -1 — provision (only if the guest does not exist)

The RT-020 guest state is **not** in every worktree: `runtime/guest/state/` is
gitignored and survives in exactly one place, the Runtime owner's worktree. If
preflight fails on `guest-ssh`, check there before assuming anything else:

```
~/.t3/worktrees/Myco/myco-runtime-v0-46676654c2342d9e/runtime/guest/
  state/noble-server-cloudimg-arm64.img   616 MB, SHA-256 50e24e1f…0348e
  state/base-image.sha256                 matches the pin in fetch-image.sh
  keys/id_ed25519.pub                     present
  keys/id_ed25519                         NOT committed; regenerated on demand
```

Facts that make provisioning cheap **when the image is already there**:

- `fetch-image.sh` is idempotent and hash-guarded: with a matching image present
  it prints `already present and SHA-256 verified (skipping download)` and
  returns. **No 616 MB download.**
- `make-seed.sh` regenerates the keypair if `keys/id_ed25519` is missing, then
  renders `seed/user-data` with whatever public key is on disk. So the `.pub`
  present here is **not** a key you can reuse — the private half is gone, and
  the seed must be re-rendered and the guest re-provisioned for the new key to
  be authorized. `mkisofs` is available and the seed renders (385 KB).
- No overlay exists (`state/*.qcow2` absent), so `create-overlay.sh` will build
  one. Disk headroom matters: check `df -h` first.
- `make-seed.sh` writes into the real `$STATE`, so it cannot be dry-run against
  a throwaway directory. Treat it as a real step, not a rehearsal.

**Do not provision under memory pressure.** If swap is near full with no VM
running, a boot plus trials is exactly the setup that turns a real `verified`
into a flaky `failure` — and a flaky `failure` is indistinguishable from a
genuine one in the ledger. Wait for a healthy host.

Provisioning sequence, once a window is approved. **Use `provision.sh`, not the
individual scripts** — it encodes the ordering below and the guards that make it
safe to re-run:

```bash
runtime/guest/provision.sh --check        # report state (incl. the agent), change nothing
runtime/guest/provision.sh                # keypair -> image -> overlay -> seed; never boots
runtime/guest/provision.sh --build-agent  # + the guest agent if missing: BOOTS A VM, under the lock
```

Two guards in `provision.sh` that the individual scripts do not have, both
learned the hard way:

- **A new key cannot reach an existing overlay.** cloud-init runs once with a
  fixed instance-id, so `ssh_authorized_keys` is never re-applied. If the private
  key is missing but an overlay exists, `make-seed.sh` refuses
  (`Refusing: SSH private key missing but an overlay exists`) and
  `provision.sh` discards the overlay *before* generating the key, so an
  interrupted run cannot leave "new key + old overlay" looking provisioned.
- **The `.pub` is derived from the private key, not the other way round.** If
  both exist but disagree, `provision.sh` rebuilds the `.pub` from the key.

### The guest agent binary (`provision.sh --build-agent`, TIF-120)

`create` fails without `myco-rt-agent`:

```
backend error: protocol: no agent binary on the host: build one with
runtime/guest/build-agent-in-guest.sh (it stores a copy under runtime/guest/state/)
```

It cannot be cross-compiled from macOS (`xa11y` links `libxkbcommon`, so the
musl build fails at link time); it must be built **inside the guest**. Plain
`provision.sh` never boots: when the agent is missing it exits **3** and prints
the fix. Building it is an explicit VM action:

```bash
runtime/guest/provision.sh --build-agent     # builds the agent if missing (~60 s + boot)
runtime/guest/provision.sh --rebuild-agent   # rebuild a stale agent
python3 scripts/df005-runner.py --preflight  # must exit 0 before anything else
```

With either flag, `provision.sh` first takes the **host VM lock**
(`scripts/vm-lock.sh`, `/tmp/myco-win11.vm.lock`) and the runtime's
**`state/SESSION.lock`**. If either is held it refuses with **exit 10** and boots
nothing. Only then does it boot the guest, or reuse one already running (left
running). It waits for cloud-init to report `done`, fails at once on
`status: error`, runs `build-agent-in-guest.sh` (one retry), and shuts down what
it booted, even on failure. A failed rebuild restores the previous agent. So a
`--build-agent` is a VM window like any other: get the Coordinator's slot first.

A stale agent (missing ops) is reported at `create` as `stale agent: missing
ops …`; fix it with `--rebuild-agent`.

**An interrupted build is recovered (TIF-154).** If a build was interrupted after
the old agent was moved to `state/myco-rt-agent-aarch64.prev`, the next
`provision.sh` run, in any mode, restores it. A leftover `.prev` next to a newer
agent is dropped. Both happen only while holding `state/SESSION.lock`, which every
build takes before moving the agent aside, so recovery never touches a build in
progress. A plain run that finds the lock held says so and leaves the files
alone.

### The introspection channel (TIF-120)

Tk registers no AT-SPI nodes, so the global route clicks the geometry the
fixture publishes (`entry_field`, `save_button`; TIF-122). That record reaches
`observe` only when the session's introspection channel is on. There are two
ways to turn it on, and **a path given on `create` wins over `gui.env`**:

1. **Per session (preferred):** pass the guest path on `create`:
   ```json
   {"name": "create", "arguments": {"session_id": "…", "introspection_file": "/tmp/myco-todo-state.json"}}
   ```
2. **Host-wide fallback:** a `MYCO_INTROSPECTION_FILE=…` line in
   `/run/myco/gui.env`. The agent applies it only when the session did not
   name a path.

Either way, the agent reads the record from that path as
`MYCO_INTROSPECTION_FILE`. Apps launched through `act` get `MYCO_TODO_STATE_FILE`
set to the same path, so myco-todo publishes exactly where `observe` reads
(ADR-0016). With neither, `a11y_tree.introspection` is `null`. A `create` path must be
absolute and use only letters, digits and `. _ - + /`.

**About the preflight:** `scripts/df005-runner.py --preflight`'s
`introspection-env` check looks only at route 2 (`gui.env`). The runner's
`create` call does not pass `introspection_file` yet. So until Dogfood updates the
runner, route 2 is the one that both passes the preflight and turns the channel
on. Once the runner passes `introspection_file`, that check should accept
route 1 instead of failing it.

**Threat-model note:** `introspection_file` lets a session read back any JSON
file the guest `myco` user can read, through `observe`, and the launched app
writes its state to that path. Like `launch_process` (arbitrary execution in the
guest), this is inside the guest; the isolation boundary is the VM
(`docs/research/runtime-safety-isolation.md`).

**Every guest launch takes the host VM lock (TIF-137).** `boot.sh`, the only
place in `runtime/` that starts qemu (so `create`, `reset`, `provision.sh
--build-agent`, `smoke.sh`, `live-proof.sh` alike), takes `/tmp/myco-win11.vm.lock`
before seeding, and qemu inherits it, so **a guest that `boot.sh` locked keeps the
lock for as long as it runs**, released when it exits (`destroy`, `shutdown.sh`).
If someone else
holds it, `boot.sh` refuses with exit 10 (`create` fails with "Refusing to boot:
the host VM lock is held by another owner"). A caller that already holds the lock,
such as `df005-runner.py --go`, a trial driver, or `provision.sh --build-agent`, is
recognised as an ancestor through the pid it recorded in the lock file and is not
asked to lock twice. **Under such a caller the guest is locked only as long as the caller's lock
reaches it.** `vm-lock.sh` drivers and `provision.sh` pass it down (fd 9 is
inherited), and so does `df005-runner.py` since TIF-137 (`McpClient(pass_fds=…)`,
and its release only closes its own copy, never `LOCK_UN`). So after a Ctrl-C
mid-trial, the guest the runner booted still holds the host lock until it is
destroyed. A caller that does *not* pass its lock down (a Python `os.open` fd is
close-on-exec by default) makes `boot.sh` print `VM lock WARNING: the caller's lock
was not inherited`: that guest is locked only while the caller runs. Either way, a
session left running keeps the host locked, so `destroy` sessions you are done with.

**Do not leave your own guest running.** The runtime's `create` boots its own
guest from the same overlay; if one is already up, `boot.sh` exits 1 and every
trial gaps with `script failed: boot.sh`. Boot only to build the agent, then shut
down and let the runtime own the lifecycle.

Verifying the key half without booting: point `MYCO_GUEST_DIR` at a temp dir
with a freshly generated key and run `--preflight`. The failure should advance
from "identity file not accessible" to "connection refused" — that means the
key is fine and only the boot is missing.

---

## 7. Operational Discipline & VM Lock Protocol

- **Shared VM Lock:** All live guest operations must respect `/tmp/myco-win11.vm.lock` via [`scripts/vm-lock.sh`](../../scripts/vm-lock.sh).
- **Coordinator GO:** Live VM execution is permitted only within a Coordinator-approved window. Do not touch or start `myco-win11` (UTM).
- **No Lingering VMs:** Every test run must conclude with `destroy` (or `runtime/guest/shutdown.sh`). Ensure `pgrep -f qemu-system-aarch64` reports no processes.

---

## 8. DF-005 Execution Procedure (the guest window, in order)

Guest time is the scarce resource. Run these in this order and stop at the first
failure — each step is cheaper than the one after it.

### Step 0 — preflight (read-only, ~10 s)

```bash
python3 scripts/df005-runner.py --preflight
```

Creates no session, launches nothing, and probes the VM lock with a non-blocking
`flock` it releases immediately (it names the holder rather than contending).
Exit 0 means every precondition holds:

| check | fails when |
|---|---|
| `mcp-server` | `runtime/target/debug/myco-rt-mcp` missing or not executable |
| `vm-lock` | held by another driver |
| `guest-ssh` | no answer, or not Linux |
| `app-deployed` | app absent, or guest sha256 ≠ repo sha256 (stale) |
| `app-self-test` | the fixture does not run in this guest |
| `introspection-env` | `MYCO_INTROSPECTION_FILE` absent from `/run/myco/gui.env` |

**Do not proceed on a failed preflight.** A run started against a stale app or a
dead introspection channel produces `gap` rows that look like runtime defects and
cost a slot to discover.

### Step 1 — deploy the fixture (if `app-deployed` failed)

```bash
scripts/deploy-verify-myco-todo.sh --go
```

Verifies the guest is Ubuntu 24.04 aarch64 with a live GUI env, uploads the app
with a sha256 check, and confirms the window maps.

### Step 2 — the run

```bash
python3 scripts/df005-runner.py --go --scenario all --runs 3 \
    --eval-id df-phase1-$(date -u +%Y%m%d-%H%M%S)
```

Writes `runs/<evalId>/{ledger.jsonl,<runId>/{trace.jsonl,result.json}}`.
Exit 0 only if **every** trial is a genuine success; any `gap`, `uncertain` or
`failure` exits non-zero. That is deliberate — an ungraded matrix must never look
green to a calling script.

### Step 3 — read the result honestly

```bash
python3 - <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
print(collections.Counter(r["state"] for r in rows))
for r in rows:
    if r["state"] != "pass":
        print(r["runId"], r["state"], r["oracle"], r["detail"])
PY
runs/<evalId>/ledger.jsonl
```

Buckets and what each means for filing are in
[`dogfood/scoring.md`](../../dogfood/scoring.md). In short: `gap` is a runtime
capability miss (file it), `uncertain` is "could not look" (never a pass, never a
failure), `failure` is the intent not met.

### Step 4 — tear down

`destroy` runs per trial. Confirm nothing lingers:

```bash
pgrep -f qemu-system-aarch64 || echo "no guest running"
```

### Known blocker: REQ-13

The runtime's `Action` union requires an AT-SPI ref for both `click` and
`typeText`, and exposes no focus-relative typing or coordinate-click action. Tk
registers zero AT-SPI nodes, so **DF-S01/S02/S05 will gap on REQ-04** against the
real fixture until REQ-13 lands. Expect that; it is a filed requirement, not a
harness bug. DF-S03/S04 additionally need REQ-10/11 and REQ-09.

If the slot is short, run DF-S01 only: it is the cheapest proof that the whole
path (create → observe → act → persist → independent oracle) works.
