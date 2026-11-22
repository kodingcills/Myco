# Prior art for the Desktop Runtime: input and accessibility layers

Research for the Myco Desktop Runtime workstream. Scope: before writing any input or
accessibility code for the v0 Linux ARM64 guest (QEMU+HVF on an Apple M4 Pro host), decide
**build / adopt / wrap** for each candidate. Myco's differentiating value is execution
guarantees, lifecycle and an agent-ready environment, not re-inventing mouse, keyboard or
tree-walking code.

Method: every claim below was checked against a clone of the repository at the commit listed,
the crates.io API, or the project documentation. Access date for all web sources:
**2026-11-19**. Anything not verified is marked `[INFERENCE]`. Clones (shallow, read-only):

| Project | Commit | Commit date (UTC) |
|---|---|---|
| xa11y/xa11y | `49e4b8fc245b0c3853052249af6f6f10f764378b` | 2026-11-19 |
| The-Best-Codes/computer-use-rs | `bf1f2e91eb71d1af37a64836c1be6ad9dc2513f6` | 2026-11-17 |
| microsoft/Hybrid-Computer-Use | `8ce82b310b014ab1133b28febc2eca81527e43e6` | 2026-11-18 |
| vercel-labs/agent-desktop | `e8934a5` | 2026-11-17 |
| trycua/cua | `HEAD` of `main` (sparse) | pushed 2026-11-19 |
| xlang-ai/OSWorld | `5123bfd` | 2026-11-13 |

The six ops the runtime must expose: `create`, `observe` (accessibility tree + screenshot +
process/window info), `act`, `evidence`, `reset`, `destroy`. None of the three primary
candidates implements `create`, `reset` or `destroy`, and none of them implements an evidence
artifact lifecycle keyed to a run. That is the space Myco fills.

---

## 1. xa11y

- Repo: <https://github.com/xa11y/xa11y> (accessed 2026-11-19)
- Docs: <https://xa11y.dev> · Rust API: <https://docs.rs/xa11y>
- License: MIT (`LICENSE`, "Copyright (c) 2025 Stephen Crowe"). Dependencies enforced
  permissive via `cargo-deny` (`deny.toml`).
- Language: Rust (workspace, edition 2021, MSRV 1.88). Python and JS bindings exist
  (`xa11y-python`, `xa11y-js`) but are `publish = false` crates shipped to PyPI/npm instead.
- Size: ~46k lines in `xa11y-core` + `xa11y-linux` alone; `xa11y-linux/src/atspi.rs` is
  9,164 lines.
- Published crates (crates.io API, 2026-11-19): `xa11y` 0.16.1 (16,725 downloads),
  `xa11y-core` 0.16.1 (18,317), `xa11y-linux` 0.16.1 (14,961). **All three are on
  crates.io**, with `xa11y-core`/`xa11y-linux` pinned with `=` to the umbrella version so a
  mismatched pair fails the build deliberately (`Cargo.toml`, workspace dependencies
  comment).

### 1.1 What it actually does

A Playwright-style locator API over native accessibility APIs:

- **macOS** — AXUIElement; **Windows** — UI Automation; **Linux** — AT-SPI2 over D-Bus
  (`README.md` "Platform Support", `xa11y-linux/src/lib.rs`).
- **Reads**: `Provider` trait (`xa11y-core/src/provider.rs:31`) — `get_children`,
  `get_parent`, `app_windows`, `app_roots`, `app_by_pid`; plus capability table, event
  subscription (`xa11y-core/src/event_provider.rs`), tables, text ranges/attributes
  (`xa11y-core/src/text_api.rs`), screenshots (`ScreenshotProvider`).
- **Acts**, not only reads (`README.md` "Supported Actions", `xa11y-core/src/input.rs`):
  `press`, `focus`/`blur`, `toggle`, `expand`/`collapse`, `select`, `set_value`,
  `type_text`, `increment`/`decrement`, `show_menu`; plus low-level `InputProvider`
  primitives (pointer moves, clicks, drags, key chords, scroll).
- **Selectors**: CSS-like (`button[name='OK']`, `group > button`, `button:nth(2)`) —
  `xa11y-core/src/selector.rs` (3,483 lines) and `locator.rs` (3,557 lines); locators
  re-resolve on every call.

Linux implementation details that matter to us (`xa11y-linux/src/lib.rs` module docs):

- **AT-SPI transport** is hand-rolled zbus proxies (`atspi.rs:547` `make_proxy`), not the
  `atspi` crate; connects to `$DBUS_SESSION_BUS_ADDRESS` and errors out with an actionable
  message naming `at-spi2-core` when the bus is absent (`atspi.rs:430-458`).
- **Input injection**: XTest on X11 sessions (`input.rs`, `x11rb` `xtest` feature);
  a **`/dev/uinput` virtual evdev device** on Wayland (`wayland_input.rs:1-40`), with
  keysym→evdev via `xkbcommon` and absolute pointer axes mapped through `xdg-output` layout.
  Requires root, `input` group, or a udev rule.
- **Screenshots**: `GetImage` on X11, `org.freedesktop.portal.Screenshot` on Wayland. The
  portal path **prompts the user for consent the first time per session**
  (`screenshot.rs:2-5`) — a hard blocker for unattended agents on a Wayland desktop.
- **Coordinate contract**: bounds and input points are logical; `scale.rs` documents the
  X11-vs-Wayland scale split explicitly.
- **Error model**: every error classifies delivery disposition (`NotDelivered` vs `Unknown`),
  documented in `xa11y-linux/src/lib.rs` "Delivery disposition of action failures" — e.g. a
  dispatched `DoAction` that answers `false` is `Unknown`, not a safe retry.

### 1.2 Maturity and activity

- Created 2026-03-15, 93 stars, 13 forks, 1 open issue (GitHub API, 2026-11-19).
- Latest release `v0.16.1` published 2026-11-18; five releases since 2026-09-30. Commits
  daily (HEAD 2026-11-19 "Read the placeholder text of text inputs (#718)"; PR numbers in
  the 700s).
- CI builds and publishes `aarch64-unknown-linux-gnu` (`.github/workflows/publish.yml:388`)
  and tests `aarch64-unknown-linux-gnu` in the Rust matrix (`ci.yml:758`).
- Bus factor: effectively one maintainer (Stephen Crowe) — `[INFERENCE]` from the commit
  history and copyright line; we did not enumerate contributors.
- Pre-1.0: API churn between 0.15 → 0.16 is visible in the changelog-quality commit names
  ("Pre-release review fixes for 0.16.0: API naming, relations, delivery").

### 1.3 What Myco could reuse

- **ADOPT the crate as the Linux accessibility + input backend.** It is the only candidate
  that is a published Rust crate (crates.io, MIT, semver-versioned) with real Linux AT-SPI
  tree reads, structural actions and both X11 and Wayland input delivered as part of the same
  coordinate contract.
- Its `Provider`/`ScreenshotProvider` traits are `#[doc(hidden)]` re-exported construction
  contracts — usable to build a fourth backend (e.g. a future QEMU-guest transport) without
  forking, though the docs say it is "not public API".
- Delivery-disposition vocabulary (`NotDelivered` vs `Unknown`) is directly reusable in our
  `act`/`evidence` result schema.
- `tests/matrix.yaml` — an authoritative per-app, per-platform coverage index checked in CI —
  is a good shape for our own capability matrix.

### 1.4 What it does NOT do (gaps vs the six-op API)

- No `create`/`reset`/`destroy`: no VM, container or desktop lifecycle at all.
- No process/window *inventory* as a first-class product object; windows come back as tree
  nodes (`app_windows` filtered to `Window|Dialog` roles), not as a pid/window table with
  ownership. `[INFERENCE]` from `provider.rs:41-71`; a pid is reachable via D-Bus
  (`get_dbus_pid`) but not exposed as a public window record.
- No evidence artifact: no persisted run directory, no screenshots/tree snapshots bound to a
  trace, no hashing.
- Screenshot capture on Wayland requires an interactive consent prompt.
- No MCP server, no agent-facing schema; it is a library (the `agent-desktop` CLI is a
  separate project built on it, per README "Ecosystem").

### 1.5 Recommendation: **ADOPT**

Depend on `xa11y` (with `xa11y-linux`) for `observe` tree reads, accessibility actions and
input injection inside the guest; keep it behind our own `Backend` trait so the six-op API
does not leak xa11y types. Justification: it is the only candidate with published, MIT,
Rust-native Linux AT-SPI *and* actuation; re-implementing it is exactly the "reinventing
mouse/keyboard automation" the workstream rules out. Risks to manage explicitly: pre-1.0
semver churn (pin the exact `=` version triplet the workspace already enforces), single
maintainer, and the Wayland screenshot portal prompt (for v0 we control the guest — pin an
X11 session, where `GetImage` and XTest need no prompt).

---

## 2. computer-use-rs

- Docs page given: <https://docs.rs/computer-use-rs/latest/computer_use/> (accessed
  2026-11-19). Crate repository: <https://github.com/The-Best-Codes/computer-use-rs>
  (`Cargo.toml` `repository`, also the crates.io metadata).
- License: **MIT OR Apache-2.0** (`Cargo.toml:7`, `LICENSE-MIT`, `LICENSE-APACHE`).
- Language: Rust, edition 2024, MSRV 1.89. Lib name is `computer_use` (`[lib] name`),
  deliberately avoiding the unrelated `computer-use` crate.
- Size: ~10k lines total; Linux backend 2,483 lines across 7 files.

### 2.1 What it actually does

Cross-platform **computer-use primitives**, not a runtime:

- `Computer` session (`src/computer.rs`): `list_apps`, `list_windows`, `get_app_state`
  (indexed element tree + PNG screenshot + focus/selection), `query`, `click` (element /
  screenshot pixel / screen point), `perform_secondary_action`, `scroll`/`scroll_at`,
  `drag`/`drag_screen`, `type_text`, `press_key` (xdotool chord syntax), `set_value`,
  `select_text` (`src/lib.rs` docs, `README.md` table).
- `AppState::render` gives a compact text outline for prompts/logging — the agent-facing
  observation shape.
- Pluggable `Backend` trait; `NativeBackend` per OS.

Linux specifics (`src/platform/linux/*`, `README.md` "Platforms"):

- Tree: `atspi` crate 0.30 (`proxies`) + zbus + x11rb, blocking API.
- Screenshot: X11 `GetImage` of the app's window only.
- Input: **AT-SPI DeviceEventController** (`input.rs:7-30`, `generate_mouse_event`,
  `KeySynthType`), global only.
- Explicit limits in README: "On Wayland you get trees and actions, but screenshots only of
  X11/XWayland windows … and input only reaches X11/XWayland apps."
- `Computer::new()` turns on the desktop's accessibility flag, a setting that "stays on
  afterwards"; already-running Chromium/Firefox/Electron apps are listed with
  `needs_restart`.

### 2.2 Maturity and activity

- Repo created 2026-11-05; first release 2026-11-06; 11 versions, latest 0.3.3 on
  2026-11-17 (crates.io). **279 total downloads.**
- GitHub: 0 stars, 1 fork, 0 open issues, 1 contributor (23 commits) as of 2026-11-19 —
  it is a two-week-old extraction of a vendor app's internal feature (README: maintained by
  AgentOne, "Some portions of this project are AI-generated").
- Test coverage and CI are not assessable from the docs page; the repo has
  `cargo clippy`/`cargo test` instructions but no visible cross-platform CI badge.

### 2.3 What Myco could reuse

- The **`AppState` shape** (indexed element list + one PNG + a rendered text outline) is a
  clean, small model for one `observe` call — worth copying as a schema shape for our
  `observe` result (`element.index`-addressed actions).
- `Backend` trait as a *concept* for a fake-in-test backend.
- `keys::KeyChord` xdotool-compatible chord parser is a good external contract for `act`
  (`press_key("ctrl+shift+Tab")`).
- Code reuse is low value: it duplicates what xa11y does, with less coverage.

### 2.4 What it does NOT do (gaps vs the six-op API)

- No desktop provisioning (`create`), no `reset`, no `destroy`. Purely drives a live session.
- No evidence artifacts.
- Single-window screenshots only; no full-desktop capture.
- No window/process inventory beyond `list_apps`/`list_windows` labels.
- Wayland screenshots absent; Wayland input limited to XWayland apps.
- No MCP, no stable protocol; no semver history (0.x with 11 releases in 11 days).

### 2.5 Recommendation: **BUILD** (own it), borrowing shapes only

Do not depend on it — 279 downloads, one contributor, two weeks old, and it overlaps xa11y
with worse coverage. Write our own `act`/`observe` glue on xa11y and take *concepts*: the
`AppState` observation record, the `Backend` trait boundary, and xdotool-style key chords.
Justification: a crate this young, with a pre-1.0 surface and (per its own README) AI-generated
portion, is a liability inside a runtime whose product promise is execution guarantees.

---

## 3. Microsoft Hybrid Computer Use (HCU)

- Project page: <https://microsoft.github.io/Hybrid-Computer-Use/> (accessed 2026-11-19)
- Repo: <https://github.com/microsoft/Hybrid-Computer-Use> · Paper:
  <https://arxiv.org/abs/2610.41432> (arXiv id 2610.41432, published 2026-10-30 per the
  page's citation metadata)
- License: **MIT** (`LICENSE`, "Copyright (c) 2026 Hybrid Computer Use authors"),
  `THIRD_PARTY_NOTICES.md` present.
- Language: **Go core** (~172k lines of Go including vendored deps; 422 `.go` files),
  one core/contract layer plus per-OS native providers: **Linux = Python** (PyGObject,
  AT-SPI2, X11/XTest, ~19.5k lines in `native/linux/provider/`), **macOS = Swift**
  (AXUIElement, CoreGraphics, ScreenCaptureKit), **Windows = C# .NET 8** (FlaUI UIA3, Win32).
- Release `v1.0.1` on 2026-11-16; `v1.0.0` on 2026-10-30. GitHub: 63 stars, 7 forks, 3 open
  issues, last push 2026-11-18 (API, 2026-11-19).

### 3.1 What it actually does

An **MCP server** (`computer-use`) exposing exactly two tools beside the agent's own shell:

- **`AX`** — compact accessibility tree with hierarchical short refs (`aN` application →
  `wN` window → `rN` element), modes `apps`/`observe`/`find`/`act`; `act` batches up to 64
  steps with in-call `wait`/`settle`, returns a status line
  (`ok`, `code`, `hint`, `input_emitted`, `completed`) plus per-target effects and an
  **AX diff** (`docs/MCP.md` "Public contract", "The AX state model" in `docs/ARCHITECTURE.md`).
- **`GUI`** — ordered actions (`click`, `double_click`, `move`, `drag`, `scroll`, `type`,
  `keypress`, `wait`) or a single `screenshot`/`zoom`; model sees at most 1366×768; every
  coordinate is validated against a **layout lease** — if the window under the point changed
  since the frame, the call fails with `gui_frame_stale`, sends nothing, returns a fresh
  screenshot (`docs/MCP.md` "GUI").

Architecture (`docs/ARCHITECTURE.md`): agents/CLI/Python SDK → Go `core` (validation, ref
registry, waits, evidence) → `PlatformBackend` port → a **persistent provider subprocess**
(Python/Swift/C#) speaking a private versioned JSONL protocol. Six Go packages with a
strict one-way dependency order; a golden `testdata/contract/public_contract.json` pins the
model-visible contract.

**Provenance of desktops**: HCU does **not** provision desktops. Its OSWorld runner
(`hcu/osworld/run_task.py`, `docs/OSWORLD.md`) starts the stock `happysixd/osworld-docker`
image — a QEMU-backed guest wrapped in Docker — and installs the agent + `computer-use`
inside it. On macOS/Windows it drives the local desktop. Its own README says it "sends real
input to the signed-in desktop. Use a dedicated desktop or a disposable VM for untrusted
tasks" — i.e. lifecycle is explicitly out of scope.

### 3.2 What Myco could reuse

Concepts and protocol shapes, primarily — not code:

1. **Ref as short-lived capability, not selector.** `aN → wN → rN`, resolved against live
   canonical state before every mutation; a ref goes stale when its exact target disappears.
   This is the same shape as Vercel's opaque refs but with hierarchical namespacing.
2. **`input_emitted` / `completed` / `effect_unknown` in the result envelope.** The single
   most directly reusable idea for our `act` contract: HCU separates "was input attempted"
   from "did the effect happen" and refuses to auto-retry `effect_unknown`
   (`docs/MCP.md` lines ~680-740). That is exactly the distinction our execution guarantees
   need, and it maps onto xa11y's `Delivery::Unknown`.
3. **Layout lease for coordinate actions.** Coordinates bind to a frame; a changed layout
   rejects the whole batch *before* input. Directly transplantable to our `act` op with
   screenshot-bound handles.
4. **`allow_global_input: false`** per action — a policy switch that forbids focus/raise and
   synthesized input, failing with `global_input_forbidden` instead. Useful precedent for a
   "semantic-only actuation" guarantee.
5. **The provider wire contract** — a persistent subprocess with a versioned JSONL envelope,
   plus checked-in cross-language fixtures (`testdata/provider-wire/`) replayed by Go, Swift
   and C# tests. If we ever split tree reads (guest) from orchestration (host), this is the
   right topology and a good template.
6. **Evidence discipline**: the docs page section "What evidence proves" states plainly that
   AX evidence covers only what the tree shows and GUI evidence only the returned pixels —
   the same honesty bar we need in `evidence`.

Do not reuse the Go core as a dependency: it is not a library, it is a binary with a private
protocol and no Go module import contract, and its Linux provider is embedded Python
(`go:embed` of `runtime.py` + `native/linux/provider/*.py`).

### 3.3 What it does NOT do (gaps vs the six-op API)

- No `create`/`reset`/`destroy`. Provisioning is somebody else's job (OSWorld Docker/QEMU).
- No evidence artifact lifecycle: results are per-call; nothing is persisted or hashed per run.
- Linux is **X11 only** (README "Platform support"; PLATFORMS "Signed-in X11 session").
- Not consumable as a Rust dependency; no MCP/CLI embedding story other than "run the binary".
- 63 stars, single-digit forks, released six weeks ago — ecosystem risk for a *dependency*,
  irrelevant for a *concept source*.

### 3.4 Recommendation: **BUILD**, with HCU as the design reference

Write our own `observe`/`act` against xa11y, and adopt HCU's contract shapes: ref namespace,
`input_emitted`/`effect_unknown`, layout lease bound to a screenshot handle, `allow_global_input`
policy, and a diff-carrying batch result. Justification: wrapping a Go binary with a private
wire protocol and an embedded Python provider would import an entire second runtime into a
Rust runtime, for code whose value is mostly in its *contract*, not its implementation. The
contract is MIT-licensed documentation we can lift legally and cheaply.

---

## 4. Comparative pass: who already provisions disposable programmatic Linux desktops?

Short, and only where it changes the adopt/wrap call.

**Vercel agent-desktop** (<https://github.com/vercel-labs/agent-desktop>, Apache-2.0, Rust,
25,382 stars, v1.3.1, pushed 2026-11-18) — read the tree, not the runtime. It is a Rust CLI
(`agent-desktop` binary + `crates/core` `PlatformAdapter` trait) that reads AX/UIA/AT-SPI and
acts only through opaque refs; the external `xa11y` README calls it "a CLI built on xa11y for
AI agents" — verified structurally: `crates/linux/src/` has `tree/`, `actions/`, `input/`
with X11/XTest and Wayland backends, `zbus = 5.19.0`, `x11rb` with `xtest`, `xkb`. It does
**not** provision a desktop. Its real value to us is not the Linux code (it overlaps xa11y,
and xa11y is the upstream) but the **operational findings** in
`docs/solutions/runtime-errors/`: e.g. `an-atspi-write-that-returns-success-has-not-changed-anything.md`
documents, per toolkit (GTK3, GTK4, Qt 6, Firefox, Chromium), cases where an AT-SPI write
returns `true` and nothing changed, and cases where it fails and the effect lands anyway. That
is a **must-read before writing our `act` verifier**, and it argues for read-back
verification rather than trusting action return values. Also useful: its Linux support floor
is Ubuntu 24.04+ because "Ubuntu 22.04's AT-SPI bridge aborts on `Action.GetActions`" —
pin the guest distro accordingly.

**cua / trycua** (<https://github.com/trycua/cua>, MIT, 32,631 stars, pushed 2026-11-19) — the
closest thing to a full alternative and the one to actually study for the *lifecycle* half.
`libs/cua/crates/cua-vmm` is a Rust VMM orchestrator that fetches QEMU, sets
`aarch64 → hvf` acceleration on Apple silicon, and implements exactly our reset problem:
golden snapshots — boot a template VM with RAM as a shared `memory-backend-file`, write a
migration stream with `x-ignore-shared`, then restore each VM paused with the RAM mapped
copy-on-write and the disk as a qcow2 overlay (`src/qemu/snapshot.rs` doc comment);
`freeze()` renames the disk into a layer and creates an overlay (`src/qemu/mod.rs:1861-1872`);
checkpoints use `savevm`/migration streams. `cua-driver` (Rust, `platform-linux` crate with
native `atspi` 0.30 + x11rb XTest) is the guest-side driver; `cua-spacesd` runs in-guest on
port 3211. Relevant caveat: the driver crates are **not on crates.io** (`cua-driver`,
`cua-driver-core`, `platform-linux` all 404 on crates.io, 2026-11-19), so adoption means
vendoring from a monorepo. And `libs/xfce-cua` / `libs/qemu-docker` are explicitly deprecated
by the vendor. Verdict for us: **concept source for `create`/`reset`** (golden snapshot +
CoW RAM + qcow2 overlay), not a dependency.

**OSWorld** (<https://github.com/xlang-ai/OSWorld>, Apache-2.0, Rust? no — Python evaluator +
guest server) — provisions via pluggable `desktop_env/providers/{docker,vmware,virtualbox,aws,gcp,azure,modal,daytona,…}`,
and its guest runs an HTTP controller (`desktop_env/server/main.py`: `get_accessibility_tree`
via `pyatspi`, `capture_screen_with_cursor`, `execute_command`, `activate_window`,
`close_window`, …). Materially relevant for two reasons only: (a) its **HTTP op surface**
(observe/act/execute/upload/download) is a precedent for what an agent-facing in-guest agent
looks like, and (b) its QEMU-in-Docker path is what HCU and most benchmarks use. It does not
give us stronger lifecycle guarantees than what we already plan, and the guest server is
Python + `pyatspi` (deprecated in spirit by the modern `atspi` crate) — not something to adopt
into a Rust runtime.

**cua's Lume / agent sandbox** — Lume is a macOS-on-Apple-silicon VM tool
(`libs/lume`, Swift); the current sandbox default (`cua sb create ubuntu`) is a **gVisor
container**, not a VM, and `libs/images` publishes `ghcr.io/trycua/linux:24.04` (XFCE on Xvfb
`:1`, AT-SPI, cua-spacesd) for both amd64 and arm64. Relevant if we ever want a container
tier instead of QEMU; for v0's "v0 host: Linux ARM64 guest under QEMU+HVF" it is not the shape.

**E2B desktop** — `[INFERENCE]` we did not clone it; from prior knowledge it is a hosted
sandbox with a desktop template, not a locally-orchestrated VMM, and it does not expose an
AT-SPI contract we could adopt. No evidence gathered; treated as not materially relevant to
the adopt/wrap decision.

**Bottom line of the comparative pass**: nobody open-source combines (disposable QEMU/HVF
Linux ARM64 desktop) + (AT-SPI tree with refs) + (input) + (evidence lifecycle) in one
adoptable package. The pieces exist — xa11y for the last three of those minus evidence, cua's
`cua-vmm` for lifecycle — which is consistent with the workstream thesis: Myco integrates and
adds the guarantees, it does not re-invent actuation.

---

## 5. Vercel agent-desktop: is its AT-SPI side usable as a crate or concept source?

**Crate: no. Concept source: yes, high value.**

- Every library crate sets `publish = false`: `crates/core`, `crates/linux`, `crates/macos`,
  `crates/windows`, `crates/ffi` (`Cargo.toml:6` in each). Only the CLI (`src`) ships, as a
  binary via npm. There is no cargo dependency path, and no version-pinned semver surface.
- Its Linux subsystem is substantial (`crates/linux/src/tree/{live,live_read,resolve,hit_test,vocabulary}`,
  `actions/{write,select,scroll,focus,physical_fake,popup_verify,process_check}`,
  `input/{x11,wayland,clipboard,held_input,release_guard}`) — but it is a *fork-in-spirit* of
  the same technical approach as xa11y, and the xa11y README states agent-desktop is built on
  xa11y. `[INFERENCE]` the two share lineage; we did not diff them commit-by-commit. Either
  way, taking xa11y from crates.io is strictly better than vendoring an unpublishable crate.
- **Concept source to mine, concretely**: `docs/solutions/runtime-errors/` is a set of
  post-mortems with toolkit-level measurements we would otherwise have to rediscover:
  - `an-atspi-write-that-returns-success-has-not-changed-anything.md` → every write must be
    judged by a read-back (`write_ignored` vs `delivered_unverified` vs `Matched`), never by
    the D-Bus reply; `NoReply` means "may have landed", never "retry"; secure fields are
    identified by raw AT-SPI role number 40, not by name, and GTK4 role 61 defeats that.
  - `an-atspi-error-name-is-not-proof-an-object-is-gone.md` → `UnknownObject`/`UnknownInterface`
    are ambiguous between destroyed and not-implemented; settle with one `GetRole` read.
  - Its `CONCEPTS.md` role-mapping discussion (AT-SPI role numbers folded into a canonical
    token set; `unknown` is a positive statement, distinct from a failed read) is a ready-made
    counter-argument to exposing raw platform roles to an agent.
- Confirmed against M1 research: Rust, reads AX/UIA/AT-SPI, opaque refs with stale-ref
  errors, MCP surface, Apache-2.0, `publish = false`, and no actuation beyond refs at the
  *concept* level — note the refinement from the clone: internally it does have XTest/uinput
  input backends, so the "no input actuation" claim should be read as "no coordinate-level
  actuation in its public contract", not "no input code".

---

## 6. Decision summary

| Project | Call | What we take | What we do not take |
|---|---|---|---|
| **xa11y** | **ADOPT** | `xa11y` + `xa11y-linux` from crates.io (MIT, 0.16.1) behind our own `Backend` trait: AT-SPI reads, structural actions, XTest/uinput input, delivery dispositions | Its locator API as our public contract; Wayland portal screenshots (v0 pins X11) |
| **computer-use-rs** | **BUILD** (concepts only) | `AppState` observation-record shape, `Backend` trait boundary, xdotool key chords | The dependency (0 stars, 279 downloads, 2 weeks old, AI-generated portions) |
| **Microsoft HCU** | **BUILD**, HCU as contract reference | `aN/wN/rN` ref namespace; `input_emitted`/`completed`/`effect_unknown`; screenshot-bound layout lease; `allow_global_input`; versioned provider-wire + fixture corpus; "what evidence proves" honesty | The Go binary, private JSONL protocol, embedded Python provider |
| agent-desktop | concept source | AT-SPI post-mortems (`docs/solutions/runtime-errors/`); ref/role vocabulary; Ubuntu 24.04 floor | Code (unpublishable crates; upstream is xa11y anyway) |
| trycua/cua `cua-vmm` | concept source | Golden-snapshot reset: shared RAM file + `x-ignore-shared` device state + CoW map + qcow2 overlay; `aarch64 → hvf` | Nothing as a dependency (driver crates not on crates.io; `xfce-cua` deprecated) |
| OSWorld | reference | HTTP op surface as an example of in-guest agent API | Python/`pyatspi` guest server |

Implication for the six-op API: **`observe` and `act` are cheap** (adopt xa11y, wrap it with
our result schema). **`create`, `reset`, `destroy` and `evidence` are where all our work and
all our differentiation is** — no evaluated project implements them, and cua's `cua-vmm` is
the only open-source code we found that solves the reset problem on Apple silicon.