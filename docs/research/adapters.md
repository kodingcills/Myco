# Structural adapters for desktop apps on Windows

Research for Myco Milestone 1. Scope: how to read and drive a real Windows GUI app
structurally (UIA, COM, UNO) rather than from pixels, and which existing project to
build the first adapter on.

Method: every claim below was checked against the cloned repository, the published
package index, the vendor download server, or the vendor documentation. Where a claim
could not be verified it is marked `[UNVERIFIED]`. Repo state was read on 2026-11-18.

Repos cloned and read at these commits:

| Project | Commit | Date |
|---|---|---|
| microsoft/UFO | `HEAD` of `main` (shallow) | pushed 2026-10-30 |
| vercel-labs/agent-desktop | `HEAD` of `main` (shallow), v1.3.1 | pushed 2026-11-18 |
| pywinauto/pywinauto | `46b1b0ae8b6cc1a5cb066ada7f88e44677231a47` | 2026-11-01 |
| yinkaisheng/Python-UIAutomation-for-Windows | `05cab1972d6e08216eae5c5183f9b3d47e26266d` | 2026-06-02 |
| trycua/cua | `HEAD` of `main` (shallow) | pushed 2026-11-19 |

---

## 1. Microsoft UFO and UFO2

- Repo: <https://github.com/microsoft/UFO>
- License: MIT (`LICENSE`, "Copyright (c) Microsoft Corporation. MIT License")
- 10,225 stars, 97 open issues, last push 2026-10-30
- Paper: *UFO2: The Desktop AgentOS*, <https://arxiv.org/abs/2504.14603>
- Docs: <https://github.com/microsoft/UFO/tree/main/documents/docs/ufo2>

### 1.1 The Puppeteer class

`ufo/automator/puppeteer.py` (308 lines) defines `AppPuppeteer`. It is not a browser
Puppeteer; it is a **command queue plus a receiver registry**.

| Symbol | Line | Role |
|---|---|---|
| `AppPuppeteer` | 22 | Facade over one app's command queue |
| `AppPuppeteer.command_queue` | 34 | `Deque[CommandBasic]` |
| `AppPuppeteer.create_command` | 39 | Resolves receiver by command name, then instantiates the command class |
| `AppPuppeteer.execute_command` | 73 | `create_command(...).execute()` — one-shot |
| `AppPuppeteer.execute_all_commands` | 87 | Drains the queue, returns `List[Any]` |
| `AppPuppeteer.add_command` | 99 | Enqueue without executing |
| `AppPuppeteer.list_commands` | 110 | Union of every receiver's `list_commands()` |
| `AppPuppeteer.save_to_xml` | 149 | Serialises the queue |
| `ReceiverManager` | 185 | Owns the receiver registry |
| `ReceiverManager.create_ui_control_receiver` | 202 | UIA receiver |
| `ReceiverManager.create_api_receiver` | 225 | COM receiver |
| `ReceiverManager.get_receiver_from_command_name` | 252 | Dispatch by command name |
| `ReceiverManager.com_receiver` | 282 | Returns `WinCOMReceiverBasic` |

The design point worth copying: **one command namespace, two transports.** A command
name resolves to whichever receiver registered it, so the caller does not know or care
whether the action lands through UIA or through a COM object model.

### 1.2 The UIA + API hybrid

Two receiver families, both subclassing `ReceiverBasic`:

**UIA side** — `ufo/automator/ui_control/controller.py`

- `ControlReceiver(ReceiverBasic)` at line 45, holding a `UIAWrapper` control and a
  `UIAWrapper` application.
- `UIControlReceiverFactory(ReceiverFactory)` at line 485.
- Commands register with a decorator, `@ControlReceiver.register`. The full set:
  `ClickCommand`, `DoubleClickCommand`, `SetEditTextCommand`, `GetTextsCommand`,
  `TypeCommand`, `KeyPressCommand`, `ScrollCommand`, `DragCommand`, `WaitCommand`,
  `AnnotationCommand`, `SummaryCommand`, `NoActionCommand`, `ClickInputCommand`,
  `ClickOnCoordinatesCommand`, `DragOnCoordinatesCommand`, `WheelMouseInputCommand`,
  `MouseMoveCommand`, `keyboardInputCommand`.
- Note the split: `ClickCommand` is a semantic UIA invoke; `ClickInputCommand` and
  `ClickOnCoordinatesCommand` fall through to `pyautogui`. UFO keeps both and lets the
  LLM choose.

**COM side** — `ufo/automator/app_apis/`

- `basic.py` defines `WinCOMReceiverBasic`, which does
  `win32com.client.Dispatch(self.clsid)` then `get_object_from_process_name()`.
- Per-app clients: `excel/excelclient.py`, `word/wordclient.py`,
  `powerpoint/powerpointclient.py`, `shell/shell_client.py`, `web/webclient.py`.
- `factory.py` maps app root name to client.

So the hybrid is: **UIA for anything with a control, COM for Office object models.**
There is no UNO client and no LibreOffice support anywhere in the tree.

### 1.3 Control filtering

Two distinct things share the name "control filter" in this repo. Both matter.

**(a) The UIA query filter** — `ufo/automator/ui_control/inspector.py`

`UIABackendStrategy._get_control_filter_condition` (line 334) builds a single COM
condition with `CreateAndConditionFromArray`:

- `UIA_IsEnabledPropertyId == is_enabled`
- `UIA_IsOffscreenPropertyId == not is_visible`
- `UIA_IsControlElementPropertyId == True`
- an OR over `UIA_ControlTypePropertyId` for each requested control type

It then calls `FindAllBuildCache(scope=TreeScope_Descendants, condition, cacheRequest)`
(line 243). The cache request (`_get_cache_request`, line 325, `lru_cache`d) pre-fetches
exactly three properties: `UIA_ControlTypePropertyId`, `UIA_NamePropertyId`,
`UIA_BoundingRectanglePropertyId`. Results are capped at
`min(com_elem_array.Length, 500)`.

This is the single most reusable idea in UFO for Myco: **push the filter into the UIA
provider and cache only the three properties you need.** A naive walk of a Calc window
is thousands of cross-process COM calls; this is one.

Supporting classes: `BackendFactory` (32), `BackendStrategy` ABC (52),
`UIAElementInfoFix(UIAElementInfo)` (92) which overrides the expensive property getters
with cached values, `Win32BackendStrategy` (380), `ControlInspectorFacade` (466).

**(b) The relevance filter** — `ufo/automator/ui_control/control_filter.py`

`ControlFilterFactory.create_control_filter` (line 16) returns one of three:

- `TextControlFilter` — token/string scoring against the plan
- `SemanticControlFilter` — `sentence_transformers.SentenceTransformer` embeddings,
  cosine similarity, `heapq` top-k
- `IconControlFilter` — scores cropped icon images against the plan

This is LLM-adjacent ranking, not structural filtering. It exists because UFO feeds a
numbered control list to a model and needs to keep the list short.

### 1.4 How UFO detects action success or failure

**It does not, structurally.** This is the finding that matters most for Myco.

- `ufo/agents/agent/evaluation_agent.py` defines `EvaluationAgent(BasicAgent)`.
- `ufo/prompts/evaluation/evaluate.yaml` is the whole mechanism. The system prompt
  says: *"judge whether the agent has successfully completed the task based on the
  screenshots and the `<Execution Trajectory>`"*, and requires
  `{"reason": ..., "sub_scores": [...], "complete": "yes/no/unsure"}`.
- The prompt explicitly instructs the model to *"observe the screenshot differences"*.

There is no postcondition object, no state assertion, no re-read of the control after
an action. `ControlReceiver.wait_enabled` and `wait_visible` (controller.py, ~line 400)
poll `is_enabled()` / `is_visible()` with a timeout, but they only `warnings.warn` on
timeout and return `None` — they cannot fail an action.

Consequence: UFO's success signal is a second LLM opinion over pixels. That is exactly
the gap Myco's vision names ("a successful interaction is not the same as a successful
outcome"). UFO is a good source of *adapter mechanics* and a poor source of
*verification*.

### 1.5 Dependencies and platform

`requirements.txt` pins, all `sys_platform == 'win32'`:

```
pywin32>=310
pywinauto==0.6.8
pyautogui==0.9.54
uiautomation==2.0.18
comtypes==1.2.0
```

Windows-only by construction: `puppeteer.py` and `basic.py` both guard
`platform.system() == "Windows"` and set the type to `Any` elsewhere. There is no
ARM64 statement anywhere in the repo `[UNVERIFIED]`; the pinned `comtypes==1.2.0` is
older than the current 1.5.0 and predates any ARM work.

---

## 2. Vercel Labs agent-desktop

- Repo: <https://github.com/vercel-labs/agent-desktop>
- License: Apache-2.0 (`LICENSE`, `Cargo.toml` `license = "Apache-2.0"`)
- 25,349 stars, 263 open issues, last push 2026-11-18, v1.3.1 released 2026-11-13
- Docs: <https://agent-browser.dev/desktop/>

Tiffany's five claims, checked one at a time.

| Claim | Verdict | Evidence |
|---|---|---|
| It exists | **True** | Repo, npm package `agent-desktop@1.3.1`, GitHub releases |
| It is Rust | **True** | `Cargo.toml`: `edition = "2024"`, `rust-version = "1.89"`, workspace of `crates/{core,macos,windows,linux,ffi}` + `src` |
| Reads accessibility trees (AX / UIA / AT-SPI) | **True** | `crates/macos`, `crates/windows`, `crates/linux`; Windows uses the `uiautomation` Rust crate plus raw `windows` COM |
| Returns refs | **True** | `@s8f3k2p9:e8` form; `crates/core/src/refs/` |
| Headless | **True, with a caveat** | See 2.3 — headless means no pointer movement, not no display |
| Explicit stale-ref errors | **True** | `STALE_REF` and `AMBIGUOUS_TARGET` in `crates/core/src/response/error_code.rs:33` |
| Exposes MCP | **True** | `src/mcp/mod.rs`, stdio, protocol `2026-07-28` plus legacy `2025-11-25`/`2025-06-18`/`2025-03-26`/`2024-11-05` |

### 2.1 Windows implementation

`crates/windows/src/` is a real UIA client, not a stub. Relevant files:

- `tree/automation.rs:191` — `CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL)` into
  `IUIAutomation2`, then `SetConnectionTimeout` / `SetTransactionTimeout`, then narrowed
  to `IUIAutomation`. The doc comment at line 168 explains why this is not the obvious
  `UIAutomation::new_direct()`: that path is `CoCreateInstance(&CUIAutomation, ...)`,
  which does not support `IUIAutomation2`, so **its calls carry no timeout at all** —
  measured against a window that stopped dispatching, `ElementFromHandle` did not return
  inside a 30 s watchdog. `CUIAutomation8` exposes `SetConnectionTimeout` and the same
  call then returns `UIA_E_TIMEOUT` inside the bound. There is deliberately no fallback
  to the unbounded client. **This is a robustness primitive Myco must copy**: a hung
  target app must not hang the adapter.
- `tree/walk/walker_source.rs` — `UITreeWalker` / `UICacheRequest` from the
  `uiautomation` crate; `parent_step`, child enumeration.
- `tree/walk/walker.rs:58` — comment: *"UI Automation hands back a *new*
  `IUIAutomationElement` proxy for every query"* — the identity problem Myco will hit.
- `tree/resolve/` — `resolve_anchor`, `resolve_descent`, `resolve_match`,
  `resolve_search`, `resolve_pacing`, `resolve_retry`.
- `tree/hit_test/` — `hit_test_classify`, `hit_test_corroborate`.
- `actions/` — `dispatch`, `mutation`, `value_write`, `toggle_state`, `select`,
  `scroll_ladder`, `focus`, `physical_click`, `physical_keyboard`.
- `system/` — `launch`, `close`, `window/`, `capture/`, `interaction_lease/`,
  `process_identity`, `permissions`, `signal/`, `menu/`, `shell/`.

### 2.2 API surface: library, CLI, and MCP

Three surfaces, all real.

**Rust library.** `crates/core/src/adapter/mod.rs:39`:

```rust
pub trait PlatformAdapter: ObservationOps + ActionOps + InputOps + SystemOps {}
```

- `ObservationOps` (`adapter/observation.rs:30`): `observe_tree`, `list_windows`,
  `list_apps`, `list_apps_inventory`, `focused_app`, `is_application_surface`,
  `is_nonspatial_target`.
- `ActionOps` (`adapter/actions.rs:6`): `execute_action`, `scroll_into_view`,
  `scroll_ref_into_view`, `headed_requirement`.
- `InputOps`, `SystemOps` similarly.

**C ABI.** `crates/ffi` builds `libagent_desktop_ffi.{dylib,so,dll}` for
Python/Swift/Go/Node/C++. From `crates/ffi/src/lib.rs`:

- Must be built with `--profile release-ffi` (the workspace `release` profile is
  `panic = "abort"`, which would defeat the `trap_panic` boundary; there is a
  `compile_error!` guard for this).
- Error model is POSIX-`errno`-like: thread-local last-error, `ad_last_error_message()`.
- Native element handles are thread-affine registry capabilities — must be used and
  released on the resolving thread.
- Desktop mutations are serialised by a cross-process interaction lease.

**MCP.** `src/mcp/mod.rs` — stdio server, one tool per leaf CLI command, max 8
concurrent calls, 4 MiB message cap. Its own instructions string states the contract:
*"Refs such as @s8f3k2p9:e1 come from desktop_snapshot and go stale when the UI changes:
on STALE_REF or AMBIGUOUS_TARGET, snapshot again. Repeat an action only when its
disposition.retry is 'safe'."*

**CLI.** `src/cli/mod.rs:35` `enum Commands` — `snapshot`, `find`, `screenshot`, `get`,
`is`, `click`, `double-click`, `triple-click`, `right-click`, `type`, `set-value`,
`clear`, `focus`, `select`, `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll`,
`scroll-to`, `press`, `key-down`, `key-up`, `hover`, `drag`, `mouse-move`, `mouse-click`,
`mouse-down`, `mouse-up`, `mouse-wheel`, `launch`, `close-app`, `list-windows`,
`list-displays`, and more.

### 2.3 What "headless" actually means

This is the claim most likely to be misread, so it is worth being exact. From
`skills/agent-desktop-windows/SKILL.md`:

> Requires Windows 10 1809+ / Windows Server 2019+ (x64 or ARM64). Run it in the
> interactive desktop session of the signed-in user. Session 0 (services and SYSTEM
> tasks), Server Core, the secure desktop (UAC prompts, the sign-in screen), a locked
> desktop and another user's session are not supported.

And from `README.md`:

> **Headless by default.** Ref actions use the accessibility API without moving the
> pointer or taking focus. The global `--headed` flag allows physical input.

So: **headless = no cursor movement, no focus steal. It is not "no display".** A live
interactive desktop session is required. For Myco this is fine (the M1 VM has one) but
it rules out running the adapter from a Windows service or a Session 0 agent host.

### 2.4 Verification model — the most valuable part

`skills/agent-desktop-windows/references/troubleshooting.md` documents a three-way
outcome for every stateful action (`set-value`, `clear`, `type`, `toggle`, `check`,
`uncheck`, `expand`, `collapse`):

1. **`delivered_verified`** — the readback matched. A value write also carries
   `details.verification_scope: "element_value"` and
   **`application_commit: "not_verified"`**.
2. **`ACTION_FAILED`** with `details.kind: "post_action_verification"` and
   `details.post_state` — the action landed but the readback contradicts the request.
   `disposition.retry` is `unsafe`.
3. **`delivered_unverified`** with `details.verification_scope: "unavailable"` — the
   evidence was never observed. Not a failure, not proof nothing changed.

The settle loop polls every 50 ms up to a 400 ms cap and **never re-runs the action**.

Two documented sharp edges that Myco must design around:

- *"A `set-value` that the application reshapes reads as failed."* If the app trims,
  reformats a date, or normalises a number, the readback differs and the envelope says
  `ACTION_FAILED` although the write landed. Numeric tolerance is role-scoped: only
  `slider`, `incrementor`, `scrollbar`, `handle` compare numerically, so a `textfield`
  storing `42.0` after you wrote `42` fails this way.
- *"The dialog's Save button returns `delivered_unverified`, because a synthesized
  invoke cannot confirm what the shell dialog did with it. Verify by reading the file
  back from disk."*

That last sentence is Myco's thesis, stated by a different project. `application_commit:
"not_verified"` is precisely the boundary where Myco's independent verifier belongs.

### 2.5 What it does not do

- **No COM, no UNO, no JVM.** The adapter is accessibility-tree only. There is no
  object-model channel, so no `XCell.getValue()` equivalent.
- **No LibreOffice coverage.** Zero mentions of LibreOffice, Calc, or soffice in the
  repo; zero issues. Untested against the M1 target app.
- **No sandbox on Windows yet.** SKILL.md: *"Sandboxes are not available on Windows
  yet."*
- **Not on crates.io.** Every crate has `publish = false`
  (`crates/{core,ffi,linux,macos,windows}/Cargo.toml:6`). As a Rust dependency you must
  vendor it by git or path; as a C dependency you consume the release artifact.
- **No `save` command.** Saving is a menu path plus a dialog, driven by refs.
- **No model inside.** By design — the loop lives in your agent.

### 2.6 ARM64

Verified three ways:

1. CI builds and tests `aarch64-pc-windows-msvc` on a `windows-11-arm` runner
   (`.github/workflows/ci.yml`, `ffi-panic-guard` matrix; also
   `release-dry-run.yml`).
2. Release v1.3.1 ships `agent-desktop-v1.3.1-aarch64-pc-windows-msvc.tar.gz` **and**
   `agent-desktop-ffi-v1.3.1-aarch64-pc-windows-msvc.zip`.
3. SKILL.md states the requirement as "x64 or ARM64".

This is the strongest ARM64 story of any candidate.

---

## 3. pywinauto vs uiautomation (yinkaisheng)

Both are Python, both wrap UIAutomationCore through `comtypes`, both are pure-Python
wheels. They differ in abstraction level and in what they bundle.

| | pywinauto | uiautomation (yinkaisheng) |
|---|---|---|
| Repo | <https://github.com/pywinauto/pywinauto> | <https://github.com/yinkaisheng/Python-UIAutomation-for-Windows> |
| License | BSD-3-Clause | Apache-2.0 |
| Stars / open issues | 6,438 / 521 | 3,591 / 153 |
| Last push | 2026-11-08 | 2026-06-02 |
| PyPI version | **0.6.9** (2025-01-06) | **2.0.29** (2025-08-05) |
| Git version | `__version__ = "1.0.0b1"` | `VERSION = "2.0.29"` |
| Wheel | `py3-none-any` | `py3-none-any` |
| Shape | Package, two backends (`win32`, `uia`) | Single module `uiautomation/uiautomation.py` |
| UIA entry | `pywinauto/windows/uia_defines.py:45` `comtypes.client.GetModule('UIAutomationCore.dll')`, `comtypes.CoCreateInstance(..., CLSCTX_INPROC_SERVER)` | `comtypes.client.GetModule("UIAutomationCore.dll")`, `CreateObject("{ff48dba4-60ef-4201-aa87-54103eef594e}")` |
| Wrapper | `pywinauto/controls/uiawrapper.py` `UIAWrapper`, catches `comtypes.COMError` | `Control`, `WindowControl`, `PaneControl`, … in one file |
| Native bits | none | `bin/UIAutomationClient_VC140_X64.dll`, `_X86.dll` (bitmap helpers only) |
| Deps | `comtypes`, `pywin32`, `injectlib` | `comtypes>=1.2.1` |

### 3.1 The real difference

**pywinauto** is an application-level framework: `Application(backend="uia")`,
`WindowSpecification`, `child_window(...)`, `wait("ready")`, `Timings`. It gives you
retry, waiting, and a declarative selector language. Its `uia` backend is a thin
`comtypes` layer over `IUIAutomation`; the value is the ergonomics on top.

**uiautomation** is a control-level library: `auto.WindowControl(searchDepth=1, Name=...)`,
`.ButtonControl(...)`, `.Click()`, `.GetValuePattern().SetValue(...)`. It is closer to
the metal, has a `Walker` API, and ships an `inspect` tool. It is one file, which makes
it easy to read and patch.

### 3.2 Known limitations

- **pywinauto's released version is old.** PyPI is 0.6.9 (Jan 2025); the git tree is
  `1.0.0b1` — still a beta after years. 521 open issues. The `uia` backend is the
  less-travelled of the two (the `win32` backend is the default and the better tested).
- **pywinauto's `uia` backend asserts away `class_name_list`.** UFO hit this and
  documented it: `inspector.py:234-236` — `assert class_name_list is None or len(...) == 0,
  "class_name_list is not supported for UIA backend"`.
- **uiautomation's bitmap DLLs are x64/x86 only.** See 3.3.
- **Neither has a verification model.** Both return a control or raise; neither
  re-reads state to confirm an action landed. That is Myco's job either way.
- **Neither has a ref/identity system.** Both hand you live COM wrappers. UFO's
  `UIAElementInfoFix` exists precisely because re-reading properties off a live wrapper
  is slow and unstable.

### 3.3 ARM64

The decisive question is not the Python package (both are `py3-none-any`) but the
native dependencies.

**pywin32** — ships ARM64 wheels. PyPI `pywin32` 312 has
`pywin32-312-cp{310,311,312,313,314,315}-cp3xx-win_arm64.whl`. Verified from the PyPI
JSON API. This is the hard dependency that would otherwise block ARM64, and it is
satisfied.

**comtypes** — pure Python, `comtypes-1.5.0-py3-none-any.whl` (2026-11-09). It
generates COM wrappers at runtime from the type library, so there is no compiled
extension to port. Caveat: <https://github.com/enthought/comtypes/issues/925>
*"[CI] Run tests on ARM"* is **open** — ARM is not in comtypes CI. So it is expected to
work and is not proven by CI. `[INFERENCE]` on ARM64 it will work; the risk is
untested code paths, not a missing binary.

**uiautomation's bundled DLLs** — this is the one real ARM64 defect, and it is
contained. `uiautomation/uiautomation.py:88-121`:

```python
if CurrentProcessIs64Bit:
    try:
        self.dll = ctypes.cdll.UIAutomationClient_VC140_X64
        load = True
    except Exception as ex:
        print(ex)
```

with `CurrentProcessIs64Bit = sys.maxsize > 0xFFFFFFFF` (line 44). On ARM64 native
Python, `sys.maxsize` is 64-bit, so it tries the **x64** DLL, which cannot load into an
ARM64 process. The `except` catches it, `load` stays `False`, `self.dll = None`, and the
code logs *"Functionalities related to Bitmap are not available."*

The core UIA path is unaffected: it goes through
`comtypes.client.GetModule("UIAutomationCore.dll")`, which resolves the **system**
UIAutomationCore, and that is ARM64-native on Windows 11 ARM64. So on ARM64 you get
full UIA with no bitmap helpers. `[INFERENCE]` from the code path; not executed on
ARM64 hardware here.

**Issue trackers** — zero ARM64 or aarch64 issues in either repo (GitHub search API,
`repo:... +arm64` and `+aarch64`, both return 0). Nobody has reported it broken, and
nobody has reported it working.

### 3.4 Which is the safer default for LibreOffice Calc

Neither, on its own — and the reason is not the library, it is LibreOffice. See §4.4.
Given that caveat, **uiautomation is the safer default** for a Calc adapter:

- It is at the metal, so when LO's MSAA-derived tree misbehaves you can drop to
  `Walker`, raw patterns, and `GetCurrentPropertyValue` without fighting a framework.
- One file, Apache-2.0, easy to vendor and patch.
- Its released version matches its git version (2.0.29), unlike pywinauto's
  0.6.9-vs-1.0.0b1 gap.
- Fewer moving parts: no `WindowSpecification` retry layer to reason about when you are
  building your own verification and retry.

pywinauto is the better choice if you want `wait("ready")` and declarative selectors and
are willing to pin a beta. For M1, where the whole point is explicit guarded actions and
explicit verification, the framework's implicit waiting is a liability, not an asset.

---

## 4. LibreOffice UNO as an independent verifier

UNO is the strongest asset in this whole research area, because it is a **second,
independent channel into the same running process**. That is exactly what "independent
verification" requires: the adapter drives the GUI, UNO reads the object model, and
neither can fake the other's answer.

### 4.1 Windows ARM64 builds — confirmed

Official Windows ARM64 installers exist and are current.

- Download page: <https://www.libreoffice.org/download/download-libreoffice/> carries an
  `os_winaarch64` button class and an `<option value="aarch64">`, alongside
  `os_win64`.
- Direct artifact, verified with a HEAD request that followed the mirror redirect to
  `HTTP/1.1 200 OK`:
  `https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/aarch64/LibreOffice_26.8.3_Win_aarch64.msi`
  — **Content-Length: 362,065,920** (≈345 MiB).
- The SDK ships for ARM64 too:
  `LibreOffice_26.8.3_Win_aarch64_sdk.msi` in the same directory.
- Directory layout confirms first-class treatment: `stable/26.8.3/win/` contains
  `aarch64/`, `x86/`, `x86_64/`.

Earliest stable release with a `win/aarch64/` directory, probed by HTTP status:

| Version | `win/aarch64/` |
|---|---|
| 24.2.7 | 404 |
| 24.8.7 | 404 |
| 25.2.3 | 404 |
| 25.8.0 – 25.8.6 | 404 |
| **25.8.7** | **200** |
| 26.2.7, 26.8.2, 26.8.3 | 200 |

So Windows ARM64 binaries are a 25.8.x-era addition. Building for Windows ARM64 has
been possible since 7.1 (`ReleaseNotes/7.1` records the cross-compile capability); the
official binaries are much newer. **Pin 26.8.3 or later.**

### 4.2 Starting soffice with a UNO socket listener

From the LibreOffice help, *Start Parameters*
(<https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html>):

> `--accept={UNO}` — Notifies LibreOffice software that upon the creation of "UNO
> Acceptor Threads", a "UNO Accept String" will be used.

The canonical accept string, from the python-UNO bridge documentation
(<https://www.openoffice.org/udk/python/python-bridge.html>):

```
soffice.exe --accept="socket,host=localhost,port=2002;urp;StarOffice.ComponentContext"
```

Useful companions: `--norestore` (skip the crash-recovery dialog, which otherwise
blocks startup), `--nofirststartwizard`, `--nologo`, and an explicit
`-env:UserInstallation=file:///C:/myco/profile` so each Myco run gets an isolated
profile and cannot collide with a user's session.

### 4.3 Connecting with pyuno and reading Calc

The bridge pattern, verbatim from the same document:

```python
import uno

localContext = uno.getComponentContext()
resolver = localContext.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", localContext)
ctx = resolver.resolve(
    "uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
```

Reading cells — API reference
(<https://api.libreoffice.org/docs/idl/ref/>):

- `com.sun.star.table.XCellRange.getCellByPosition([in] long nColumn, [in] long nRow)`
  returns `XCell`, raises `IndexOutOfBoundsException`.
  Also `getCellRangeByName([in] string aRange)`.
- `com.sun.star.table.XCell` extends **only** `com.sun.star.uno.XInterface` and declares
  `double getValue()`, `void setValue([in] double)`, `string getFormula()`,
  `void setFormula([in] string)`, `long getError()`. It does **not** declare
  `getString()`.
- The `com.sun.star.table.Cell` service includes `XCell` **and**
  `com.sun.star.text.XText`; `XText` extends `XTextRange`, which is where
  `string getString()` lives. So `cell.getString()` works on a real cell object, but it
  arrives through `XText`, not `XCell`. Query it explicitly if you want to be strict:
  `uno.queryInterface(com.sun.star.text.XTextRange, cell).getString()`.
- `com.sun.star.util.XModifiable` exposes `boolean isModified()` and
  `void setModified([in] boolean)`.

So the verifier can, without touching the GUI:

```python
sheet = doc.Sheets.getByIndex(0)
cell  = sheet.getCellByPosition(2, 5)          # C6
value = cell.getValue()                         # numeric; 0 for a string cell
form  = cell.getFormula()                       # original text / formula string
text  = cell.getString()                        # display string, via XText -> XTextRange
err   = cell.getError()                         # 0 == no error
dirty = doc.isModified()                        # unsaved changes pending
```

Note the `getValue()` semantics from the IDL: *"For a value cell the value is returned,
for a string cell zero is returned and for a formula cell the result value of a formula
is returned."* So `getValue() == 0` is ambiguous between "empty", "zero", and "text
cell" — always pair it with `getFormula()` or `getString()`.

`getError()` is a genuine bonus: it distinguishes "the cell holds 0" from "the cell
holds `#DIV/0!`", which a UIA text read cannot do reliably.

### 4.4 Does UNO work with the GUI at the same time?

Yes. `--accept` and `--headless` are orthogonal flags. `--accept` starts acceptor
threads inside the normal process; without `--headless` the normal GUI runs and UNO
attaches to it. This is the standard pattern for driving a visible LibreOffice from a
script, and it is what makes the M1 demo possible: the agent drives the visible window
through UIA, and the verifier reads the same document through UNO.

Two caveats worth designing for:

- **UNO bypasses the GUI.** A UNO write to a cell does not go through the UI, so it is
  not evidence that the *GUI* path worked. The verifier must be read-only. If Myco ever
  writes through UNO, the verification becomes circular.
- **`isModified()` is a document-level flag, not a per-cell one.** It answers "are there
  unsaved changes", not "did my edit land". Use it to detect a *missed save*, and use
  cell reads to detect a *missed edit*.

### 4.5 The LibreOffice UIA problem — the most important finding in this document

LibreOffice's Windows accessibility bridge is **MSAA / IAccessible2, not native UIA**.
From `winaccessibility/README.md` in the LibreOffice core tree
(<https://github.com/LibreOffice/core/tree/master/winaccessibility>):

> This code provides a bridge between our internal Accessibility interfaces ...
> and the Windows `MSAA` / `IAccessible2` COM interfaces that are familiar to windows
> users and Accessible Technologies (ATs) such as the NVDA screen reader.

> VCL <-> UNO toolkit <-> UNO a11y <-> win a11y <-> COM / IAccessible2

There is no `UIAutomationClient` / `IUIAutomationProvider` implementation in that
module. A UIA client therefore sees LibreOffice through Windows' **MSAA-to-UIA proxy**,
which is a lossy translation: it synthesises control types and patterns from MSAA roles
and states, and it does not give you a native `ValuePattern`, `GridPattern`, or
`TextPattern` with the fidelity a native provider would.

Practical consequences for M1:

- A Calc cell is not a first-class UIA element with a `ValuePattern`. Reading "the value
  in C6" through UIA means walking a table/grid proxy and hoping the bridge exposed it.
- `set-value` on a cell will most likely land in `delivered_unverified` or
  `ACTION_FAILED` (`post_action_verification`), because the readback will not match.
- The 500-element cap and the three-property cache that make UFO fast are tuned for
  native providers; against a proxy bridge the tree is both larger and less informative.

This does not sink the UIA adapter — it reframes it. **UIA is the actuator; UNO is the
sensor.** The M1 architecture should not pretend UIA can verify a Calc edit.

---

## 5. Cua

- Repo: <https://github.com/trycua/cua>
- License: **MIT** (`LICENSE.md`, "MIT License, Copyright (c) 2025 Cua AI, Inc.")
- 32,623 stars, 1,582 open issues, last push 2026-11-19

### 5.1 What the driver does on Windows

`libs/cua-driver` is a Rust workspace with a real Windows platform crate:

- `crates/platform-windows` — the Windows backend.
- `crates/cua-driver-uia` — a separate `uiAccess`-marked binary. Its `Cargo.toml`
  comment explains why: *"Tiny uiAccess-marked binary that hosts the Windows tool
  registry over a named pipe (`\\.\pipe\cua-driver-uia`). The main `cua-driver` CLI/MCP
  binary prefers this pipe on Windows when present, so SendInput / UI Automation calls
  land in this process (UIAccess integrity → UIPI bypass for UWP apps) instead of the
  main daemon (Medium integrity → blocked by AppContainer)."*
- `crates/platform-macos`, `crates/platform-linux`, `crates/cua-driver-core`,
  `crates/cua-driver-contract`, `crates/cua-perception`, `crates/cua-cursor-motion`.
- Transport: MCP over stdio (`libs/cua-driver/README.md`).

The UIPI-bypass worker is a genuinely useful idea for Myco: elevated target windows
cannot be driven from a medium-integrity process, and splitting the elevated work into
a `uiAccess` binary launched via `ShellExecute` is the correct Windows answer.

### 5.2 Evidence discipline

`libs/cua-driver/docs/action-support.md` is the most rigorous artifact in this whole
research area. It is a per-platform, per-harness ledger where:

- **Delivered** means a fixture-owned state change was observed.
- **Refused** means the exact structured refusal code *and* all required desktop
  side-effect oracles passed.
- **Gap** means unsupported or not yet proven, and *"A missing row is never evidence
  that an action is impossible."*

Accepted Windows baseline: source `64e82449`, run `29257963004`, **122/122 rows, 99
delivered and 23 exact refusals**. Native Windows harnesses covered: WPF, WinUI3,
WebView2. Shared web harnesses: Electron, Tauri.

This ledger format is worth copying for Myco's own adapter conformance suite — it is
the difference between "we tested it" and "here is the row, the oracle, and the exact
refusal code".

### 5.3 What is reusable, and what is not

**Reusable:**

- `crates/platform-windows` and `crates/cua-driver-uia` as reference implementations of
  UIA dispatch and UIPI elevation (MIT, so vendoring is clean).
- The action-support ledger methodology.
- The refusal-code taxonomy (`background_occluded`, `background_unavailable`,
  `background_uipi_blocked`, `window_target_not_found`).

**Not reusable for M1:**

- **Lume** (`libs/lume`) is *"CLI and framework for macOS and Linux VMs using Apple
  Virtualization Framework"* — it cannot host a Windows guest, and it cannot run on a
  Windows host. Irrelevant to a Windows 11 ARM64 VM.
- **`qemu-docker`** is explicitly deprecated: *"the `trycua/cua-qemu-*` images is no
  longer maintained by Cua and will not receive rebuilds, updates or security fixes."*
- **The agent loop** — Cua has no verification, learning, or commit gate, which is the
  whole of Myco's thesis.
- **`cua-perception`** is not MIT. `libs/cua-driver/README.md` warns: *"The extension is
  not MIT licensed. Its OmniParser icon detector is AGPL-3.0-only."* Do not take a
  dependency on it.
- **Not on crates.io** — every crate in the driver workspace has `publish = false`.

---

## 6. Comparison table: adapter candidates for M1

Scored against what M1 actually needs: drive Calc, read state structurally, verify
independently, survive ARM64, and be buildable in a week.

| | **pywinauto** (`backend="uia"`) | **uiautomation** (yinkaisheng) | **agent-desktop** |
|---|---|---|---|
| Language | Python | Python | Rust (+ C ABI, CLI, MCP) |
| License | BSD-3-Clause | Apache-2.0 | Apache-2.0 |
| Released version | 0.6.9 (2025-01-06); git is 1.0.0b1 | 2.0.29 (2025-08-05) | 1.3.1 (2026-11-13) |
| Stars / open issues | 6.4k / 521 | 3.6k / 153 | 25.3k / 263 |
| Last push | 2026-11-08 | 2026-06-02 | 2026-11-18 |
| UIA access | `comtypes` → `IUIAutomation` | `comtypes` → `IUIAutomation` | `uiautomation` crate + `windows` `CUIAutomation8` |
| Ref / identity system | none (live wrappers) | none (live wrappers) | **yes** — `@snapshot:ref`, `STALE_REF`, `AMBIGUOUS_TARGET` |
| Post-action verification | none | none | **yes** — `delivered_verified` / `delivered_unverified` / `ACTION_FAILED` |
| Bounded UIA calls (hung-app safety) | **no** — no `SetConnectionTimeout` anywhere | **no** — no `SetConnectionTimeout` anywhere | **yes** — `CUIAutomation8` + `SetConnectionTimeout`/`SetTransactionTimeout` |
| Explicit "app committed?" signal | no | no | **yes** — `application_commit: "not_verified"` |
| COM / UNO / JVM channel | no | no | **no** |
| Headless (no cursor, no focus) | partial (semantic patterns) | partial | **yes, by default** |
| Requires interactive session | yes | yes | yes (documented) |
| ARM64 | pywin32 312 `win_arm64` wheels; comtypes pure-Python (CI gap) | same, plus x64-only bitmap DLLs that degrade gracefully | **CI-tested + released** `aarch64-pc-windows-msvc` |
| Distribution | PyPI | PyPI | npm, GitHub releases, C ABI; **not crates.io** |
| LibreOffice tested | no | no | no |
| Effort to first Calc read | low | low | medium (FFI or CLI subprocess) |
| Effort to first Calc *verified* write | high (build it) | high (build it) | medium (verification primitives exist, but `application_commit` is `not_verified`) |

**Reading the table.** agent-desktop is the only candidate that already has the two
primitives M1 is about — stable refs and a three-way action outcome. It is also the only
one with proven ARM64. Its gap is the one that matters most for Calc: no object-model
channel, and LibreOffice's UIA is a proxy bridge.

---

## 7. ARM64 support matrix

The M1 VM is Windows 11 ARM64. Every dependency, with evidence.

| Dependency | ARM64 status | Evidence |
|---|---|---|
| **LibreOffice** | **Supported, official** | `LibreOffice_26.8.3_Win_aarch64.msi`, 362,065,920 bytes, HTTP 200 after mirror redirect; `_sdk.msi` also present; download page exposes `os_winaarch64` / `<option value="aarch64">`. First stable with `win/aarch64/`: 25.8.7 (25.8.0–25.8.6 and all earlier probed versions 404). |
| **LibreOffice UNO / pyuno** | **Supported** | Ships inside the ARM64 MSI; the SDK is published for aarch64. `[INFERENCE]` that `program/python.exe` + `uno.py` + `pyuno.pyd` are ARM64-native in that MSI — not executed here (no Windows ARM64 host). |
| **pywin32** | **Supported** | PyPI 312 publishes `pywin32-312-cp{310..315}-cp3xx-win_arm64.whl`. |
| **comtypes** | **Expected to work, not CI-proven** | `comtypes-1.5.0-py3-none-any.whl` — pure Python, generates wrappers at runtime. <https://github.com/enthought/comtypes/issues/925> *"[CI] Run tests on ARM"* is **open**. |
| **pywinauto** | **Expected to work** | `pywinauto-0.6.9-py2.py3-none-any.whl` — pure Python. Depends on pywin32 (ARM64 wheels exist) and comtypes. Zero ARM64 issues in the tracker. |
| **uiautomation** | **Works, bitmap features degrade** | `uiautomation-2.0.29-py3-none-any.whl` — pure Python. `uiautomation.py:44` `CurrentProcessIs64Bit = sys.maxsize > 0xFFFFFFFF`; line 97 loads `UIAutomationClient_VC140_X64.dll`, which cannot load into an ARM64 process; the `except` sets `self.dll = None` and logs "Functionalities related to Bitmap are not available". Core UIA goes through the system `UIAutomationCore.dll` and is unaffected. Zero ARM64 issues. |
| **agent-desktop** | **Supported, CI-tested, released** | CI matrix target `aarch64-pc-windows-msvc` on `windows-11-arm`; release v1.3.1 ships `agent-desktop-v1.3.1-aarch64-pc-windows-msvc.tar.gz` and `agent-desktop-ffi-v1.3.1-aarch64-pc-windows-msvc.zip`; SKILL.md states "x64 or ARM64". |
| **Cua driver** | **Supported** | `crates/platform-windows` in the Rust workspace; `docs/action-support.md` records a Windows/Win32 accepted baseline of 122/122 rows. ARM64 target not separately confirmed `[UNVERIFIED]`. |
| **UFO / UFO2** | **Unverified, likely broken** | Pins `comtypes==1.2.0` (current is 1.5.0) and `pywinauto==0.6.8`; no ARM64 statement in the repo; no ARM64 issues. `[UNVERIFIED]` — do not assume it runs. |

---

## 8. Dead ends

Recorded so nobody re-walks them.

1. **UFO's success detection.** `EvaluationAgent` + `evaluate.yaml` is an LLM judging
   screenshots. It cannot produce a machine-checkable postcondition, and it is the exact
   failure mode Myco exists to fix. Do not port it.
2. **UFO's `ControlFilterFactory` semantic/icon filters.** They exist to shorten a
   numbered control list for a model. Myco's runtime should not need an embedding model
   to decide which control to act on; refs and selectors do that job.
3. **UFO as a dependency.** Windows-only by construction, pinned to 2024-era
   `comtypes`/`pywinauto`, no ARM64 evidence, and its architecture (HostAgent +
   AppAgent + MCP servers + RAG) is far larger than M1 needs. Read it, do not import it.
4. **pywinauto's `win32` backend for Calc.** It is the default and the better-tested
   backend, but it reads Win32 control classes. LibreOffice draws its own widgets; the
   `win32` backend sees a canvas, not cells.
5. **`class_name_list` with pywinauto's `uia` backend.** Hard `assert` in the code path
   (`inspector.py:234-236` in UFO documents the same wall).
6. **uiautomation's bitmap helpers on ARM64.** The bundled DLLs are x64/x86 only and
   silently disable themselves. Do not build screenshot-diff verification on them.
7. **Cua's Lume for a Windows guest.** Apple Virtualization Framework; macOS and Linux
   guests only, macOS host only.
8. **Cua's `qemu-docker`.** Deprecated by the maintainers, no rebuilds, no security
   fixes.
9. **Cua's `cua-perception`.** AGPL-3.0 (OmniParser) inside an otherwise MIT project.
   Redistribution or network service triggers source obligations.
10. **agent-desktop as a crates.io dependency.** Every crate is `publish = false`. Use
    the C ABI release artifact, the CLI, or a vendored git dependency.
11. **agent-desktop from a Windows service or Session 0.** Documented unsupported:
    Session 0, Server Core, secure desktop, locked desktop, another user's session.
12. **Treating `delivered_verified` as "the app committed".** It is not.
    `application_commit: "not_verified"` is in the envelope. For Calc, a verified
    element value still says nothing about the saved file.
13. **Verifying Calc through UIA alone.** LibreOffice's Windows bridge is MSAA /
    IAccessible2 (`winaccessibility/README.md`); UIA sees a proxy. Cell values and error
    states are not reliably readable that way.
14. **Writing through UNO and then verifying through UNO.** Circular. The verifier must
    be read-only.
15. **Expecting pywinauto or uiautomation to time out on a hung app.** Neither calls
    `SetConnectionTimeout` or `SetTransactionTimeout` — verified by grep across both
    trees. A target that stops dispatching will block the adapter indefinitely. This is
    not a tuning problem; it is a missing call you must add.

---

## 9. Recommendations for M1

1. **Build the M1 adapter on `uiautomation` (yinkaisheng), not pywinauto and not
   agent-desktop.** It is at the metal, Apache-2.0, one file, its released version
   matches its git version, and it degrades cleanly on ARM64 (bitmap helpers off, UIA
   intact). pywinauto's released 0.6.9 is old and its `uia` backend is the
   less-travelled path; agent-desktop is the better *product* but the wrong *first
   dependency* because it has no object-model channel and is not on crates.io.

2. **Steal agent-desktop's two primitives rather than its code.** Copy the ref model
   (`@snapshot:ref`, `STALE_REF`, `AMBIGUOUS_TARGET`) and the three-way action outcome
   (`delivered_verified` / `delivered_unverified` / `ACTION_FAILED` with
   `details.post_state` and `disposition.retry`). These are the right shapes and they
   are already validated by a 25k-star project. Reimplement them in Myco's own
   vocabulary so the trace format is ours.

3. **Make UNO the independent verifier, read-only, in a separate process.** Start
   `soffice.exe --accept="socket,host=localhost,port=2002;urp;StarOffice.ComponentContext"
   --norestore --nofirststartwizard -env:UserInstallation=file:///C:/myco/profile`.
   The verifier connects with `UnoUrlResolver`, reads `XCell.getValue()` /
   `getString()` / `getError()` and `XModifiable.isModified()`, and **never writes**.
   Separate process, separate channel, no shared state with the actuator — that is what
   makes the verification independent rather than self-referential.

4. **Split the M1 claim into two verifications, because they fail differently.**
   *Edit landed* → UNO cell read (`getValue`/`getString`/`getError`). *Edit persisted* →
   close the document, reopen from disk, read the same cells again. `isModified()` is
   the cheap pre-check that catches a missed save before you pay for a reopen. A UIA
   readback alone can never establish either.

5. **Treat UIA as the actuator and expect it to be lossy on Calc.** LibreOffice's
   Windows accessibility bridge is MSAA/IAccessible2, so UIA sees a proxy. Budget for
   `delivered_unverified` and `ACTION_FAILED` on cell writes, and make the runtime's
   default response to `delivered_unverified` be "ask UNO", not "retry". This is also
   the honest answer to the M1 baseline: a screenshot agent and a UIA agent both need
   UNO to know the truth.

6. **Adopt UFO's UIA query shape for observation.** One `FindAllBuildCache` with a
   composed condition (`IsEnabled`, `IsOffscreen`, `IsControlElement`, OR over control
   types) and a cache request limited to ControlType/Name/BoundingRectangle, with a hard
   element cap. It is the difference between one cross-process call and thousands. UFO's
   `inspector.py:243-370` is the reference.

7. **Bound every UIA call with a connection timeout, and refuse to run unbounded.**
   Create the client as `CUIAutomation8` → `IUIAutomation2` and call
   `SetConnectionTimeout` / `SetTransactionTimeout` before any query. agent-desktop
   measured the failure this prevents: against a window that stopped dispatching,
   `ElementFromHandle` on the unbounded `CUIAutomation` client did not return inside a
   30 s watchdog (`crates/windows/src/tree/automation.rs:168-198`). M1's "killed app"
   corruption trial will hit exactly this. **Neither Python library exposes these
   setters** — `grep -n "ConnectionTimeout\|TransactionTimeout"` returns nothing in
   `uiautomation/uiautomation.py` or anywhere under `pywinauto/`. So this is a raw
   `comtypes` call you write yourself alongside the library, not a configuration flag.
   Budget for it; it is the difference between a bounded failure and a hung run.

8. **Pin LibreOffice 26.8.3 or later, and pin it by hash.** Windows ARM64 binaries
   start at 25.8.7; 26.8.3 is current and ships both the MSI and the SDK for aarch64.
   Record the SHA-256 of the MSI in the repo so the evaluation is reproducible.

9. **Do not take a dependency on UFO, Cua, or agent-desktop.** UFO is Windows-only,
   pinned to 2024-era deps, and its verification is an LLM. Cua's reusable parts are
   MIT but off-crates.io, and its perception extension is AGPL. agent-desktop is
   Apache-2.0 and excellent, but `publish = false` and no COM/UNO. Read all three; import
   none in M1.

10. **Copy Cua's action-support ledger format for the M1 conformance suite.** One row per
    (app, action, target-kind) with an explicit oracle, an explicit refusal code, and a
    "gap" state that is never counted as a pass. That is what makes "27 of 30" and "0
    false successes" auditable rather than asserted.

11. **Keep the UIPI problem on the roadmap, not in M1.** Cua's `cua-driver-uia`
    (`uiAccess` binary over a named pipe) is the correct pattern for driving elevated
    windows. Calc at normal integrity does not need it. Note it, do not build it.

12. **Re-check the ARM64 assumptions on the actual VM before writing the adapter.**
    Three things are `[INFERENCE]` here and each is a one-command check on the target:
    `python -c "import comtypes; print(comtypes.__version__)"` on ARM64 Python;
    `python -c "import uiautomation as a; print(a.__version__)"` and confirm the bitmap
    warning appears but UIA works; and confirm `program\python.exe` in the ARM64
    LibreOffice install imports `uno`. If any fails, the fallback is agent-desktop's
    `aarch64-pc-windows-msvc` FFI artifact, which is CI-tested and released.
