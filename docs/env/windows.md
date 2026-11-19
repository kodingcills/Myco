# Windows environment control plane (Milestone 1)

Research area: how the outer loop provisions, drives, resets, and collects evidence from a
Windows 11 ARM64 guest running LibreOffice Calc, hosted in UTM on an Apple M4 Pro Mac.

Scope note: this document is research and design only. It installs nothing. The outer loop owns
provisioning; this file tells it what to build and how to verify each step.

Status: researched 2026-11-18 against UTM 5.0.9 (installed locally), LibreOffice 26.8.3,
Windows 11 ARM64, Python 3.12 ARM64.

---

## Decided

Recorded as given by the outer loop. Not re-litigated here.

| Item | Value |
|---|---|
| Hypervisor | UTM on Apple Silicon (macOS 27.0.0, M4 Pro) |
| Guest | Windows 11 ARM64 |
| Host→guest transport | SSH, user `myco`, key auth, key at `~/VMs/myco-win11/id_ed25519`, localhost port forward |
| Guest session | Auto-logon interactive desktop |
| Runtime | Python 3.12 ARM64 |
| App under test | LibreOffice Calc |
| Reset primitive | UTM `clean-base` snapshot |

Two of these carry hidden constraints that the outer loop must honour, both documented below:

1. **`utmctl` does not work from an SSH session on the Mac.** The outer loop must run it from a
   GUI (Aqua) session, or pre-authorise Automation/Full Disk Access. See
   [UTM control from the host](#utm-control-from-the-host).
2. **A wizard-default Windows 11 ARM64 VM cannot take live snapshots.** Disks-only snapshots of a
   shut-down VM work. See [Snapshot/reset strategy](#snapshotreset-strategy).

---

## VM docs pointer

`~/VMs/myco-win11/README.md` is written by the outer loop when the VM is ready. It is the
authoritative record of: VM UUID, guest IP, forwarded ports, the `clean-base` snapshot name and
creation date, the agent port and token path, and the exact commands used to build the image.

This document does not duplicate it. Where the two disagree, the README wins for facts about the
built VM; this document wins for design rationale.

---

## Live environment (provisioned 2026-11-19, supersedes research-phase choices where they differ)

The VM is live and smoke-tested. Authoritative facts: `~/VMs/myco-win11/README.md` (never copy
credentials out of that directory; `credentials.txt` and `seed.iso` are off-limits).

What the provisioning settled, vs this document's earlier recommendations:

| Topic | Research-phase recommendation | As built |
|---|---|---|
| VM control | `utmctl` (blocked by TCC from SSH) | `scripts/vm.sh` wraps UTM **AppleScript via osascript** — do not attempt to bypass the utmctl block |
| Reset | snapshot-restore; disposable gated by P7 | `scripts/reset.sh live` restores `clean-base-live` (RAM+disk, desktop logged in). Measured by the coordinator 2026-11-19: **8.3–8.6 s across 3 consecutive resets**, guest clean after each (no leftover soffice, no fixture files). `cold` ~20 s; `disposable` ~20 s. Live snapshots work because the system disk was converted NVMe→VirtIO (`scripts/convert-disk-virtio.sh`) |
| GUI launcher | logon-started agent + InteractiveToken scheduled task | `C:\myco\bin\run-interactive.ps1 -Exe <exe> -ArgList "<args>" -Wait` runs any program in the logged-in session via a scheduled task. This is the bootstrap path for `myco-agent` too |
| Screenshots | in-guest only | confirmed: UTM host capture returns a placeholder for the ramfb display; all screenshots (incl. the TIF-19 baseline) are taken in-guest |
| SSH | key auth as `myco` via localhost forward | `ssh -F ~/VMs/myco-win11/ssh_config myco-win11` (127.0.0.1:2222); shortcut `scripts/vssh` |
| Guest toolchain | Python 3.12 ARM64, LibreOffice ARM64, pywinauto, uiautomation | confirmed: Python 3.12.10 ARM64, **LibreOffice 26.8.3 native ARM64** (PE machine 0xAA64), pywin32 312, comtypes 1.5.0, pywinauto 0.6.9, uiautomation 2.0.29 |

Smoke test (6/6 passing): `vssh 'C:\myco\bin\smoke.ps1'` — creates an .ods headlessly, drives Calc
via UIA in the interactive session (writes A1, saves), and reads A1 back with an independent
headless `soffice --convert-to csv` under a separate profile. This is the M1 verification shape
running end-to-end already.

**Guest findings that constrain M1 design** (from the outer loop's provisioning, verified by its
smoke test):

1. **LibreOffice's UIA tree is lazy.** Until a client makes one MSAA call
   (`AccessibleObjectFromWindow(hwnd, OBJID_CLIENT)`), UIA shows only the title bar. The adapter
   must wake the bridge first (`smoke_calc_uia.py` shows how). Resolves Open risk 2 downward:
   UIA sees menus, toolbars, Name Box, and the sheet table after the wake — cell *values* still
   come from UNO/file checks.
2. **Foreground is contested.** Scheduled-task windows don't get foreground; the Windows Search
   flyout can hold it. `bring_to_front()` (Esc on shell flyouts, Alt tap, AttachThreadInput +
   SetForegroundWindow, then verify) is mandatory before keystrokes.
3. **AutoCorrect mutates typed values** ("myco-smoke-1" → "Myco-smoke-1"); a case-insensitive
   check accepted it — a real false success. Verifiers compare exactly. Defaults stay on so the
   app behaves realistically; this is a ready-made corrupted-trial fixture.
4. **Reproducibility from zero is unproven**: `build-all.sh` has never run end-to-end. Tracked
   under M1-016.

Guest hygiene: the VM costs 8 GB of the Mac's 24 GB; shut it down when idle
(`scripts/shutdown.sh`).

## Control plane design

### The session-0 problem

Windows isolates services into session 0, which has no visible window station. Microsoft states
this directly: *"Services cannot directly interact with a user as of Windows Vista"* and *"All
services run in Terminal Services session 0"*
([interactive-services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)).

`sshd` on Windows is a service, so every process it spawns inherits session 0. The OpenSSH
maintainer states it plainly: *"SSH sever process run in session 0. The processes in session 0
can't launch GUI applications."*
([Win32-OpenSSH#1879](https://github.com/PowerShell/Win32-OpenSSH/issues/1879)), and *"You can't
run GUI applications over SSH. This is expected behavior."*
([Win32-OpenSSH#1610](https://github.com/PowerShell/Win32-OpenSSH/issues/1610)).

Consequence for Myco: **SSH is a transport, never an execution surface for GUI work.** A
`python drive_calc.py` launched over SSH will start, will not appear on the auto-logon desktop,
and UIA calls from it will fail or return an empty tree. This is the single most likely way to
lose a day on this milestone.

### Recommended launcher: a logon-started agent, bootstrapped by an interactive-token scheduled task

Two mechanisms, layered. The agent is the steady state; the scheduled task is how we get into the
interactive session and how we recover the agent if it dies.

**Layer 1 — `myco-agent`, a persistent Python process inside the interactive session.**

- Started at logon, so it inherits the auto-logon desktop's window station and can drive UIA,
  capture the screen, and launch LibreOffice visibly.
- Listens on `127.0.0.1:8765` inside the guest. Reached from macOS either through a UTM port
  forward or an `ssh -L` tunnel (both terminate on the same loopback).
- Speaks newline-delimited JSON: one request object per line, one response object per line.
  Deliberately boring — no framework, no async runtime, no dependency beyond the stdlib plus
  `uiautomation`/`pywinauto` for the UIA ops.
- Requires a shared token on every request, read from a file ACL'd to `myco` only. The port is
  loopback-bound, but the token is what stops a stray local process from driving the desktop.

Minimum op surface for M1:

| Op | Purpose |
|---|---|
| `ping` | Liveness + agent version + session id |
| `session_info` | `ProcessIdToSessionId`, window station name, desktop name, logged-on user |
| `launch` | Start a process on the interactive desktop, return pid |
| `uia_tree` | Dump the UIA subtree for a window/control, depth-limited |
| `uia_invoke` | Invoke/select/set-value on a control by runtime id |
| `screenshot` | PNG of the interactive desktop or a window rect |
| `read_file` / `write_file` | Fixture and artifact transfer, base64 payloads |
| `kill` | Terminate a pid or image name |
| `uno_eval` | Optional: evaluate against a UNO socket (see [ARM64 matrix](#arm64-compatibility-matrix)) |

**Layer 2 — a scheduled task with `InteractiveToken` logon type.**

This is the documented way for a session-0 caller to start work in the interactive session.
Microsoft's Task Scheduler schema defines `InteractiveToken` as: *"User must already be logged on.
The task will be run only in an existing interactive session."*
([LogonType element](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element)).
The `schtasks` CLI equivalent is `/it`: *"run the scheduled task only when the run as user is
logged on"*
([schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)).

Register the task from XML rather than with `/ru` + `/rp`, so no password is stored:

```xml
<Principal id="Author">
  <UserId>MYCO-WIN11\myco</UserId>
  <LogonType>InteractiveToken</LogonType>
  <RunLevel>LeastPrivilege</RunLevel>
</Principal>
```

Then, from SSH (session 0), `schtasks /run /tn "MycoAgent"` starts the agent in `myco`'s
interactive session. This is the recovery path and the first-boot path.

**Why this over the alternatives.**

- *`schtasks /run` per action, no agent.* Works, but each call costs a task start, gives no
  streaming, no persistent UIA cache, and concurrent calls collide on "task already running".
  Fine as a bootstrap, poor as a request path.
- *PsExec `-i <session>`.* Confirmed to work by a user in
  [Win32-OpenSSH#1610](https://github.com/PowerShell/Win32-OpenSSH/issues/1610) (`PsExec.exe -i 1`),
  but it needs a Sysinternals binary in the guest, credentials on the command line, and the
  session id discovered per boot. More moving parts than the agent, no benefit.
- *`CreateProcessAsUser` from a service.* This is Microsoft's own recommended pattern for
  service→interactive handoff — *"Create a separate hidden GUI application and use the
  CreateProcessAsUser function to run the application within the context of the interactive
  user"* ([interactive-services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)) —
  but it requires writing and signing a service, `WTSQueryUserToken`, and `SeTcbPrivilege`. The
  scheduled task achieves the same handoff with a 20-line XML file.
- *`utmctl exec`.* UTM's guest agent can run a command in the guest
  (`utmctl help exec`), but the guest agent is a service, so it lands in session 0 for the same
  reason SSH does. Useful for out-of-band file transfer and non-GUI commands, not for GUI work.

### UTM control from the host

`utmctl` is the VM lifecycle API: `list`, `status`, `start`, `stop`, `suspend`, `clone`,
`delete`, `discard-state`, `snapshot`, `exec`, `file`, `ip-address`
(`utmctl --help`, UTM 5.0.9).

**It refuses to run from an SSH session.** Reproduced locally on this machine:

```
$ utmctl list
Error from event: The operation couldn’t be completed. (OSStatus error -1743.)
NOTE: utmctl does not work from SSH sessions or before logging in.
```

This is a known, still-open limitation. The UTM maintainer: *"This is unfortunately a limitation
of how apple scripting bridge works. You must have the GUI launched or launchable in an
interactive instance. I don't think it works with SSH."*
([utmapp/UTM#5377](https://github.com/utmapp/UTM/issues/5377)). `-1743` is
`errAEEventNotPermitted` — an Apple Events TCC denial, not a UTM bug.

Two documented workarounds, both from that issue's thread:

1. Grant Full Disk Access to the `utmctl` binary in System Settings → Privacy & Security, then
   relaunch the terminal so the new TCC grant is picked up.
2. From SSH, run `osascript` once against UTM to trigger the Automation prompt, then accept it on
   the Mac's own screen.

**Design consequence:** the outer loop must run on the Mac's GUI session. If it is ever driven
over SSH, `utmctl` calls fail and the reset path silently breaks. Provisioning must either
pre-authorise TCC (step P0 below) or assert that the loop runs locally.

Second known hazard: `utmctl` launches UTM hidden (`utmctl/UTMCtl.swift:60`), and a hidden launch
followed by `utmctl start` hangs on 5.0.8 because starting a VM with a display calls `makeMain()`
on its window while UTM is hidden. Fixed on `main` by #8122, not yet in a release
([utmapp/UTM#8006](https://github.com/utmapp/UTM/issues/8006)). Mitigation: ensure UTM is already
running and visible before the first `utmctl start`, and never use `open -j -a UTM`.

Also note UTM must stay open for the VM to run — *"UTM needs to be open while the headless virtual
machine is running"*
([headless docs](https://docs.getutm.app/advanced/headless/)). We are not using headless mode
anyway: M1 needs a real desktop, so the VM keeps its display device.

### Evidence capture

Screenshots must be taken **inside the interactive session** — session 0 has no visible window
station, so a capture attempted from SSH returns black or fails. The agent does the capture
(`screenshot` op) and returns PNG bytes; the host writes them to the run's evidence directory.

Log and trace collection has two independent paths, which is deliberate — if the agent is wedged,
the run is still recoverable:

- **Primary:** the agent's `read_file` op, for anything it can reach.
- **Fallback:** `scp` over the existing SSH connection, for files the agent cannot serve (agent
  crash logs, Windows event logs, LibreOffice crash dumps).
- **Out-of-band:** `utmctl file pull` via the UTM guest agent, which does not depend on SSH or on
  the agent at all (`utmctl help file`). Worth wiring as the last resort for a wedged guest.

---

## Snapshot/reset strategy

### What UTM 5.0.9 actually supports

Snapshots shipped in UTM 5.0.9: *"Snapshots: Save your VM at any point and go back to it later
from the new Snapshots tab. Works with QEMU VMs on macOS and iOS 26, and with Apple Virtualization
VMs on macOS 27."*
([v5.0.9 release notes](https://github.com/utmapp/UTM/releases/tag/v5.0.9)). Our VM is QEMU
backend, so snapshots are supported — the historical "ARM64 snapshots are limited" concern is
resolved for the QEMU path.

Semantics, from the implementation PR
([utmapp/UTM#7896](https://github.com/utmapp/UTM/pull/7896)):

- **Running VM** → snapshot through the QEMU monitor (QMP jobs), all drives and RAM together.
  Restoring resumes the guest.
- **Stopped VM** → snapshot through `qemu-img`, disks only. Restoring boots the guest.
- Metadata lives in `snapshots.plist` in the bundle. Snapshots made by other tools (e.g. raw
  `qemu-img`) are adopted on `scan`.

The docs confirm the restore constraint: *"Snapshots marked 'Disks Only' do not include the
running state so the virtual machine will start up normally. These can only be restored when the
virtual machine is not running."*
([snapshots docs](https://docs.getutm.app/advanced/snapshots/)).

### The trap: live snapshots fail on a wizard-default Windows 11 VM

A Windows 11 ARM64 VM created by the UTM wizard uses an NVMe disk and `virtio-ramfb-gl`. That
combination **cannot take live snapshots**. Reported and confirmed by the maintainer:

> *"When a new virtualized Windows 11 ARM VM is created with the UTM wizard, then snapshots are
> not supported due to the chosen hardware configuration by the wizard."*
> — reporter; maintainer reply: *"You're referring to live snapshots. If Windows is shut down you
> can snapshot regardless."*
> ([utmapp/UTM#7989](https://github.com/utmapp/UTM/issues/7989))

The reporter's working configuration was: replace the NVMe disk with a VirtIO drive, and change
`virtio-ramfb-gl` to `virtio-ramfb`. Both changes have real costs — VirtIO disk needs `viostor`
loaded during Windows Setup, and dropping `-gl` loses the accelerated display path that UTM's
DirectX driver requires
([Windows guest support](https://docs.getutm.app/guest-support/windows/)).

**Decision: do not chase live snapshots.** M1 resets between trials, not mid-trial. A disks-only
snapshot of a shut-down VM is sufficient, works with the wizard's NVMe disk, and needs no driver
surgery.

### Recommended reset path

```
utmctl stop "myco-win11" --request      # graceful ACPI power-down
# poll: utmctl status "myco-win11" until "stopped"
utmctl snapshot restore "myco-win11" --snapshot clean-base
utmctl start "myco-win11"
# wait for the agent: poll the agent's ping op until it answers
```

Notes that matter for implementation:

- `utmctl stop` defaults to `--force` (power off event); `--request` asks the guest to power down
  (verified against `utmctl help stop`, UTM 5.0.9). Use `--request` first, fall back to `--force` after a timeout,
  and `--kill` only as a last resort — a hard kill risks a dirty NTFS volume that the next boot
  has to repair, which pollutes timing measurements.
- Restore **must** happen while stopped. Restoring a disks-only snapshot on a running VM is
  rejected by design.
- `utmctl snapshot list <vm> --json` gives a machine-readable list, so the reset script can assert
  `clean-base` exists and is not marked as missing data before it destroys anything
  (verified against `utmctl help snapshot list`, UTM 5.0.9).
- Cost: one full Windows boot per reset. Acceptable for 30 trials; measure it in step P6 and
  record the number in the VM README.

### Fallback A — disposable mode (test this first; it may be strictly better)

`utmctl start --disposable` runs the VM *"as a snapshot and do not save changes to disk"*
(verified against `utmctl help start`, UTM 5.0.9). The docs: *"Anything written to storage will be lost when the
virtual machine is shut down"*, supported on the QEMU backend
([disposable docs](https://docs.getutm.app/advanced/disposable/)).

If this works with our NVMe + `virtio-ramfb-gl` configuration, it is a better primitive than
snapshot-restore: no restore step, no risk of restoring the wrong snapshot, and the clean state is
guaranteed by construction rather than by discipline. It is a QEMU-level overlay, so it should be
hardware-independent — but that is [INFERENCE], not verified.

Two caveats: snapshots cannot be taken while in disposable mode (irrelevant for us), and the
discard happens on clean shutdown, so a `--kill` needs verifying.

**Provisioning step P7 gates on this.** If disposable mode works, adopt it as the primary reset
and keep snapshot-restore as the fallback. If it does not, keep snapshot-restore as primary.

### Fallback B — qcow2 backing-file overlay

If UTM's snapshot machinery misbehaves, bypass it. UTM QEMU VMs store the disk as
`Data/<UUID>.qcow2` inside the `.utm` bundle, referenced by `Drive[].ImageName` in `config.plist`
(verified locally on an existing UTM VM). `qemu-img` is available both bundled
(`/Applications/UTM.app/Contents/Frameworks/qemu-img.framework/qemu-img`) and via Homebrew.

```
# with the VM stopped
qemu-img create -f qcow2 -F qcow2 -b clean-base.qcow2 Data/<UUID>.qcow2
```

Reset then means: stop VM, delete the overlay, recreate it from the same backing file, start.
This is fast and fully under our control, but it edits UTM's bundle behind UTM's back, so UTM must
be stopped and `config.plist` must keep pointing at the same filename. Treat as a break-glass
path, not the default.

### Fallback C — in-guest state reset

Cheapest and least complete: kill LibreOffice, restore fixture files from a pristine copy, delete
the LibreOffice user profile (`%APPDATA%\LibreOffice\4\user`), clear temp. Does not reset OS state
(installed updates, registry drift, accumulated logs). Useful as a *between-trial* hygiene step on
top of a snapshot reset, not as a replacement for it.

### Parallelism (not M1, but note it)

`utmctl clone <vm> --name <new>` exists and is the fork primitive for later milestones. M1 runs
serially; do not build forking now.

---

## ARM64 compatibility matrix

| Component | ARM64 status | Evidence |
|---|---|---|
| Windows 11 ARM64 guest in UTM (QEMU backend) | Supported. QEMU aarch64 with Hypervisor.framework acceleration. | [UTM docs](https://docs.getutm.app/), [v5.0.9 notes](https://github.com/utmapp/UTM/releases/tag/v5.0.9) |
| UTM snapshots (QEMU backend) | Supported since 5.0.9. Disks-only for stopped VMs; live snapshots blocked by NVMe + `virtio-ramfb-gl`. | [v5.0.9 notes](https://github.com/utmapp/UTM/releases/tag/v5.0.9), [snapshots docs](https://docs.getutm.app/advanced/snapshots/), [UTM#7989](https://github.com/utmapp/UTM/issues/7989) |
| `utmctl` from SSH | **Not supported.** `OSStatus -1743` (`errAEEventNotPermitted`). Needs GUI session or TCC grant. | [UTM#5377](https://github.com/utmapp/UTM/issues/5377); reproduced locally |
| `utmctl` cold start on macOS 27 | Hidden-launch hang on 5.0.8; fixed on `main` (#8122), not in a release. | [UTM#8006](https://github.com/utmapp/UTM/issues/8006) |
| UTM port forwarding | QEMU backend only, **Emulated VLAN** network mode only. | [port forwarding docs](https://docs.getutm.app/settings-qemu/devices/network/port-forwarding/) |
| UTM Windows guest tools | arm64 builds supported. | [Windows guest support](https://docs.getutm.app/guest-support/windows/) |
| OpenSSH Server on Windows 11 | In-box Feature on Demand; `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`. | [install docs](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse) |
| OpenSSH key auth for an admin user | Key goes in `C:\ProgramData\ssh\administrators_authorized_keys`, ACL restricted to Administrators + SYSTEM. | [key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) |
| SSH session → GUI | **Impossible.** Session 0 has no visible window station. | [interactive-services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services), [Win32-OpenSSH#1879](https://github.com/PowerShell/Win32-OpenSSH/issues/1879) |
| Launch into interactive session from session 0 | Supported via Task Scheduler `InteractiveToken` / `schtasks /it`. | [LogonType](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element), [schtasks](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create) |
| Auto-logon | Supported; Sysinternals Autologon configures the built-in mechanism, password stored as an LSA secret. | [Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon) |
| Python 3.12 ARM64 | Official Windows ARM64 installer and embeddable package. | [python.org downloads](https://www.python.org/downloads/windows/) |
| `pywin32` on ARM64 | `cp312-win_arm64` wheels published (v312). | [PyPI](https://pypi.org/pypi/pywin32/json) |
| `pywinauto` on ARM64 | Pure Python (`py2.py3-none-any`), v0.6.9, uploaded 2025-01-06. No native build needed. | [PyPI](https://pypi.org/pypi/pywinauto/json) |
| `uiautomation` on ARM64 | Pure Python (`py3-none-any`), v2.0.29, depends on `comtypes>=1.2.1`. | [PyPI](https://pypi.org/pypi/uiautomation/json) |
| `comtypes` on ARM64 | Pure Python (`py3-none-any`), v1.5.0. | [PyPI](https://pypi.org/pypi/comtypes/json) |
| `Pillow` on ARM64 | `cp312-win_arm64` wheels published (v13.0.0). | [PyPI](https://pypi.org/pypi/pillow/json) |
| UIAutomationCore on Windows 11 ARM64 | Core OS component; UIA is the current Windows accessibility model. | [UIA/MSAA](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-msaa) |
| **LibreOffice native UIA** | **Not implemented.** LibreOffice instruments IAccessible2; UIA clients see it only through Windows' MSAA→UIA proxy. | [tdf#160982](https://bugs.documentfoundation.org/show_bug.cgi?id=160982) |
| LibreOffice Windows ARM64 installer | **Official.** `LibreOffice_26.8.3_Win_aarch64.msi` (345 MB) on the stable mirror. | [download mirror](https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/aarch64/), [download page](https://www.libreoffice.org/download/download-libreoffice/) |
| LibreOffice bundled Python | 3.11 in 25.8. Separate from the system 3.12. | [25.8 release notes](https://wiki.documentfoundation.org/ReleaseNotes/25.8) |
| x64 emulation (Prism) | User-mode only; *"emulation only supports user mode code and doesn't support drivers."* | [apps-on-arm](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation) |

### The LibreOffice UIA finding — read this before designing the adapter

LibreOffice does **not** implement UI Automation. From the LibreOffice bug tracker, on the
Narrator bug:

> *"LibreOffice provides no assistive technology support for Microsoft's UI Automation framework.
> And MS has chosen to not support IAccessible2 in Narrator, just spotty support for legacy MSAA.
> LibreOffice fully instruments IAccessible2 API calls on Windows."*

and, on the workaround that made Narrator usable:

> *"It turns out that Windows provides a MSAA to UIA proxy that makes (at least some) information
> available to UIA without LO having to implement native UIA support. This however wasn't working
> 'out of the box' because Narrator ... doesn't report the SPI_GETSCREENREADER parameter. When
> explicitly enabling the accessible bridge by setting an environment variable
> `SAL_FORCE_IACCESSIBLE2=1` before starting LO, Narrator works in general, e.g. announces menus,
> toolbar buttons etc."*
> ([tdf#160982](https://bugs.documentfoundation.org/show_bug.cgi?id=160982))

Since 25.2 the bridge auto-enables when a tool queries accessibility: *"On Windows, accessibility
now gets enabled whenever a tool queries information from LibreOffice on the accessibility level,
which implies basic support for Microsoft Narrator and Microsoft Accessibility Insights."*
([25.2 release notes](https://wiki.documentfoundation.org/ReleaseNotes/25.2)).

Microsoft documents the same bridge from the other side: MSAA servers can serve UIA clients, but
*"because Microsoft Active Accessibility does not expose as much information as UI Automation, the
two models are not fully compatible"*, and the client-side surface is
`IUIAutomationLegacyIAccessiblePattern`
([UIA and MSAA](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-msaa)).

**What this means for M1.** UIA against LibreOffice Calc will give a usable tree for windows,
menus, toolbars, dialogs, and buttons — enough to launch, focus, and drive menus. It will **not**
reliably give typed cell-level grid state, because that data lives in IAccessible2 and reaches UIA
only through a lossy proxy. The vision already anticipates this: it lists UNO alongside UIA as a
state source.

Recommended split, to be confirmed by a spike in step P8:

- **UIA** for window/dialog/menu control and for "is the app in the expected state" checks.
- **UNO** for Calc cell values, formulas, sheet structure, and the persisted-state verification
  that M1's acceptance criteria depend on.

Caveat on UNO: LibreOffice ships its own Python (3.11 in 25.8), and the `uno` module is a compiled
extension built against that interpreter. Driving UNO from the system Python 3.12 will not work
without a matching build — [INFERENCE] from the bundled-interpreter fact, to be confirmed in P8.
The safe design is a small UNO bridge process running under LibreOffice's own Python, exposing a
socket the 3.12 agent talks to. That also keeps the agent's dependency surface clean.

---

## Provisioning script plan

Ordered, each step independently verifiable. The outer loop executes these; this document only
specifies them.

**P0 — Pre-authorise `utmctl` on the Mac.**
Grant Full Disk Access to `/Applications/UTM.app/Contents/MacOS/utmctl` and relaunch the terminal,
or run `osascript` against UTM once and accept the Automation prompt on screen.
*Verify:* `utmctl list` returns a table with no `OSStatus` error, from the same shell the outer
loop will use. If the loop runs over SSH, this step cannot pass — move the loop to the GUI session.

**P1 — Create the VM.**
UTM wizard, Windows 11 ARM64, QEMU backend, Virtualize. Keep the wizard's NVMe disk and
`virtio-ramfb-gl` display (see [the trap](#the-trap-live-snapshots-fail-on-a-wizard-default-windows-11-vm)).
Set network mode to **Emulated VLAN** — port forwarding is unavailable in any other mode
([docs](https://docs.getutm.app/settings-qemu/devices/network/port-forwarding/)).
*Verify:* `utmctl list` shows the VM; `utmctl status <vm>` returns `stopped`.

**P2 — Install Windows, then guest tools.**
Install Windows 11 ARM64, then the UTM Windows guest tools (arm64 supported,
[docs](https://docs.getutm.app/guest-support/windows/)).
*Verify:* Device Manager shows no unknown devices; `utmctl ip-address <vm>` returns an address.

**P3 — Create user `myco`, enable auto-logon.**
Local admin account `myco`. Configure auto-logon (Sysinternals Autologon or the equivalent
`Winlogon` registry values; password is stored as an LSA secret —
[docs](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)).
*Verify:* reboot the VM; without any input, `query session` from an elevated shell shows `myco`
with an active console session, and the desktop is visible in the UTM window.

**P4 — Enable OpenSSH Server and key auth.**
`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`; `Start-Service sshd`;
`Set-Service -Name sshd -StartupType Automatic`; confirm the `OpenSSH-Server-In-TCP` firewall rule
([docs](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)).
Because `myco` is an admin, the public key goes in `C:\ProgramData\ssh\administrators_authorized_keys`
with ACL restricted to Administrators and SYSTEM
([docs](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)).
Add the UTM port forward host:22 → guest:22.
*Verify:* from macOS, `ssh -i ~/VMs/myco-win11/id_ed25519 -p <hostport> myco@127.0.0.1 'whoami'`
returns `myco-win11\myco` with no password prompt.

**P5 — Install Python 3.12 ARM64 and the UIA stack.**
Official ARM64 installer from python.org. Then `pip install pywinauto uiautomation comtypes pywin32 pillow`
— all have ARM64-compatible distributions (see matrix).
*Verify:* `python -c "import platform,sys;print(platform.machine(), sys.version)"` prints `ARM64`
and `3.12.x`; `python -c "import uiautomation, pywinauto; print('ok')"` prints `ok`.

**P6 — Install LibreOffice ARM64.**
`LibreOffice_26.8.3_Win_aarch64.msi` from the stable mirror. Do not use the x86-64 build; the
native ARM64 build exists and avoids emulation entirely.
*Verify:* `soffice --version` reports the ARM64 build; Task Manager shows `soffice.bin` as ARM64,
not "x64 emulated".

**P7 — Decide the reset primitive.**
Create the `clean-base` snapshot with the VM shut down: `utmctl snapshot create <vm> --name clean-base`.
Then test `utmctl start <vm> --disposable`, write a marker file in the guest, shut down, restart
normally, and check the marker is gone.
*Verify:* `utmctl snapshot list <vm> --json` contains `clean-base` with no missing-data flag; and
the disposable test either passes (adopt disposable as primary) or fails cleanly (keep
snapshot-restore as primary). Record the decision in the VM README.

**P8 — Spike the state source.**
With LibreOffice Calc open on the interactive desktop, dump the UIA tree for the Calc window from
the agent, and separately connect to a UNO socket and read a cell range. Compare what each can
tell you about a known fixture file.
*Verify:* a written note recording, for each of {cell value, cell formula, sheet name, selected
range, window title, menu item}, whether UIA, UNO, or both can read it. This note decides the
adapter design and is the single most important artifact of provisioning.

**P9 — Install and register the agent.**
`myco-agent` under `C:\myco\`, token file ACL'd to `myco`, scheduled task `MycoAgent` with
`LogonType=InteractiveToken` and an at-logon trigger, plus a Startup-folder shortcut as a
belt-and-braces second path.
*Verify:* from SSH, `schtasks /run /tn MycoAgent` then a `ping` to the agent port returns a
response whose `session_info` reports a **non-zero session id** and the `WinSta0\Default` window
station. A session id of 0 means the agent landed in session 0 and the whole design is broken —
fail loudly here.

**P10 — Prove the loop end to end.**
From macOS: reset to `clean-base`, start, wait for agent, launch Calc with a fixture, read a cell
via the chosen state source, screenshot, collect the trace, reset again.
*Verify:* two consecutive runs produce identical starting state (same fixture hash, same window
title, same cell values) and both emit a complete evidence bundle.

---

## Open risks

1. **`utmctl` TCC breakage is silent and environment-dependent.** If the outer loop ever moves to
   an SSH-driven context, `utmctl` fails with `-1743` and the reset path stops working. Mitigation:
   P0 asserts it, and the reset script should fail loudly rather than proceed on a failed restore.

2. **LibreOffice's UIA tree may be too thin for M1's verification requirement.** The MSAA→UIA
   proxy is explicitly lossy. If P8 shows UIA cannot read cell values, the adapter must lean on
   UNO, which adds a second bridge process and a second failure mode. This is the highest-impact
   unknown in this document.

3. **UNO from Python 3.12 is unproven.** LibreOffice bundles Python 3.11; the `uno` extension is
   built against it. The bridge-process design sidesteps this but is unverified. If it fails, the
   fallback is to run the whole agent under LibreOffice's bundled Python, which then constrains
   every other dependency choice.

4. ~~**Reset cost is one full Windows boot.**~~ Resolved by the live environment: `reset.sh live`
   restores a RAM+disk snapshot in ~7 s (measured 2026-11-18), desktop already logged in.

5. ~~**`utmctl` cold-start hang / TCC.**~~ Moot: the control plane is osascript AppleScript, not
   utmctl.

6. **Auto-logon stores the password as a recoverable LSA secret.** Documented by Microsoft
   ([Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)). Acceptable
   for a local test VM; must not be carried into any shared or networked deployment.

7. **Key-based SSH sessions carry no user credentials** — *"A remote session opened via key-based
   authentication doesn't have associated user credentials. As a result, the session isn't capable
   of outbound authentication as the user."*
   ([docs](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)).
   Any step that needs network or domain auth must run in the interactive session, not over SSH.

8. **Port forwarding requires Emulated VLAN.** If the VM is later switched to Shared Network for
   performance or host visibility, the SSH forward silently disappears. Pin the network mode in
   the VM README.

9. **Snapshot restore is destructive and unconfirmed by default.** `utmctl snapshot restore`
   replaces current state with no confirmation prompt. The reset script must verify the snapshot
   name and the VM's stopped status before calling it, and must never run it against a VM whose
   state someone might still need.
