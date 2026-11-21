# Screenshot-agent baseline — design (M1-015 / TIF-19)

Status: **proposal**, 2026-11-21. Nothing here has been executed: the M1 Coordinator holds
`myco-win11` for the M1-013 sweep (coordination "EXCLUSION RULE"), so every VM-dependent
statement is marked **UNVERIFIED** and every model statement is either cited to
`docs/research/eval-frameworks.md` or marked as an estimate with its basis.

Owner: baseline workstream, branch `myco/m1-baseline` (PR-reviewable; no code until the sweep
host is released).

Scope: M1 acceptance row 7 — *the same tasks, initial states, and model settings, compared against
a screenshot-based agent*. ADR-0009 fixed the baseline architecture as Agent S3 + UI-TARS-1.5-7B;
**that is superseded here** — upstream `cua-agent` (the Agent-S-style framework) is deprecated by
Cua, and Tiffany's 2026-11-21 direction requires a recognisable agent rather than a hand-rolled
loop. ADR-0009 needs an amendment PR once Tiffany confirms §9.
**Tiffany's 2026-11-21 direction supersedes that on one point**: the baseline must be a **real,
recognizable screenshot-based desktop agent**, not a hand-rolled loop. So §1a evaluates the
recognizable options (Cua, UI-TARS/open-model stacks, frontier computer-use APIs) on setup effort,
cost per 30 trials, Windows ARM fit, and credibility — and picks one primary. §1b keeps the
harness/generalisation contract G1–G7 against whichever is chosen.

This document covers:

1. **§1a — the option evaluation and the recommendation** (Tiffany's question);
2. the harness that makes the comparison fair (§2–§3) and the generalisation contract (§1b);
3. the metrics, measured identically on both sides and aligned with M1-013's 30-trial sweep (§4);
4. the fairness rules that distinguish "the screenshot agent lost" from "we handicapped it" (§5);
5. cost per 30 trials for every option (§8), with arithmetic shown.

It deliberately chooses nothing that costs money. §9 is the escalation the outer loop owns.

---

## 1a. Which screenshot agent? (Tiffany's question, 2026-11-21)

**The ruling answer first.** The baseline should be **Cua (`trycua/cua`) — specifically Cua Driver
as the computer layer, driven by an agent harness with a model we already pay for — pointed at a
guest we control.** It is a real, recognizable open-source computer-use framework (32.7k stars,
MIT, pushed 2026-11-21), it ships a **Windows ARM64** build, it runs **inside the guest** and is
reached **over SSH**, which is exactly Myco's control-plane shape, and it covers the LibreOffice
case structurally. Every claim below is from primary sources dated 2026-11-21; nothing was run.

### The three axes that decide it

**Axis 1 — transport.** M1's guest is a UTM Windows 11 ARM64 VM reachable over SSH on
`localhost:2222` with an interactive auto-logon desktop. A baseline that needs a VNC/RDP-only path
or a vendor-managed VM would either change the conditions or need a second environment. Cua's
Windows-over-SSH design is the same shape as Myco's:

> "Windows OpenSSH runs in Session 0, which has no desktop, so window tools return empty results
> there. … Run the daemon in your interactive session and let the SSH side proxy to it over the
> named pipe: Session 1+ (RDP or console) `cua-driver serve` (autostart task) → `\\.\pipe\cua-driver`
> → Session 0 (SSH) `cua-driver call` / `cua-driver mcp --socket \\.\pipe\cua-driver`."
> — Cua docs, *Run in a VM, over SSH, or in a sandbox*

That is the identical **session-0 problem** Myco solved for `myco-agent` (coordination log 16), and
Cua solves it the same way: an autostart interactive-session daemon plus an SSH-side client over a
local IPC channel. So once the daemon exists, Cua needs **no VNC and no RDP**: `ssh -T myco-win11 cua-driver mcp
--socket \\.\pipe\cua-driver`. On the guest the daemon runs in session 1 (owned by the same Windows
account — the pipe is ACL'd to that account, and `cua-driver status` reports a SID mismatch rather
than acting).

**Two qualifications, because they are the ones that could sink the setup and Cua's own page states
them plainly:**

- **The install is not headless.** "From RDP or the local console, register and start the task:
  `cua-driver autostart enable`, `cua-driver autostart kick`", and "Do initial consent and GUI
  checks in the VM display, not over SSH." So the first install needs the UTM console *once*; a
  human or a GUI-automation step opens the window, and from then on SSH + pipe is enough. The VM's
  auto-logon desktop makes this very likely to be a one-off, but it is **UNVERIFIED** until the
  spike runs, and it is the first thing the spike checks.
- **"No RDP needed" holds only after a session has existed.** Cua requires `query session` to show
  the user `Active` or `Disc`, and says to sign in once if you never have. Auto-logon on a cold boot
  should satisfy this; the spike asserts it via `query session` rather than assuming it.

**Axis 2 — Windows ARM64.** Three independent primary sources agree:

| Evidence | Source |
|---|---|
| Published release asset `cua-driver-rs-0.56.4-windows-arm64.zip` (**30.3 MB**) alongside `-windows-x86_64` and a `win_arm64` wheel | GitHub release `cua-driver-rs-v0.56.4` (flagged **prerelease** by the publisher — pin the exact tag, and re-check when a stable tag lands) |
| Windows support is **"Supported"** (not experimental): Win32, UI Automation, native input, window messages; coverage Electron/Tauri/WPF/WinUI3/WebView2 | Cua docs, *Platform support* |
| Accepted Windows/Win32 baseline: run `29257963004`, **122/122 rows, 99 delivered, 23 exact refusals** — note this is Cua's fixture catalog on x64 Windows, so it is app-and-API evidence, **not ARM64 evidence** | `libs/cua-driver/docs/action-support.md` |
| `ghcr.io/trycua/windows:11` image is `arch: [amd64, arm64]`: "On an Apple silicon Mac it is ARM64 Windows at full speed" | `libs/images/sandbox-images.json` |

The Windows ledger is the honest caveat: the proven fixtures are WPF, WinUI3 and WebView2 — **not
LibreOffice**. Cua's own Windows runner says it "intentionally skips optional external-app suites
such as LibreOffice because those require extra software on the environment image". LibreOffice has
no native UIA (only a lossy MSAA→UIA proxy, `docs/research/adapters.md` §4.5), so the driver will
land on its **pixel/UIA-hit-test rung** rather than the verified element rung. That is fine — it is
what a screenshot agent is — but it must be *reported*, not assumed.

**Axis 3 — credibility.** This is the part that decides against my earlier proposal. Cua Driver is
not "screenshot-only": `get_window_state` returns the accessibility tree **and** a screenshot in
one call, and every input tool names an exact target, with a background-first action ladder
(element → pixel → page → foreground) that reports `confirmed | unverifiable | suspected_noop |
partial | refused`. An agent can therefore choose the element rung for Calc's grid, which a
pure-pixel screenshot agent cannot. If the baseline is *meant* to represent the state of the art,
that is the state of the art; **rigging it to pixels-only would be a weak baseline**, which
Tiffany ruled out.

That creates an unavoidable definitional issue, stated plainly: **with Cua the "screenshot agent"
may beat Myco on reliability**, because it is a structural-accessibility agent with an LLM planner.
That is a legitimate result and the report must be able to say it. To keep the comparison *about*
M1's thesis, the Cua arm runs **twice**, as two labelled sub-arms, and both are reported:

- **C1 — Cua Driver, pixel rung only** (`element_token` addressing disabled; coordinates from
  screenshots). This is the honest "screenshot agent" for row 7.
- **C2 — Cua Driver, full ladder.** Represents the best available computer-use framework. If Myco
  loses to C2, we publish that and the differentiation moves to UNO-class persistence verification,
  recovery, and evidence (M1-014), which is exactly where §7 predicts the gap.

Same harness, same tasks, same judge; only the addressing mode differs, and it is recorded per
trial. Two labelled arms cost the same as one run plus a third of the time, not a second project.

**How C1 can and cannot be read — the honest limit.** Cua's accepted Windows evidence (122/122)
exercises the *element* route on WPF/WinUI3/WebView2. C1 disables exactly that route and drives
pixels into a Calc grid the repo already knows refuses UIA (`uia_cell found:false`, M1-008). So:

- if C1 **succeeds**, it is a genuine screenshot-agent result and strengthens the baseline;
- if C1 **fails or refuses**, the cause is ambiguous — "screenshot agents cannot do this" versus
  "Cua's pixel route was never proven for this app". The report must attribute the cause from the
  spike (which tests both rungs on Calc *before* the 30 trials) and score a refusal as
  `refused: <code>`, never silently as a loss.

Third column for completeness: Myco itself reads the UIA tree, so the three columns are C1
(pixels only), C2 (tree + pixels), Myco (tree only, verified through UNO). The report names all
three rather than implying the C1–Myco delta is the whole thesis.

### Option comparison

Setup effort is in engineer-days (≈) for one person who knows the repo but not the tool. Cost is
model spend for 30 trials at the §8.1 token budget; "free" means $0 marginal.

| | **(a) Cua Driver + our model** | **(b) UI-TARS / open-model stack** | **(c) Frontier CUA API** |
|---|---|---|---|
| What it is | Rust driver (UIA + pixels), MCP/CLI, agent harness runs the loop | UI-TARS-1.5-7B (or a GGUF quant) as grounder+planner in a loop; Agent-S3 (`gui-agents`) optional | Vendor-hosted model with a native `computer` tool; client executes actions |
| Windows ARM64 | **Yes** — `windows-arm64` release asset; Windows marked *Supported* | Model is arch-agnostic; the *loop* is ours | Client-side, so arm64 is our problem; vendor references ship Linux containers |
| Drives myco-win11 over SSH | **Yes, natively** — `serve` in session 1 + `mcp --socket \\.\pipe\cua-driver` over `ssh -T` | Yes, but only via Myco's own agent ops — i.e. we build the transport | Yes, same as (b): we build the transport |
| VNC needed | **No** | No | No (reference impl uses Docker/vnc for Linux) |
| Credibility as "a real screenshot agent" | **High** — 32.7k stars, MIT, 122/122 Windows action rows, active today | **Medium-high** — the model is the published SOTA grounder; the loop would be ours | **Highest** — the actual commercial state of the art |
| "Homemade" objection | Low: framework is theirs, only the task wiring is ours | **High**: we write the loop, so we own the result | Low |
| Setup | **~2–4 d**: install arm64 driver in guest **from the VM console once** (Cua's own docs require `autostart enable` from an interactive session, not SSH), autostart task + named pipe, MCP client on host, Calc task wiring, C1/C2 mode switch | **~3–6 d**: Ollama GGUF serve, grounding parse, loop, transport ops | **~3–5 d**: transport ops + vendor client + prompt/tool wiring + key management |
| Model spend / 30 trials | **$0** with the local Ollama planner; **$0.06–$0.46** with Claude Haiku 5.5 (the §8.4 table, one arithmetic run) | **$0** (all local) | **$0.06–$36.92** across the frontier models in §8.4 — the low end is `gpt-6-luna`, the ceiling is `gpt-6.2-astra` with its toolset overhead |
| Account needed | **None** for the local path | **None** | **Yes** — API key + billing |
| Biggest risk | LibreOffice is unproven in Cua's Windows ledger | Our loop becomes the weak link, and the report is open to "you built a bad agent" | Credibility bought with money and vendor data handling |
| Fair for row 7? | **Yes** (C1 as the screenshot arm, C2 as the SOTA arm) | Yes, but weakest read: risk of *understating* the baseline | Yes — but it is the most expensive way to learn that |

### Recommendation

**Primary: (a) Cua Driver.** Reasons, in order:

1. **It is a recognizable agent, not our code.** The framework, the action model, the refusals and
   the verification ladder are Cua's and are published. Only the task wiring is ours — the same
   amount of glue any integrator writes.
2. **The transport is already solved in the shape we have.** Its Windows-over-SSH named-pipe design
   is the session-0 fix Myco itself needed; no VNC, no RDP, no second VM, no change to
   `myco-win11`.
3. **It fits ARM64 by release artifact**, not by hope: a `windows-arm64` build of the current driver
   plus a proved Windows action ledger.
4. **It can be free.** With a local planner it costs $0 marginal, and the harness/model choice stays
   with Tiffany (§9) because the planner is swappable through MCP — that is the point of Cua being a
   tool layer rather than a model.
5. **It converts the "credibility" question into a reportable one.** C1 vs C2 vs Myco gives three
   columns instead of an argument about whether the baseline was fair.

**Runner-up: (b) UI-TARS on Ollama** — use only if Cua cannot drive Calc at all (see the first gate
below). It keeps the $0 property but moves the credibility problem onto our loop.

**Not recommended as primary: (c) frontier API.** It buys the strongest baseline with money and an
account, and its references ship as Linux Docker containers, so the Windows half is still ours to
build. It stays on the table as a *third* column if Tiffany wants the strongest possible number and
has a budget (§9 item 6).

### The one gate that can overturn the recommendation

Cua's Windows ledger does not include LibreOffice, and Calc's grid is the one control the repo
already knows is hostile to UIA (`uia_cell found:false`, M1-008). So M1-021 starts with a
**spike**: driver installed in the guest, `get_window_state` on a Calc window, one typed cell
edit through both the element and pixel rungs, evidence captured. Outcome decides:

| Spike result | Consequence |
|---|---|
| Element **and** pixel rungs both type into a Calc cell | Proceed: C1 (pixel-only) and C2 (full ladder) both run |
| Only the pixel rung works | Proceed: it *is* a screenshot agent; C1 and C2 coincide, report says so |
| Neither works | Fall back to (b) UI-TARS with our loop, and report the spike as the reason |

This spike needs the VM, so it runs **after** the sweep frees the host (Coordinator's schedule), and
it is the first thing in M1-021's queue.

---

## 2. Conditions that must be identical

"Identical tasks, initial states, and model settings" is the acceptance wording. Concretely, both
arms must share all of the following. Anything that differs is a documented deviation (§3.5).

| Condition | How it is held constant |
|---|---|
| Task family and parameters | The sweep's final 30 parameter sets, copied verbatim into the baseline run (§4.4a) — same `{fixtureSeed,rowKey,column,newValue}` per trial. The generator that produced them (`generateParameterSets`, `src/tasks/intent.ts`) is the family definition; the *list used* is data, recorded with its hash in both reports. |
| Initial state | Per-trial reset from `clean-base` via `scripts/reset-trial-vm.sh` (cold disk restore), identical for both arms. Reset wall time recorded per trial. |
| Fixture file | Host-generated CSV → guest `.xlsx` by `WindowsFixtureConverter` (isolated throwaway profile). The **same fixture bytes** for trial *i* in both arms: the baseline gets fixture *i*, not a re-generated one. |
| Guest software | Same VM, same LibreOffice 26.8.3 ARM64, same Windows build. No LibreOffice settings are changed for either arm (AutoCorrect stays on — see §3.4). |
| Desktop geometry | Both arms run at the same display resolution; the baseline's `--grounding_width/height` equal the captured screenshot size. Resolution recorded. |
| Agent isolation | One trial per guest state, no concurrent sessions. After either arm's trial: cleanup + reset before the next trial (M1-019 semantics). |
| Trial order | The Myco arm's 30 trials must come from the M1-013 sweep. **As of 2026-11-21 that artefact does not exist**: `/tmp/m1-013/sweep/` holds only `progress.log` (trial 0 in flight) and an empty `runs/`; the prior attempts are classified host-sleep and external-interference aborts and are never counted. The join in §4.4 is therefore **contingent on the sweep completing and the Coordinator declaring it final**; nothing in this doc presumes a sweep number. The baseline arm runs **the same parameter sets, in the same order**, as the sweep's final parameter list — not a re-derived index (§4.4a). |
| Attempts | One attempt per trial. A retry is a new trial row, not a hidden re-run. |

**Ordering of the two arms.** The baseline arm runs *after* the Myco arm produces its 30-trial
result, on the same VM, because M1-013 owns the host first. If the Myco sweep is re-run (e.g. a
reset defect invalidates it), the baseline arm re-runs as well — mixing a baseline run against a
different VM state with a different Myco run would void the comparison.

---

## 3. Harness

### 3.1 Placement and transport

With Cua as the primary (§1a) the transport is **Cua Driver's own**, which removes the option
analysis the earlier draft carried. Two processes, one channel:

```
macOS host                          Windows guest (myco-win11, session 1)
┌────────────────────────────┐      ┌──────────────────────────────────────────┐
│ agent harness (ours)       │      │ cua-driver serve   (autostart task,      │
│  ├ planner model (Ollama   │      │   session 1)  ── owns desktop,            │
│  │   or vendored API)      │      │   observation, input, refusals           │
│  ├ MCP client → ssh -T ────┼─────►│                                          │
│  │   cua-driver mcp        │      │ \\.\pipe\cua-driver  (ACL'd to the        │
│  │   --socket \\.\pipe\…   │      │   same Windows account; SID-checked)     │
│  └ judge: UNO + file parse │      │ LibreOffice Calc 26.8.3 ARM64            │
│      (unchanged, host-side)│      └──────────────────────────────────────────┘
└────────────────────────────┘
```

- **No VNC and no RDP.** SSH carries MCP; the named pipe carries the desktop session. This is the
  same session-0 fix Myco's own agent uses (coordination log 16), which is why the fit is good.
- **The judge does not move.** Verdicts still come from `unoVerifierOverAgent` + the persisted-file
  parse on the host (ADR-0002/ADR-0005); Cua's own `verified` field (accessibility read-back only)
  is **never** the verdict. It is recorded as a per-action observation in the transcript.
- **C1 (pixel-only) is enforced by an MCP allowlist**, not by trust: Cua's documented
  `cua-mcp-filter` hides tools and rewrites `get_window_state` to text-only
  (`--text-only`) where needed; for C1 the harness additionally passes no `element_token` and acts
  only by `x, y` from `get_desktop_state`/screenshot, with a CI test asserting the C1 transcript
  contains zero element-addressed actions (§3.6).
- **What the baseline must not do.** It gets no UNO, no file access, no `calc-record-edit` program,
  and no access to the trial's `.xlsx` by path. Both C1 and C2 are held to that; C2 is allowed the
  accessibility tree because that is what the framework *is*.
- **Fallback (b)**, if the §1a spike fails: an in-guest PyAutoGUI runner driven through the existing
  `launch` op, or new typed agent ops — the analysis below still applies and is kept for that case.

#### Fallback transport (option (b) only)

The agent's op union is exactly ten ops — `ping`, `session_info`, `launch`, `uia_tree`,
`uia_invoke`, `screenshot`, `read_file`, `write_file`, `kill`, `uno_eval`
(`src/win/agent-client.ts:19-29`):
- **No coordinate-only click exists.** Clicks are UIA-only: `uia_invoke` needs a `runtime_id` that
  came from `uia_tree` (`agent/myco_agent/ops.py:30-43`), and the backend clicks that control.
- **A raw keystroke channel does exist**: `uia_invoke` with `action: "keys"` sends an arbitrary
  SendKeys string (`windows_backend.py:515-519` — `auto.SendKeys(keys)` after `control.SetFocus()`),
  but it requires a UIA-resolved `runtime_id`, i.e. `uia_tree`, which §5 rule 5 forbids the baseline from
  using to locate a target.

So the fallback needs coordinate input, via an in-guest PyAutoGUI runner (PyAutoGUI is the
reference synthetic-input path — `pyautogui==0.9.54` in UFO's pinned requirements,
`docs/research/adapters.md:153-160` — but **not** in the guest image today, `docs/env/windows.md:481`)
or new typed agent ops.
- **Isolation discipline.** The baseline driver must not import anything from `src/tasks/`
  except the *parameter generator and ground truth* (host-side, never guest state). It must not
  call `WindowsCalcAdapter`, `unoVerifierOverAgent`'s live-read, or any guarded program. This is
  enforced by a unit test on the import graph (§3.6), not by review.

### 3.2 The loop

```
for trialIndex in 0..29:
  reset(prep) ─► deploy agent ─► place fixture_i in the guest (known path + known window title)
  planner.reset(instruction_i)
  t0 = now
  for step in 0..MAX_STEPS:                     # MAX_STEPS = 30 (recorded per trial)
      shot = agent.screenshot()
      action = planner.act(instruction_i, shot, history)    # text only
      if action needs grounding: point = grounder(shot, action.target)
      transport.execute(action)                 # click / type / key / scroll
      history.push(action)
      if planner said "done": break
  close the document via the UI (Ctrl+W, discard if prompted) — or force-kill Calc if it will
  not close, recorded as such (§3.4)
  t1 = now
  verdict = verifier(fixture_i path, intent_i)  # identical to Myco's UnoVerifier + file parse
```

There is **no recovery, retry, or replanning that Myco does not also get**. The comparison is
screenshot-agent-as-shipped versus Myco, so the baseline's step budget must be generous enough
that a loss is a loss of capability, not of budget: 30 steps is ~1 step per UI element touched in
the guarded program (open/locate/set/save/close is 5 actions) times six. Recorded and reported.

**The budgets are not symmetric and that is a deviation, not a neutral choice.** Myco's program is
a fixed 5 guarded steps (`src/tasks/calc-record-edit.ts` `programFor()`), and the runner has no
step-budget concept at all (`grep -rn 'MAX_STEPS\|maxSteps\|stepBudget' src/` is empty). The
baseline gets 30. The generous direction is deliberate — a capped baseline is a straw man — but it
goes in the deviations register (§3.5), and `steps` is reported per arm only, never as a
side-by-side "fewer is better" column (§4.2, where per-arm step counts are reported).

**Budget exhaustion is `refuted`, and cause is attributed first.** If the loop runs out of steps
the trial is `refuted` with `reason: step-budget`. The one collision with §3.3's dead-app row is
a baseline that killed Calc by its own budget actions: the harness attributes cause (our driver
acted → `refuted`/`step-budget`) before applying the "could not look" rule, so a dead Calc is
`uncertain` only when the baseline did **not** cause the death.

### 3.3 Verification, shared with Myco

Verdict comes from `unoVerifierOverAgent` + the persisted-file parse, on host-side ground truth
`groundTruth(params_i)` (ADR-0002, ADR-0005). Nothing in the screenshot agent's transcript feeds
the verdict. This is the only way the two arms are comparable: both are scored by a judge that
does not know who acted.

Edge case for the baseline, because it can leave the app in states Myco never does:

| Observed guest state at scoring time | Verdict | Why |
|---|---|---|
| Document closed, file parses, cell == expected | `verified` | intent satisfied and persisted |
| Document closed, file parses, cell != expected | `refuted` | intent not satisfied |
| Document open but UNO reports `isModified() == true` | `refuted` | the agent believed it saved; it did not. This is the OpenAdapt failure mode |
| Document open, unmodified, file parses | scored from the file | equivalent to closed |
| Calc dead / UNO unreachable / no file, **not caused by the driver** | `uncertain` | could not look (ADR-0002) — **not** `refuted` |
| Calc dead **because the driver's own action killed it** (budget exhaustion, a destructive click) | `refuted` with `reason: step-budget` \| `driver-action` | cause is attributed before the could-not-look rule (§3.2) — we broke it, so it is our failure, not an unobservable state |
| Dialog blocking the app at timeout | `refuted` after the close attempt | the agent left the app in a state that did not persist the edit; recorded with the dialog text |

A save-dialog or overwrite prompt left on screen is a *baseline* failure, not a harness error: no
part of either arm is allowed to click it for the agent.

### 3.4 AutoCorrect and other app-level traps

AutoCorrect sentence-cased a lowercase test value and produced a legitimate `refuted` during
M1-013 (log 21). The generator is now AutoCorrect-immune (PR #21, 20/20 guest-side proof), so the
shared parameter sets already sidestep that trap for **both** arms. No arm gets the setting
changed or disabled, because M1 asks about the app as installed.

### 3.5 Deviations register

Anything that cannot be held identical is recorded here per trial, not left to prose. Initial
entries (to be kept current in the report):

| Deviation | Both arms? | Mitigation |
|---|---|---|
| Baseline uses a host-side driver; Myco uses its runtime | by design | scoring judge is shared and blind |
| Baseline may need a PyAutoGUI runner in the guest | baseline only | runs through the reviewed `launch` op; no UIA/UNO |
| **Step budget is asymmetric**: baseline 30 model actions, Myco a fixed 5-step program with no budget concept in the runner | by construction | generous direction, stated in §3.2;  `steps` never compared side by side (§4.2 reports it per arm) |
| **Reset hygiene may differ in practice**: the baseline gets a scripted `clean-base` cold restore; the Myco rows inherit whatever the sweep did, including degraded resets under load | both intend identical, neither guaranteed | `resetMs` + AC/battery state recorded per row; a row whose `resetMs` exceeds 2× the 152 s measured maximum (log 39) is flagged and the comparison table reports how many were flagged |
| Screenshot capture is GDI window-capture, not full-desktop | both capture, baseline-only consumer | same op, same rect policy |
| VM reset cost differs by time of day (cold restore 134–152 s measured, log 39) | both | reset timing is a metric, not a deviation |
| Host load changes task wall time | both | host load + battery state recorded from `pmset` |

### 3.6 What the baseline harness must prove in CI (host-side, no VM)

- Import-graph test: the baseline driver cannot reach `WindowsCalcAdapter`, `runTrial`, or
  `unoVerifierOverAgent`'s live read. A deliberate import must fail the test.
- Verdict test: a fake transcript ending "done" with a wrong persisted value yields `refuted`; a
  transcript ending "sorry" with the right persisted value yields `verified` (the judge is blind
  to the agent's claims, in both directions).
- Step-budget test: exceeding `MAX_STEPS` ends the trial as `refuted` with `reason:
  step-budget`, never `uncertain`; and a trial where the driver's own action killed Calc is
  attributed `refuted`/`step-budget`, while a Calc that died for an unrelated reason is
  `uncertain` (§3.2).
- False-success test: an audit that throws yields `falseSuccess: null`, **not** `false` — an
  unaudited `verified` must never read as a pass (§4).
- Cost accounting test: token counts from the stub HTTP clients are summed per trial and land in
  the row.
- **C1 purity test** (§1a): a C1 transcript contains **zero** element-addressed actions — every
  input tool call carries `x, y` and no `element_token`. The MCP allowlist alone is not trusted;
  the transcript is asserted.
- **Cua version pin test**: the guest driver version reported by `cua-driver --version` and the
  host-side client version must match, and both are stamped into every row (§6). Cua's Windows
  lane explicitly requires "that `cua-driver --version` matches over SSH" — a mismatch is a
  real failure mode, not a theoretical one.
- **Session-identity test**: `cua-driver status` must report the pipe reachable and the SID match
  before trial 0; otherwise the trial aborts `uncertain`/`driver-unreachable` rather than acting
  from session 0 (the exact Myco bug from log 16, in Cua's vocabulary).

---

## 4. Metrics

Every row of `baseline/trials/<arm>/<index>.json` carries the same schema for both arms, so the
side-by-side table is a join, not a manual reconciliation.

```jsonc
{
  "arm": "myco" | "screenshot",
  "index": 0,                       // 0..29, index into generateParameterSets(SEEDS)
  "params": { "fixtureSeed": "…", "rowKey": "EMP-0038", "column": "name", "newValue": "…" },
  "cellRef": "B39",
  "expected": "REVISED-…",
  "previousValue": "Cleo Larsen",
  "verdict": "verified" | "refuted" | "uncertain",
  "verdictReason": "…",
  "falseSuccess": false,            // boolean | null — see below
  "audited": true,                  // false when the independent audit could not run
  "elapsedMs": 34_300,              // task wall time: fixture present → scoring time
  "steps": 5,                       // Myco: program steps; baseline: model actions
  "modelCalls": 5,                  // baseline only
  "tokens": { "in": 0, "out": 0 },  // baseline only
  "resetMs": 140_000,               // per-trial reset, both arms
  "resumed": false,                 // the app or harness was interrupted and resumed
  "recoveryEvents": 0,
  "hostLoad": { "battery": "AC", "loadAvg1": 2.1 },
  "deviations": []
}
```

**`falseSuccess` is tri-state, not boolean.** The driver's `independentValuePresent` is
`boolean | null`: `null` when the audit conversion throws (`/tmp/m1-013/trial-one.ts`, the
`catch` around the headless re-convert) or when the row is a harness error. Collapsing `null` to
`false` would record an **unaudited `verified`** as a clean pass, which is precisely the silent
success the whole milestone is about. So:

| `verdict` | `independentValuePresent` | `falseSuccess` |
|---|---|---|
| `verified` | `true` | `false` |
| `verified` | `false` | **`true`** |
| `verified` | `null` | `null` — **not a pass** |
| `refuted` / `uncertain` | any | `false` |

An unaudited `verified` is counted in its own metric row (§4.1) and must be **0 for both arms**.
If it is non-zero, the trial is re-run — the defect is in the audit, not in either agent, and the
row is never quietly folded into the pass rate.

### 4.1 Primary metrics (the comparison table)

| Metric | Definition | M1 target |
|---|---|---|
| **Pass rate** | `verified / 30` | Myco ≥ 27/30 (row 3) |
| **False successes** | rows with `falseSuccess === true` | 0 |
| **Unaudited `verified`** | rows with `verdict === verified && falseSuccess === null` | 0, both arms |
| **Time per trial** | median and p95 of `elapsedMs` | reported, no target |
| **Recovery** | rows with `resumed: true` that ended `verified` | Myco: interruption + invalid target both recovered |

### 4.2 Secondary metrics

- `refuted` / `uncertain` split, with reason classes (wrong value / unsaved / dialog / dead app /
  harness).
- Cost per 30 trials in model calls, tokens, and dollars (§8) — a first-class part of the baseline
  claim, because "Myco is more expensive" is the obvious objection to verified execution.
- Steps per trial and wasted steps after the edit actually landed (a screenshot agent that keeps
  clicking after success burns tokens without changing the verdict).
- Screenshot count per trial (the baseline's observation cost).

### 4.3 What is NOT a metric

Myco emits step-level verification (per-action pre/postconditions). The baseline cannot. Reporting
"checks passed" side by side would compare a capability to its absence, so it is left out of the
table and cited in prose only.

### 4.4 Alignment with M1-013

The Myco arm of the table **is** the M1-013 sweep's JSONL, not a re-run — once that artefact
exists and the Coordinator declares the sweep final (§2, trial order). Field map:

| M1-013 sweep JSONL field | Comparison row field |
|---|---|
| `index`, `runId` | `index` |
| `rowKey`, `column`, `typed`, `cellRef`, `expected` | `params`, `cellRef`, `expected` |
| `verdict`, `verdictReason` | `verdict`, `verdictReason` |
| `independentValuePresent`, `auditError` | `falseSuccess` (tri-state, §4 above) and `audited` |
| `elapsedMs`, `completed` | `elapsedMs` |
| — (**not** in the sweep JSONL) | `params.fixtureSeed` — read from that row's `runs/<runId>/result.json` → `taskParams` (§4.4a) |
| — | `steps`, `modelCalls`, `tokens` are baseline-only and left `null` for Myco rows |

The sweep's `falseSuccess` is `verified && independentValuePresent === false`; the comparison
loses nothing by using the same predicate, and gains the tri-state `null` the sweep's boolean
collapses. The baseline's row is produced by the same predicate against the same independent audit
(the driver's headless re-convert), so neither arm can be excused by a different definition of
success. If the sweep is invalidated and re-run, the comparison is regenerated, never patched.

### 4.4a The parameter list is data, not an index

An earlier draft said "same index → same parameter set". **That is not achievable from the current
in-repo entrypoint** and the assumption is retracted:

- `generateParameterSets(seeds)[i]` cycles the column by index — `DATA_COLUMNS[i % 4]` — so set
  *i* is `name`, `qty`, `joined`, `salary` by turn (`src/tasks/intent.ts:117-141`).
- But `src/integration/run-live.ts:51-57` always takes `generateParameterSets([seed])[0]`, i.e.
  **set 0, column `name`**, whatever `i` the sweep thinks it is running. The sweep driver that
  actually ran (`/tmp/m1-013/trial-one.ts`) instead built 30 sets from
  `SEEDS = [m1-013-live, seed-b … seed-f]` and indexed that array — a *third* list, neither of the
  above.
- Runbook §7.3 flags the same defect for the `--seed` form.

So there is no single canonical "index". The comparison therefore treats the **sweep's final
parameter list as the input**. The authoritative source per trial is
`runs/<runId>/result.json` → `taskParams` (`src/integration/trial.ts:152`, written for every trial
including refuted and uncertain ones, `src/core/evidence.ts:31`) — it carries the full
`{fixtureSeed, rowKey, column, newValue}` set, which `groundTruth()` requires and which the sweep's
summary JSONL omits (`/tmp/m1-013/trial-one.ts`'s row has `rowKey/column/typed/cellRef/expected`
but no `fixtureSeed`; `/tmp/m1-013/params.json` is currently empty). So:

1. take each sweep row's `runId` from the JSONL,
2. read `taskParams` from that row's `runs/<runId>/result.json`,
3. write the resulting 30-entry list to `baseline/params.json` with a SHA-256, and run the
   baseline against that file.

If a sweep row has no `runId` or no `result.json` (harness failure before evidence), that trial has
no baseline counterpart and is reported as `no-parameter-set` in both columns — never silently
dropped. The baseline runs those exact sets, in that exact order. If the list covers only `name`,
the report says so; the baseline does **not** substitute a broader list to look thorough. If the
Coordinator instead re-runs the sweep through a fixed in-repo entrypoint, the list is whatever that
entrypoint emits, recorded by hash in both reports.

---

## 5. Fairness rules

The point of a baseline is to lose for the right reason. These are constraints on us:

1. **Same judge, blind.** Verdict never reads the agent's own claims (§3.3). Both arms go through
   one verifier call site.
2. **Same fixture bytes, same intent, same list.** No re-generation of a fixture for the second
   arm "because the first one was awkward". The parameter list is copied from the sweep's final
   output (§4.4a), not re-derived from an index that three different code paths disagree about.
3. **No prompt engineering after a trial.** Prompts are frozen before trial 0 and hashed into the
   report. A prompt written after seeing trial failures turns the baseline into a straw man.
4. **No retries, no step-budget stretching mid-run.** A step budget set before trial 0; a raised
   budget after a loss is a deviation entry and a re-run of all 30.
5. **The baseline gets what a screenshot agent gets — and C2's extra is declared, not hidden.**
   Both sub-arms receive the task instruction, screenshots, and their own action history. Neither
   receives: the cell address resolved by Myco's adapter, the UNO tree, the `.xlsx` by path, or the
   trial's ground truth. **C2 additionally receives the accessibility tree** — because the point of
   C2 is to measure the best available framework, and withholding it would be rigging. C1 is
   enforced mechanically (no `element_token` in the transcript, §3.6), so the screenshot-only claim
   is a test result, not a promise. (Resolving the cell *is part of the task* in both sub-arms.)
6. **No model shopping after the fact.** The planner and grounder are chosen before trial 0; the
   report names them with versions. A second model pair is a second reported arm, not a replacement.
7. **Host conditions are the same and disclosed.** Both arms record reset time, host load, and
   battery/AC state. A baseline run on a contended Mac is not comparable to a quiet Myco run —
   log 30/41 show resets varying 45 s → 1879 s under load, so this is a real hazard.
8. **Honest count.** No re-runs to reach a better number; every started trial is a row, including
   harness failures (recorded as such, and excluded from the pass rate but listed).
9. **The baseline may win.** If the screenshot agent passes 30/30, the report says so. The
   measured claim then moves to time, cost, false successes under corruption, and recovery — the
   M1-014 corrupted suite is where the difference is expected to appear, and the baseline should
   be run against a subset of corrupted trials too (§7).

---

## 6. Determinism and reproducibility

- Temperature 0 for both planner and grounder where the endpoint honours it; the seed recorded.
  Ollama honours `seed` + `temperature: 0` for local models; a hosted endpoint that does not is a
  deviation entry.
- The report embeds: model ids + versions, prompt hashes, `MAX_STEPS`, grounding width/height,
  the reset snapshot name, VM UUID, LibreOffice version, and the parameter list hash.
- Every trial keeps its transcript (actions + screenshots + model responses) under
  `baseline/transcripts/<arm>/<index>/`, so a disputed verdict can be re-adjudicated without
  re-running.

---

## 7. The corrupted-trial arm (scope, not commitment)

M1 row 4 needs ≥10 corrupted trials. Row 7 says "identical tasks"; the strongest reading of the
comparison is that the screenshot agent also faces interruption and invalid targets. Plan:

- **Minimum**: 10 corrupted trials, 4 classes (`kill-app`, `invalid-target`, `delayed-save`,
  `focus-change`), given to both arms. The baseline needs no special code — it just gets the same
  fault schedule.
- Expected outcome, stated as a prediction so the report can be honest about being wrong: the
  screenshot agent reports success on trials whose save failed while the screen said "Saved",
  i.e. the OpenAdapt 54/72 shape. A corruption that is invisible on screen is exactly where a
  screenshot agent cannot self-detect, and exactly where Myco's UNO check is decisive.
- Cost: this arm is where the baseline's model spend multiplies. It is priced separately in §8.

This section is **not** committed scope for M1-015; it is what M1-014 should include if Tiffany
wants the comparison to cover row 4 too.

---

## 8. Candidate models and estimated cost per 30 trials

**No paid model is selected here; §9 escalates it.** The estimates are arithmetic over **published
vendor prices read on 2026-11-21** (§12) or locally measured figures, with every assumption stated.
Where a number cannot be established it is marked `unknown`, not guessed.

Cua changes what "the model" means: Cua Driver is the *computer layer*, so the cost question is now
"which planner model drives Cua", and the same numbers apply to option (b)'s loop. §8.4 prices the
three concrete configurations named in §1a.

### 8.1 What actually drives cost

Per trial, on the Myco task family:

| Component | Count per trial | Note |
|---|---|---|
| Planner calls | ≈ 5–8 | one per UI action; Myco's guarded program is 5 actions, a screenshot agent typically takes more (open, wait for load, locate, click name box, type address, click cell, type value, Ctrl+S, close ≈ 9–12) |
| Grounder calls | ≈ 2–5 | one per click/keypress needing a target; the edit is mostly typed into a known cell, so few |
| Image tokens per call | large | 1280×800 screenshot. At the common ~1 image-token per 28×28 patch rule: (1280/28)×(800/28) ≈ 46×29 ≈ **1330 tokens**; a UI-tuned model with a finer patch (14 px) is ~5300. History re-sends add a fraction of this |
| Text tokens | small | instruction + history, ≈ 200–800 per call |

So a trial is roughly **8–14 calls × (1.3–5.3k image tokens + ~0.5k text)** ≈ **15k–80k input
tokens** and **0.3k–1.5k output tokens**. Use 30k in / 0.8k out per trial as the central estimate
and 80k / 1.5k as the pessimistic one. **30 trials ≈ 0.44M–2.5M input, 25k–45k output**
(recomputed: 8 calls × 1834 ≈ 14.7k; 14 calls × 5836 ≈ 81.7k; × 30 = 0.44M / 2.45M).

### 8.2 Shortlist

Legend: **Local** = runs on this Mac, no account, no marginal cost. **Free-tier** = no account
needed today, but rate-limited. **Paid** = needs credits/account → §9 only.

| # | Planner | Grounder | Where it runs | Vision evidence | Cost per 30 trials | Verdict |
|---|---|---|---|---|---|---|
| **A** | `qwen3.8-uncensored` (9.2B, **installed**, `vision` capability) | same model, grounding-only prompt | Local Ollama, this Mac | **2/4 on cell grounding in the measured test (§3.8)**; fails as a grounder | $0 marginal; ~9.4 GB RSS + ~9 GB model load during a run | **Do not use as the grounder.** Usable as the *planner* in a CPU-only fallback |
| **B** | ShowUI-2B as grounder + hand-rolled planner loop (replaces `gui-agents`) | ShowUI-2B (`showlab/ShowUI-2B`, MIT, 2B) | Local, needs a one-time download (~4 GB) + `pip install`; CPU-viable per eval-frameworks §3.5 | Not measured locally. It is a *grounding* model by design; eval-frameworks rates effort **low** | $0 marginal (download is not a purchase) | **Best local grounding path.** Needs the download authorised as non-commercial? No — weights are MIT, no account, no payment. Only disk and time |
| **C** | Local planner (installed `qwen3.8-uncensored`, bounded by A's limits) + **B** as grounder | UI-TARS-1.5-7B (`ByteDance-Seed/UI-TARS-1.5-7B`, apache-2.0, not gated) | Local, one-time ~15 GB download; needs GPU-friendly run (Ollama/llama.cpp) | UI-TARS was ADR-0009's grounder; not measured on this host | $0 marginal; ~7-8 GB load, competes with the 8 GB VM for RAM | **The fallback configuration, locally.** RAM is the risk: VM 8 GB + model 8 GB + Chrome on a 24 GB Mac already caused the pressure in log 15 |
| **D** | CheaperInference vision models (`deepseek-v4.1-flash`, `glm-5.3`) | same | CheaperInference cloud | **Unknown**: the catalog lists both as models but does not publish vision capability, and the codebase's only prior check returned a credits error (eval-frameworks §3.8). A vision-less planner cannot run this baseline at all | `unknown` — cannot be priced without a paid probe | **Needs a paid probe before it can be considered.** Not in the plan without Tiffany's approval |
| **E** | Hosted UI-TARS-1.5-7B | HF Inference Endpoint / similar | Hosted | The Agent-S README recommends it | `unknown`; a small dedicated endpoint is metered by GPU-hour, not per token | Escalation item (§9) |

Excluded by rule: **kimi-k3 and all `*:cloud` Ollama aliases** (banned on this project; also they
returned a credits error, i.e. paid). Also excluded as planners: **any general chat VLM as the
grounder** — that is measurement B in reverse, and §3.8 already shows it fails.

### 8.4 Priced configurations (Tiffany's three options)

**Every figure below is one arithmetic run over the stated budget**, so the numbers quoted in §1a,
here, and in backlog M1-015 are identical by construction. Prices are published list prices read
2026-11-21 (§12).

Inputs and assumptions:

- Input **0.44M–2.5M** and output **25k–45k** tokens per 30 trials (§8.1).
- Tool-definition overhead **≈4,500 input tokens per request** (Anthropic's
  `computer_toolset_20260801`; §12). At 8–14 requests per trial that is **1.08M–1.89M** extra
  input tokens on top of the budget. **It is applied to every row in the `high` column**, because a
  frontier computer-use loop declares a toolset whichever vendor serves it; the `low` column is the
  same model without the toolset (what a plain screenshot loop costs).
- No caching assumed. Prompt caching would cut both columns and is deliberately excluded, so these
  are upper bounds rather than optimised prices.

| Config | Plan (in / out, $ per MTok) | 30 trials, low (no toolset) | 30 trials, high (+toolset) |
|---|---|---|---|
| **Cua + local Ollama** (`qwen3.8-uncensored`) | 0 / 0 | **$0** | **$0** |
| **Cua + Claude Haiku 5.5** | 0.10 / 0.50 | $0.06 | $0.46 |
| **Cua + Claude Sonnet 5.5** | 2.00 / 10.00 | $1.13 | $9.23 |
| **Cua + Claude Opus 5.5** | 4.00 / 20.00 | $2.26 | $18.46 |
| **Frontier API, cheapest** (`gpt-6-luna`) | 0.10 / 0.50 | $0.06 | $0.46 |
| **Frontier API, mainstream** (`gpt-6.2-sol` / `gpt-6.1-sol`) | 2.00 / 10.00 | $1.13 | $9.23 |
| **Frontier API, strongest** (`gpt-6.2-astra`) | 8.00 / 40.00 | $4.52 | **$36.92** |
| **Frontier API, Gemini** (Gemini 3.1 Pro) | 2.00 / 12.00 | $1.18 | $9.32 |
| **UI-TARS local** (UI-TARS-1.5-7B) | 0 / 0 | **$0** | **$0** |

Worked example, Sonnet, `high`: `(2.5M + 1.89M) × $2/M + 45k × $10/M = $8.78 + $0.45 = $9.23`.
The same run without the toolset is `2.5M × $2/M + $0.45 = $5.45`.

**The honest summary.** The local path is **$0**. Every paid configuration is **single-digit dollars
per 30 trials** except the strongest frontier model, whose worst case is **$36.92** — still less
than an hour of anyone's time, and it is a price nobody has to pay because the recommended
configuration is free. Money is not the constraint on this baseline; VM time and credibility are.

### 8.3 Cost, stated plainly

- **The local rows (Cua + Ollama, UI-TARS) cost $0 in marginal spend.** They cost disk (4–20 GB), RAM during the run, and host
  time. On this Mac RAM is the binding constraint (log 15: Ollama at 9.1 GB + the VM at 8 GB
  starved the guest). A baseline run must therefore happen when the VM is the only heavy guest and
  the Mac is on AC power.
- **D and E stay `unknown` for a different reason than in the earlier draft.** The *token* cost is
  now priced (§8.4). What is unknown is whether CheaperInference's `deepseek-v4.1-flash`/`glm-5.3`
  accept images at all — the one prior check returned a credits error — and what a dedicated
  UI-TARS endpoint costs, since those are metered by GPU-hour and not published per token. Both are
  §9 items, and neither is needed if Cua + a local planner works.
- **Time is not $0 to the project.** A cold reset is 134–152 s (log 39) and a Myco trial is 35–90 s.
  A 30-trial baseline run is ≈ 1.5–2 h of VM time at Myco's step count, and a screenshot agent's
  higher step count pushes it toward 2.5–3 h. It is VM time the M1-013 sweep and M1-014 also need.

---

## 9. Escalation to the outer loop (Tiffany decides)

The recommendation in §1a is **Cua Driver with a local planner**: $0 marginal, no account, no
download beyond the driver itself (a 30.3 MB Windows ARM64 zip, MIT). It needs the following
decisions, and none of them is answered here:

1. **Install Cua Driver in the guest.** A third-party autostart daemon in the same interactive
   session as `myco-agent`, reached over a named pipe. No account, no payment, no licence fee — but
   it changes the guest the Myco arm also runs in, so it needs the environment owner's agreement and
   **must not happen while the M1-013 sweep is running**. This is the gate for everything else.
2. **Planner model.** Local Ollama (`qwen3.8-uncensored`, already installed) at $0, or a paid API
   planner (§8.4: $0.06–$0.46 for Haiku 5.5, $1.13–$9.23 for Sonnet 5.5, $2.26–$18.46 for Opus 5.5). If C2's element rung works on
   Calc, the weak local grounder matters much less, which favours $0.
3. **Whether to run C2 at all.** §1a proposes two labelled sub-arms (C1 pixel-only, C2 full ladder).
   C2 is what makes the comparison credible and also what could make Myco look worse. Tiffany's
   call; both are cheap, and dropping C2 weakens the baseline.
4. **VM time after the M1-013 sweep**: the §1a spike (~30 min: install, `get_window_state` on Calc,
   one typed edit through each rung) then 2–3 h for the arm, plus the same for the corrupted arm if
   §7 is in scope. Scheduling is the M1 Coordinator's.
5. **Frontier API as a third column** (`gpt-6.2-sol`/`gpt-6.2-astra`, Gemini 3.1 Pro): est.
   **$0.06–$36.92 per 30 trials** (§8.4: `gpt-6-luna` low, `gpt-6.2-astra` with toolset overhead
   high), but requires an API key, billing, and vendor data handling of
   screenshots from a synthetic fixture. Recommended *only* if Tiffany wants the strongest possible
   number and accepts the account.
6. **CheaperInference vision probe** (`deepseek-v4.1-flash`, `glm-5.3`): still unverified. A single
   minimal request answers it. Not required for the Cua path — the planner does not have to be a
   CheaperInference model — so this is now optional rather than blocking.

Recommended default if nobody answers: **Cua Driver + local `qwen3.8-uncensored` planner, C1 and
C2 both run**, because it spends nothing, needs no account, and produces the most defensible
comparison. Its ceiling is whatever the local planner can do — stated plainly in the report.

---

## 10. Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| 1 | Does Cua's driver actually reach LibreOffice Calc's grid on Windows ARM64 (the §1a spike)? | the whole option choice | baseline workstream, needs the VM |
| 2 | Is the driver's pixel rung or element rung the one that lands on Calc cells? | C1 definition | baseline workstream, same spike |
| 3 | Which planner model (local $0 vs paid §8.4) | any run | Tiffany via outer loop (§9.2) |
| 4 | Is C2 (full ladder) in scope? | comparison credibility | Tiffany via outer loop (§9.3) |
| 5 | VM time slot after the sweep | any run | M1 Coordinator |
| 6 | Does the Myco sweep keep 30 columns varied, or only `name`? (runbook §7.3) | comparison honesty | M1 Coordinator (owner of the sweep) |

---|---|---|---|
| 1 | PyAutoGUI runner via `launch` (a) vs new agent ops (b) | harness implementation | baseline workstream |
| 2 | Does the host-side agent harness run on the Mac against the guest over `ssh -T` MCP, or inside the guest? (Mac is preferred: it keeps the transcript and the judge on one machine.) | harness implementation | baseline workstream, decided in the M1-021 spike |
| 3 | Grounding model choice (escalation §9.1/2) | any run | Tiffany via outer loop |
| 4 | VM time slot after the sweep | any run | M1 Coordinator |
| 5 | Does the Myco sweep keep 30 columns varied, or only `name`? (runbook §7.3) | comparison honesty | M1 Coordinator (owner of the sweep) |

---

## 11. Definition of done for M1-015

- `docs/baseline/screenshot-agent-report.md` with the §4 table filled from artefacts, both arms,
  30 rows each, plus the deviations register and the prompt/model hashes.
- Every row reproducible from `baseline/transcripts/` without re-running.
- The report states what the baseline **beat** Myco at, if anything, in plain numbers.
- CI covers §3.6; the baseline driver is code-reviewed and merged through the standing rule
  (independent verifier PASS at head SHA + green CI, then merge).

---

## 12. Sources

| Claim | Source |
|---|---|
| Agent S3 + `gui-agents`, mandatory grounding CLI args, OpenAI-compatible endpoint (**historical**: superseded, `cua-agent` is deprecated upstream) | `docs/research/eval-frameworks.md` §3.2; `libs/python/agent/README.md` |
| UI-TARS-1.5-7B apache-2.0, not gated; repo archived; parsing package | §3.3 |
| ShowUI-2B MIT, 2B, CPU-viable, "GPU budget zero" path | §3.5, §3.9 |
| Local VLMs score 2/16 at cell grounding; Ollama `/v1` accepts `image_url` | §3.8 [measured] |
| CheaperInference vision unknown; credits error | §3.8, §3.9 |
| OpenAdapt 54/72 and 30/30 false-success shape | §3.7 |
| Agent op surface: 10 ops, no coordinate click, keystrokes only via `uia_invoke action=keys` (needs a UIA `runtime_id`) | `src/win/agent-client.ts:19-29`, `agent/myco_agent/ops.py:30-43`, `agent/myco_agent/windows_backend.py:515-519` |
| Myco's program is 5 fixed steps; no step budget exists in `src/` | `src/tasks/calc-record-edit.ts` `programFor()`; `grep -rn 'MAX_STEPS\|maxSteps\|stepBudget' src/` empty |
| `run-live.ts` always takes parameter set 0 (`name`) unless `--column/--row-key/--new-value` override it; the sweep driver used its own 6-seed list | `src/integration/run-live.ts:51-60`, `src/tasks/intent.ts:117-141`, `/tmp/m1-013/trial-one.ts`, runbook §7.3 |
| `pyautogui==0.9.54` is UFO's pinned input path, **not** in the guest image | `docs/research/adapters.md:153-160`; guest pip line `docs/env/windows.md:481` |
| Cold reset 134–152 s, 5/5 no wedge | `docs/coordination/m1-state.md` log 39 |
| Host contention distorts reset timing 45 s → 1879 s | logs 30, 41 |
| AutoCorrect immunity of the generator; 20/20 proof | PR #21, `docs/research/experiments/m1-013-generator-proof.md` |
| Sweep row schema and the independent audit | `/tmp/m1-013/trial-one.ts` (throwaway), runbook §7.3 |
| Installed local vision models | `ollama list` on this host, 2026-11-21: `eriktonon/gemma4-uncensored:12b`, `eriktonon/qwen3.8-uncensored:latest`, both `vision` |
| Cua repo: MIT, 32.7k stars, pushed 2026-11-21 | `https://api.github.com/repos/trycua/cua` |
| Cua Driver `windows-arm64` release asset (30.3 MB = 30,296,604 B) beside `windows-x86_64`; release is marked prerelease | release `cua-driver-rs-v0.56.4`, GitHub API |
| Windows marked **Supported**; Win32/UIA/window messages; Electron/Tauri/WPF/WinUI3/WebView2 coverage | `https://cua.ai/docs/cua-driver/concepts/platform-support` |
| Windows/Win32 accepted baseline: run `29257963004`, 122/122 rows, 99 delivered, 23 exact refusals | `libs/cua-driver/docs/action-support.md` |
| Windows ledger fixtures are WPF/WinUI3/WebView2; LibreOffice intentionally skipped | same file; `libs/cua-driver/tests/runners/windows/README.md` |
| Windows-over-SSH design: session-1 daemon + `\.\pipe\cua-driver` proxied from session 0 | `https://cua.ai/docs/cua-driver/guides/vms-and-remote` |
| `get_window_state` returns tree **and** screenshot; action ladder element→pixel→page→foreground with `confirmed/unverifiable/refused` | `https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works` |
| `cua-mcp-filter` tool allowlist; `--text-only`; local-model guidance (64K context) | `https://cua.ai/docs/cua-driver/guides/local-models` |
| `ghcr.io/trycua/windows:11` is `arch: [amd64, arm64]`, ARM64 on Apple silicon | `libs/images/sandbox-images.json` |
| cua-bench `windows-qemu` tasks run through `cua-spacesd`; `evaluate` scores the sandbox | `libs/cua-bench/README.md` |
| `cua-agent` (Agent-S-style framework) is **deprecated**; Cua Driver is the supported path | `libs/python/agent/README.md` |
| UI-TARS-1.5-7B apache-2.0, not gated, 228,519 downloads, GGUF quants published | Hugging Face API, 2026-11-21 |
| Claude prices: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per MTok | `docs.claude.com/en/docs/about-claude/pricing.md` |
| `computer_toolset_20260801` adds ≈4,500 input tokens per request; screenshots billed as image input | `docs.claude.com/en/docs/agents-and-tools/computer-use.md` |
| Screenshot token rule `ceil(w/28) x ceil(h/28)`, ≤4,784 visual tokens for current models | same file |
| OpenAI prices: gpt-6-luna $0.10/$0.50, gpt-6.2-sol and gpt-6.1-sol $2/$10, gpt-6.2-astra $8/$40 | `platform.openai.com/docs/pricing.md` |
| Gemini 3.1 Pro: $2 input / $12 output per MTok (≤200k prompts) | `ai.google.dev/gemini-api/docs/pricing.md` |
| Computer-use reference implementation runs in a Linux Docker container | Anthropic computer-use docs |