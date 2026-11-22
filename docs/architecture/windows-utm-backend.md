# Design Note: Windows/UTM Backend Interface Anticipation (`UtmWindowsBackend`)

**Document:** `docs/architecture/windows-utm-backend.md`  
**Status:** Design only (RT-012 / TIF-41), 2026-11-22.  
**Author:** RT Coordinator.  
**Reviewer:** Myco M1 Coordinator.  
**Prerequisites:** ADR-0011 (Host backend), ADR-0012 (M1 boundary), ADR-0013 (API surface), RT-005 (`Backend` trait).  
**Constraint:** **Design only. Does not touch, execute, or modify `myco-win11` or UTM.**

---

## 1. Context and Objective

The Myco Desktop Runtime defines a unified six-operation lifecycle and session layer (`create`, `observe`, `act`, `evidence`, `reset`, `destroy`) exposed over MCP and CLI (ADR-0013). While v0 implemented the Linux ARM64 QEMU+HVF backend (`QemuLinuxBackend`, RT-006 / RT-020), Milestone 1 already operates an interactive Windows 11 ARM64 VM in UTM (`myco-win11`) driven by `myco-agent` (ADR-0001, M1-005).

The objective of **RT-012** is to anticipate and specify the interface seam for `UtmWindowsBackend`, enabling future agents to drive Windows desktops through the same standard six-op MCP/CLI runtime surface without coupling the runtime to M1's task runner.

---

## 2. Architecture & The `Backend` Seam

In `myco-rt-core` (`runtime/crates/myco-rt-core/src/ops.rs`), the host backend seam is defined by the `Backend` trait:

```rust
pub trait Backend: Send {
    type Err: std::error::Error + Send + Sync + 'static;

    fn provision(&mut self) -> Result<(), Self::Err>;
    fn observe(&mut self) -> Result<Observation, Self::Err>;
    fn act(&mut self, action: &Action) -> Result<ActionOutcome, Self::Err>;
    fn evidence(&mut self) -> Result<EvidenceArtifacts, Self::Err>;
    fn reset(&mut self) -> Result<(), Self::Err>;
    fn destroy(&mut self) -> Result<(), Self::Err>;
}
```

`UtmWindowsBackend` implements `Backend` by bridging between the Rust runtime session and M1's existing guest-agent protocol:

```
[Agent / MCP Client]
        │  JSON-RPC 2.0 (stdio)
        ▼
[myco-rt-mcp / myco-rt-cli]
        │  Rust API
        ▼
[myco-rt-core::Session]
        │  Backend trait
        ▼
[UtmWindowsBackend]
   ├── Host VM Supervisor (wraps osascript / scripts/vm.sh / scripts/reset.sh)
   └── Guest Agent Client (TCP 127.0.0.1:8765, NDJSON, token auth)
              │
              ▼ (Loopback TCP / SSH tunnel)
   [myco-win11 Guest: myco-agent (Python 3.12 / UIA / WinSta0)]
```

---

## 3. Detailed Operation Mapping to `myco-agent`

M1's Windows guest agent (`agent/myco_agent/server.py`) listens on loopback TCP port `8765` inside the interactive desktop session (`WinSta0\Default`). Every request is NDJSON containing an `id`, `token`, `op`, and `params`.

### 3.1 `provision(&mut self)`
- **Host VM Check:** Verifies VM state against the shared lock `/tmp/myco-win11.vm.lock` via `scripts/vm-lock.sh`. Fails immediately if the VM is locked by another runner.
- **Connection Handshake:** Establishes a TCP stream to `127.0.0.1:8765` (via UTM host port-forward or SSH `-L 8765:127.0.0.1:8765`).
- **Authentication:** Transmits `{"id": 1, "token": token, "op": "ping", "params": {}}`.
- **Session Verification:** Transmits `session_info` and verifies:
  - `window_station == "WinSta0"` (ensuring interactive session, not session 0 service isolation).
  - `desktop == "Default"`.
- **Readiness:** Returns `Ok(())` once the interactive desktop is responsive.

### 3.2 `observe(&mut self) -> Result<Observation, Self::Err>`
- **Accessibility Tree (`uia_tree`):**
  - Sends `{"id": n, "token": token, "op": "uia_tree", "params": {"pid": null, "depth": 8}}`.
  - The guest agent queries `IUIAutomation2` with configured connection and transaction timeouts (`MYCO_UIA_CONNECT_TIMEOUT_MS`, default 5000ms).
  - Translates Windows UI Automation nodes (Name, ControlType, AutomationId, RuntimeId, BoundingRectangle) into the runtime's JSON accessibility tree.
  - Generates opaque, stable element references (`wN` for windows, `aN` for controls).
- **Screenshot (`screenshot`):**
  - Sends `{"id": n, "token": token, "op": "screenshot", "params": {}}`.
  - Receives base64-encoded PNG `png_b64`.
  - Decodes bytes and writes artifact to `runs/<session_id>/screenshot-<state_version>.png`.
- **Process and Window Lists:**
  - Extracts active window titles and PIDs from the root UIA tree.
- **State Version:** Advances monotonic `StateVersion`.

### 3.3 `act(&mut self, action: &Action) -> Result<ActionOutcome, Self::Err>`
Every action adheres to the mandatory read-back verification discipline (ADR-0003, ADR-0014):

- **`Action::Launch { command, args }`:**
  - Sends `{"id": n, "token": token, "op": "launch", "params": {"argv": [command, ...args], "cwd": null}}`.
  - Guest agent uses `C:\myco\bin\run-interactive.ps1` via Scheduled Task to guarantee launch in `WinSta0`.
  - Verifies process alive via returned PID -> `DeliveredVerified`.
- **`Action::Click { target }`:**
  - Validates `target.issued_at == current_state_version`; otherwise returns `RuntimeError::StaleRef`.
  - Sends `uia_invoke` with `action: "invoke"` or `action: "select"` using the target's UIA `runtime_id` (or descriptor for MSAA proxies).
  - Re-reads target state to confirm invocation -> `DeliveredVerified`, or `DeliveredUnverified` if effect is external.
- **`Action::TypeText { target, text }`:**
  - Sends `uia_invoke` with `action: "set_value", "value": text` (ValuePattern) or synthetic key sequence.
  - Re-reads target UIA `Value` property to confirm typed string -> `DeliveredVerified`.
- **`Action::KeyPress { keys }`:**
  - Injects virtual key sequence.

### 3.4 `evidence(&mut self) -> Result<EvidenceArtifacts, Self::Err>`
- Emits session trace events into `runs/<session_id>/trace.jsonl`.
- Emits `runs/<session_id>/result.json` with `recordKind: "session"` (verdict omitted, fully adhering to ADR-0012).
- Validates artifacts against `schemas/result.json` before returning paths.

### 3.5 `reset(&mut self) -> Result<(), Self::Err>`
- **Live Snapshot Restore:**
  - Closes the active TCP client stream.
  - Invokes `scripts/reset.sh live` (or `clean-base-live` snapshot restore via osascript).
  - Measured reset duration: **8.3–8.6 seconds** (Windows live-snapshot restores RAM + disk state, maintaining logged-in desktop).
- **Channel Recovery:**
  - Waits for guest resume.
  - Re-establishes TCP connection to `127.0.0.1:8765`.
  - Executes auth handshake (`ping`) and resets session state.

### 3.6 `destroy(&mut self) -> Result<(), Self::Err>`
- Sends `kill` op to terminate any launched applications.
- Closes guest agent connection.
- Releases `/tmp/myco-win11.vm.lock`.
- If configured for dedicated session lifecycle, stops VM via `scripts/vm.sh stop`.

---

## 4. Comparison: QEMU Linux vs. UTM Windows Backends

| Dimension | `QemuLinuxBackend` (v0 / RT-020) | `UtmWindowsBackend` (RT-012 Anticipation) |
|---|---|---|
| **Guest OS** | Ubuntu Server 24.04 ARM64 | Windows 11 ARM64 |
| **Hypervisor** | Raw QEMU + HVF CLI (`qemu-system-aarch64`) | UTM 5.0.9 (QEMU/Apple Hypervisor via AppleScript) |
| **Control Channel** | Persistent SSH spawning `myco-rt-agent` | Loopback TCP (port 8765) to `myco-agent` service |
| **Guest Agent** | Native Rust static musl (`myco-rt-agent`) | Python 3.12 (`myco_agent/server.py`) |
| **Accessibility API** | AT-SPI2 D-Bus (`xa11y` crate) | Windows UI Automation (`IUIAutomation2`) |
| **Input Synthesis** | XTest / Xdotool | UIA Patterns (`Invoke`, `Value`) + Win32 input |
| **Reset Primitive** | Discard qcow2 overlay + reboot | UTM `clean-base-live` snapshot restore |
| **Measured Reset Time** | ~52.0 s (reboot + desktop recovery) | **8.3–8.6 s** (RAM + disk live snapshot) |
| **RAM Footprint** | 2048 MB hard cap | 8192 MB assigned to `myco-win11` |
| **Concurrency** | Multiple disposable overlays possible | Strictly 1 (single UTM VM instance) |

---

## 5. Architectural Invariants & Safety Guardrails

1. **Strict Seam Boundary (ADR-0012):** `UtmWindowsBackend` remains strictly within the lifecycle and session domain. It does not compute verdicts, execute TypeScript guarded programs, or evaluate UNO spreadsheets.
2. **Locking Discipline:** Must acquire `/tmp/myco-win11.vm.lock` via `scripts/vm-lock.sh` prior to touching the guest channel.
3. **Bounded Timeouts:** All socket calls enforce connect and read deadlines. Stalled UIA transactions are intercepted by `IUIAutomation2` transaction timeouts (`MYCO_UIA_CONNECT_TIMEOUT_MS`) rather than freezing the host runtime.
4. **No Code Touching UTM:** This document completes the design anticipation requirement without executing or altering the Windows VM environment.
