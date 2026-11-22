# MVP competitive teardown — computer-use tooling vs Myco

Issue: TIF-59 (head-to-head vs existing computer-use tools). **Access date:
2026-11-21** (UTC) for every source. Public sources only.

URL legend used below: `HCU-R` = https://github.com/microsoft/Hybrid-Computer-Use ·
`HCU-P` = https://arxiv.org/abs/2610.41432 · `HCU-PL` = `…/raw/main/docs/PLATFORMS.md` ·
`HCU-MCP` = `…/raw/main/docs/MCP.md` · `CUA` = https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works ·
`CUA-Q` = https://cua.ai/docs/cua-driver/quickstart.md · `ORGO-I` = https://docs.orgo.ai/introduction.md ·
`ORGO-F` = https://docs.orgo.ai/api-reference/computers/fork.md · `ORGO-W` = https://docs.orgo.ai/guides/workflows.md ·
`ORGO-L` = https://docs.orgo.ai/guides/account-limits.md · `ORGO-P` = https://www.orgo.ai/pricing.md ·
`SAI-I` = https://platform.simular.ai/documentation/index.md · `SAI-J` = `…/api-reference/judge.md` ·
`SAI-L` = `…/concepts/learned-code.md` · `SAI-SO` = `…/concepts/structured-output.md` ·
`SAI-B` = `…/concepts/billing-and-limits.md` · `SAI-A` = https://www.simular.ai/articles/sai-tops-osworld-2-0 ·
`OSW2` = https://osworld-v2.xlang.ai/ · `OSW2-P` = https://arxiv.org/abs/2606.29537

---

## 1. Method

Read primary sources directly: HCU repo (`README.md`, `docs/PLATFORMS.md`,
`docs/MCP.md`, `LICENSE`) and its paper (arXiv 2610.41432v1, 30 Oct 2026, full
PDF); Orgo doc site (introduction, `llms.txt`, fork/clone API, MCP, workflows,
limits, pricing); Simular Sai doc site (`llms.txt`, index, judge, learn,
structured output, approvals, billing, computers) and its benchmark article; Cua
repo README and Cua Driver docs; OSWorld 2.0 site and paper abstract for metric
definitions. Metric names are quoted as each vendor prints them, never
normalised.

**Not run, and therefore not relied on:**

| Not run | Why | Consequence |
|---|---|---|
| Orgo API calls | needs `sk_live_` key from a signed-up account | fork/clone/health is doc-only |
| Sai task / judge / learn | needs `sapi_` key + phone verification | judging behaviour is doc-only |
| HCU on a real desktop | not built; needs TCC grants | behaviour is repo+paper only |
| Cua Driver install | out of scope (no installs) | driver contract is doc-only |
| Any benchmark re-run | OSWorld 2.0 Docker guests + paid model access | **all numbers reported, none reproduced** |

---

## 2. Per product

### 2.1 Microsoft Hybrid Computer Use (HCU)

**Architecture.** A Go stdio MCP server, `computer-use`, that adds two tools —
`AX` (accessibility tree, reference-addressed, batched) and `GUI` (screenshots,
pointer/keyboard) — beside a coding agent's own shell/file tools. "HCU adds no
planner, subagents, or loop of its own" (`HCU-P` §3).

**Interfaces.** MCP `2025-03-26` / `2025-06-18`, "Public tools | `AX` and `GUI`"
(`HCU-MCP`); CLI (`computer-use call AX|GUI`) and Python SDK `hcu_sdk` sharing one
daemon per desktop (`HCU-R`).

**Platforms.** Linux = embedded Python + AT-SPI2 + X11/XTest; macOS 14+ = Swift
AXUIElement/CoreGraphics/ScreenCaptureKit; Windows 10/11 = C#/.NET 8, FlaUI UIA3
5.0, Win32. "The binary selects its backend at compile time" (`HCU-PL`).

**Benchmarks — metric names as printed.** Paper §4.1: "We report Partial (mean
task score) and Binary (full-credit rate) on OSWorld 2.0 and Score on OSWorld
1.0."

| Benchmark | Platform | Model | HCU | CUA Driver | Cost |
|---|---|---|---|---|---|
| OSWorld 2.0 (108) | Linux | GPT-6 Astra | 72.37% **Partial**, 32.40% Binary | 68.82% / 31.50% | $10.03 vs $10.05 /task |
| OSWorld 2.0 (108) | Linux | Claude Opus 5 | 72.06% Partial, **35.19% Binary** | — | $22.67/task |
| OSWorld 1.0 (360) | Linux | GPT-5.4 | 70.13% Score *(released)* | 62.47% | −59.1% ($0.402 vs $0.983) |
| Windows Agent Arena (111) | Windows | GPT-5.4 | 80.86% | 71.89% | −50.6% |
| MacAgentBench, UI subset (28) | macOS | GPT-5.4 | 25 / 28 | 24 / 28 | −51.4% |
| WeaveBench (114) | Linux | GPT-5.4 | 53.25% | 46.37% | −46.3% |

(Every row is the **evaluated** `HCU-P` run except where marked *released*; never
pair the two — the evaluated OSWorld 1.0 row is $2.52 vs $5.65 and 351.3 s vs
500.8 s.) (`HCU-P` Tables 1–2, §4.2; `HCU-R` Results. The paper greys out OpenAI's GPT-6
Astra row as "evaluated internally on a subset of tasks"; HCU's own row is a
full-set Codex run.) That omitted row is **72.60% Partial** — above HCU's 72.37%
— so HCU is the best *full-set* result on that model, not the best *reported* one,
and the 3.55-point Partial gap to CUA Driver is the honest one to sell.

**Licence / pricing.** MIT (`LICENSE`), with files adapted from OSWorld-V2
(Apache-2.0) under `THIRD_PARTY_NOTICES.md`; the subtree is not pure MIT. No product pricing; cost of ownership is
the agent's model spend, which the paper measures per task.

**Outcome verification.** Widget-level, with the ceiling stated explicitly — the
single most important quote in this teardown (`HCU-PL`):

> "AX readback describes provider-visible state. Verify saved files through the
> application or filesystem when persistence is required."

and (`HCU-MCP`): "Control readback does not prove that the document was saved or
that a dialog applied its changes." HCU reads back control state after a write
(`effect: r58 checkbox "Interface" checked=false→true`), returns `effect_unknown`
rather than a false positive, The **evaluated** version also ran in-batch checks as ordered `wait` steps —
"in-batch checks are unified as ordered wait steps (replacing action- and
batch-level postconditions and assert_ax)" (`HCU-P` App. B.1); the **released**
repo has ordered waits only.
Persistence verification is **delegated upward to the agent's own file tools**.

**Failure recovery.** Per-step, model-directed. "If an action fails, a wait times
out, or window continuity is lost, HCU stops the batch and reports the stopping
point and execution evidence" (`HCU-P` §3.1.1, evaluated version; the released
repo keeps stop-and-report with waits alone); the result carries `completed`
and a corrected-call `hint`; `effect_unknown` forbids blind retry — "Do not
retype that value" (`HCU-MCP`). No automated recovery loop.

**Repeatability / setup.** Deterministic per desktop, but "One `computer-use mcp`
process serves one desktop session … never share a process between benchmark
tasks" (`HCU-MCP`); reproduction is "a fresh Docker/QEMU guest with one agent and
one MCP process" (`HCU-R`). Setup is the heaviest of the four: `computer-use
doctor`, macOS "Accessibility and Screen Recording consent", Linux
`apt-get install python3-gi gir1.2-atspi-2.0 … xdotool wmctrl x11-utils libxres1`
(`HCU-MCP`), Windows ".NET 8 SDK and PowerShell 7+ … Windows PowerShell 5.1 is not
supported" (`HCU-PL`).

**Fork / branching.** None. No fork, snapshot or replay-to-code in the documented
surface. `[INFERENCE]` the OSWorld harness's guests give task-level reset; that is
benchmark scaffolding, not a product feature.

---

### 2.2 Cua (Cua Driver) — the M1 baseline candidate

**Architecture.** "Cua Driver is the UI layer of a computer-use agent. The
harness runs the model and the loop; Cua Driver turns each proposed step into an
observation or an action on a real desktop, and reports what happened." (`CUA`).
The repo (`trycua/cua`, 32,748 stars, 2,477 forks at access) also ships Cua Spaces,
Lume, CUA-S1 and Cua Bench.

**Interfaces.** MCP (`cua-driver mcp`), CLI (`cua-driver call`), SDK
(`CuaDriver.create()`), daemon (`cua-driver serve --socket`).

**Platforms.** macOS Accessibility + CoreGraphics/SkyLight + ScreenCaptureKit;
Windows UIA + window messages; Linux X11 AT-SPI; Wayland partial — "Raw
background keys refuse; use AT-SPI, XWayland, or foreground" (`CUA`).

**Benchmarks.** No benchmark number in the Cua Driver docs or the repo README
(checked 2026-11-21); **Cua Bench and the Cua blog were not reviewed**, so this is
a scope statement, not "Cua publishes none". It appears as HCU's
baseline: 68.82% Partial / 31.50% Binary on OSWorld 2.0 with GPT-6 Astra, 62.30
Score on OSWorld 1.0 with GPT-5.4 (`HCU-P` Tables 1–2). `[INFERENCE]` any Cua
headline number must come from a third party until cua.ai publishes its own.

**Licence / pricing.** "Everything outside Cua Spaces and Cua Driver Bench is
MIT"; those two are **FSL-1.1-MIT**. Cua Spaces "Free for individuals. Pro is $18
a month and Teams is $30 per seat a month" (repo README of trycua/cua).

**Outcome verification.** The most rigorous vocabulary of the four, and it stops
at accessibility read-back:

> "1. **Element, background.** Act by `element_token`: UI Automation Invoke on
> Windows, `AXPerformAction` on macOS, AT-SPI actions on Linux. This is the only
> rung the driver can verify itself."
> "| `effect` | `confirmed` (read back through accessibility), `unverifiable`,
> `suspected_noop`, `partial`, `refused` |"
> "| `verified` | `true` only for accessibility read-back |"
> "A delivered event is not an applied change: Electron, Catalyst, and web
> content can echo a write they did not apply, so the driver reports those as
> `unverifiable`" (`CUA`).

It does not verify persisted application state. The HCU paper credits the
distinction but names the cost: Cua "leaves verification and renewed observation
to separate operations" (`HCU-P` §4.3).

**Failure recovery.** Escalation ladder, not retry: `escalation: {recommended:
"px" | "page" | "foreground", reason}` (element → pixel → page → foreground);
typed refusals (`stale_element_token` → snapshot again; `background_unavailable`
on Wayland).

**Repeatability / setup.** Session per connection, expiring after "five idle
minutes", after which "element tokens and snapshots from the ended one stay
invalid" (`CUA`). Install: one-line script + two macOS System Settings toggles —
"Neither prompt grants anything by itself: both offer Open System Settings, not
Allow" (`CUA-Q`). Driver validation is per-cell with "per-cell video and logs tied
to the source commit", and "A tool returning `ok` is not evidence … An exact
refusal also passes; a silent success does not" (`CUA`).

**Fork / branching.** None at the driver level. Cua Spaces has VM-level Spaces
and "Teleport"; `[INFERENCE]` usable to branch a desktop, not an agent run.

---

### 2.3 Orgo

**Architecture.** Cloud VMs with a desktop, browser and terminal, for an agent
you bring: "Orgo provides the computer, not the agent … Orgo is what they run on"
(`ORGO-I`). Interfaces: HTTP API (spec 2.0.0, "114 operations in 14 groups, 38 of
them GET" per https://docs.orgo.ai/llms.txt), Python/TS SDKs, CLI, hosted MCP at
`https://www.orgo.ai/mcp` (OAuth+PKCE), and an OpenAI-compatible endpoint with a
built-in `orgo-agent` model.

**Platforms.** "Linux and Windows are self-serve. A Mac or an iPhone 12 comes from
Get one in the app while in stock, and the iPhone 17 is by request" (`ORGO-I`).

**Benchmarks.** None. Orgo reports no task-success metric; every number would come
from the user's own harness.

**Licence / pricing.** Proprietary. Medium Linux (8 GB, 2 vCPU, 40 GB) **$0.055/hr
running**, **$0.0027/hr stopped**; Small $0.023/hr; Starter $29/mo, Growth $99/mo,
Scale $399/mo; Windows +$15/mo or $0.10/hr Medium; Mac from $100/mo (`ORGO-P`).

**Outcome verification.** None at task level. The loop is: "1. **See.** Capture a
screenshot. 2. **Decide.** … 3. **Act.** … 4. **Repeat.** Continue until the task
is complete" (`ORGO-I`) — completion is the model's assertion. The nearest
substitute is Workflow `POST /workflows/{id}/validate`, which "proves a workflow
will work, and sends nothing … each app signed in (with a read that proves it)" —
**pre-flight** checking, not outcome proof. Workflows also check content ("every
number, date and name an agent wrote must be in the data it was handed") and mark
uncertain sends `needs_review`: "A send may or may not have gone out, because no
answer came. Orgo never sends it again by itself: check the app first." (`ORGO-W`).
That is an honest "we don't know", with no evidence record.

**Failure recovery.** Infrastructure only: `POST /computers/{id}/health` and
`/heal` (llms.txt index). MCP retries are deliberately narrow: "`orgo_execute_bash`
and `orgo_mouse_click` get exactly one attempt, because running either twice is
worse than failing once" (https://docs.orgo.ai/guides/mcp.md). No task recovery.

**Repeatability / setup.** Environment: strong (Templates "defined once and
launched in seconds"; publishing/building templates "needs Scale or Enterprise on
your own plan", `ORGO-L`). Procedure: nothing captures what the agent did. Setup
needs `sk_live_` key; free credit is limited per IP/network/day and refused from
"a server, datacenter or VPN address" (`ORGO-L`).

**Fork / branching.** Orgo's genuine differentiator. `POST /computers/{id}/fork`
copies "the disk and live memory: open apps, windows, running processes"; the
source "pauses for about two seconds while its memory is copied"; fork is
"Running, Linux only". Two distinct refusals both read `NOT_FORKABLE`: 400 (no
server address) and 409 (not running, Windows, old VM type), alongside
`DEVICE_LIFECYCLE_UNSUPPORTED`, `RESERVED_HOST`, `HOURLY_QUOTE_REQUIRED`
(`ORGO-F`). The baseline limit is a **different page**: "A copy past the baseline
… copies cannot", applying to clones, forks and restores alike (`ORGO-L`, account
limits). The fork path also contradicts itself upstream: the prose accepts "UUID
or instance_id" while the OpenAPI spec says a UUID returns 404. Treat neither as
settled. Clone = disk only, "From a fresh boot". It
branches the *machine*, not the *task*: no record of what was attempted.

---

### 2.4 Simular Sai

**Architecture.** A hosted computer-use agent called over HTTP: "Send Sai a task
in plain English over HTTP; Sai runs it on a Windows or Linux cloud computer that
Simular hosts, or on your own Mac or Windows PC, and returns the result"
(https://platform.simular.ai/documentation/llms.txt). `POST /v1/agents/message`,
`GET /events`, `/approve`, `/abort`, `/turns`, `/learn`, `/judge`,
`/machines/{id}/control`; MCP server for Claude Code/Codex/Cursor; six SDKs.

**Platforms.** Cloud Windows (free tier: one pooled Windows machine) or
Windows/Linux paid; or your own Mac/Windows with the Sai Agent.

**Benchmarks — metric names as printed** (`SAI-A`, Aug 28 2026, updated Oct 2 2026):

> "On OSWorld 2.1 … Sai achieves a 77.3% partial score (79.4% counting repeated
> runs, 41.7% binary score) at an average cost of $14.34 per task, on par with
> Opus 5 at 77.67% (cost unavailable)."
> "Sai achieves a 73.0% partial score at $15.70/task" on OSWorld 2.0; "Binary
> success rate on OSWorld 2.0. Sai scores 28.25%".

Two normalisation traps: the docs index flattens this to "It is #1 on OSWorld 2.0
(73%)" (`SAI-I`), dropping *partial* and the version; and "79.4% counting repeated
runs" is not a benchmark metric — `[INFERENCE]` it is pass@k-style re-scoring and
must not be ranked against single-attempt Partial.

**Licence / pricing.** Proprietary, credit-based; "The computer and the model are
included; you do not bring your own model keys"; free tier "get one pooled Windows
cloud computer, a daily time limit on it, and a daily credit grant … Phone
verification is required before the first API key" (`SAI-B`). Only per-task
benchmark dollars are published, no list price.

**Outcome verification.** Closest prior art to Myco's verdict, and the ceiling is
stated by the vendor: `options.success_criteria` ("A sentence for a model to judge
the result against … or 1 to 20 checks", `SAI-SO`) and `POST /v1/agents/judge` —
but

> "The judge reads the turns' steps, their output and the final answers. It does
> not see screenshots yet."
> "Treat the verdict as advice: text on the screen can try to steer a model
> judge."
> "`verdict` | `passed`, `failed`, or `unverifiable` when a criterion could not be
> checked." (`SAI-J`)
>
> Step-by-step judging of screenshots (`transitions`) and checking a live computer
> (`probe`) "come later and return `400`" (`SAI-J`).

That roadmap line matters for the wedge: persisted-state verification is not merely
absent from the field, it is **planned** by the closest competitor. The
differentiation is temporal, not structural.

Three-valued, same vocabulary as Myco — adjudicated over a *transcript*, not
persisted state, and self-declared injection-vulnerable. The turn record exposes
`evidence: []`. Where Sai *does* verify artifacts, it is the agent choosing to do
so: "Before declaring done, Sai re-read all four booking JSONs from ~/Downloads
and printed vaccine, clinic, date, time and price to confirm each one matched"
versus "Sol's own confirmation page read 'Booking Successful — Name: Jennifer' and
it never compared that back to the source" (`SAI-A`). `[INFERENCE]` the platform's
own success_criteria check remains model-over-text.

**Replay-as-code.** `POST /v1/agents/learn` → "a Simulang function you own, `async
function main(params = { ... })`" (`SAI-L`), which "throws `needs_sign_in: <site>`
when the computer is not signed in, and `precondition_failed: ...` when it starts
on the wrong screen". With `maxIterations` it "runs the code several times to test
Pass^k reliability, judges each run, and repairs the code after a failure". So it
guarantees: an owned, version-controllable artifact; a two-case precondition
taxonomy; Pass^k testing **at learn time only**. Two documented caveats bound even
that: without `reset` each rollout "starts where the last one ended", and
"`testResult` says how the returned code did on the inputs it ran with, not on
other inputs" (`SAI-L`). It does not guarantee a later run
succeeded — the caller judges it, without screenshots. `learn`, `judge` and
`direct control` are all labelled **research preview**. Underlying claim
(arXiv 2609.36927, per `SAI-I`): "learned policies cut per-run cost 15–217× and
latency 3.4–5.1×, and raised Pass^3 … by 3.6–15.8 points".

**Failure recovery.** Human-gated then learned: approvals for `exec`/`choice`
before risky actions, browser handoff via `approvalUrl` or a 30-minute live link
(`https://platform.simular.ai/documentation/concepts/approvals.md`); task repair by
re-calling `learn` with `initialCode` + failed `evaluations` (`SAI-L`).

**Repeatability / setup.** Highest consumer cost of the four: sign-in, phone
verification, and "A free account's first request of the day can take about two
minutes while its computer starts". Sessions are "One conversation per API key and
computer".

**Fork / branching.** No fork, branch or snapshot endpoint appears in any of the
~50 indexed Sai pages (checked 2026-11-21). The `llms.txt` index is **not
exhaustive** (the Organisations subtree and several endpoints are reachable but
unlisted), so this is weak evidence, not proof. Branching exists only as
procedure replay with different inputs; a computer runs one task at a time, and
the free tier's Windows machine is pooled
("Direct control and learn jobs use your real screen, mouse and keyboard, so leave
the computer alone while they run"). So: **Sai branches procedures, Orgo branches
machine state, neither branches a live run at a step — stated as "not found",
not "does not exist", for the same index limitation.**

---

### 2.5 Screenshot-only control (cheap baseline)

A loop whose only observation is a raster screenshot and whose only action is
pixel-addressed input — "A screenshot loop sends a full image at every step and
acts only through pixels" (`HCU-R` FAQ). Documented cost of the pixel path: local
parsing takes "about 2 to 2.5 seconds on macOS, 3.5 to 4 seconds on Linux, and 8
to 9 seconds on Windows" per screenshot (`CUA`) — that is the *perception
extension's* CPU cost; a loop that instead sends every screenshot to a remote
model pays model latency and image tokens per step, not this. Measured
cost of dropping semantics: removing HCU's AX channel costs 2.79 points and
+14.08% Steps; removing GUI costs ~0 points but +12.45% Steps (`HCU-P` Table 2,
OSWorld 1.0, GPT-5.4). A third of that table is the uncomfortable one for a
runtime pitch: the **skill** (the prompt discipline) is worth 17.37% → 1.36%
malformed calls and GUI actions 4.96 → 1.97, several times the AX channel. If
"verify the final state" is partly prompt discipline, a competitor reproduces the
cheap win with a skill file and no runtime. Full-set screenshot loops on OSWorld 2.0 sit at 68.31%
(Claude Opus 5 Muse Spark 1.3), 62.72% (GPT-5.6 Sol), 59.00% (Gemini 3.8 Flash),
58.30% (Kimi K3) — all **Partial** (`HCU-P` Table 1). Verification and recovery are
model-improvised; the OSWorld 2.0 authors name the resulting failure as the
benchmark's central finding — agents "skip verification, struggling most when a
task hinges on hidden state they must recover" (`OSW2-P`), e.g. Task035 "Self-Check
Misses the Absent Row" (`OSW2`).

---

## 2.6 Cross-check against the M2 research teardown (finding m2-01)

Written in a separate workstream, on different days, as a different reading pass over
the same primary pages, against the same claim. m2-01 read four product lines this
document does not cover (Anthropic computer use, OpenAI computer use/Operator, UiPath,
heyclicky); this document read one control m2-01 does not (screenshot-only). Simular
Agent S is not in that complement: m2-01 §7.3 treats it and Sai as one product line, and
this document covers that line as Sai (§2.4). Where the two disagree, the disagreement
is the finding — it is listed, not smoothed.

| Point | This document | `docs/research/findings/m2-01-competitive-teardown.md` | Resolution |
|---|---|---|---|
| Orgo free credit | "an internal inconsistency: $3 vs $5/$2" | the same, and **explicitly marked contested** in its pricing table | confirm: quote as contested, never as a number |
| Orgo fork source identifier | "the prose accepts UUID or instance_id while the OpenAPI spec says a UUID returns 404" | the same contradiction, found in both documents | confirm: an upstream defect, not a transcription error |
| Orgo verdict | none; `needs_review` is an honest "we don't know" | the same, plus the specific non-proof that "a missing `text` body types the empty string and still returns `200`" | m2-01 is more specific; adopt its example |
| Sai `unverifiable` | three-valued but transcript-adjudicated | the same, and names `unverifiable` as **the one shape worth stealing** | confirm; the shape is worth stealing, the oracle is not |
| Closest to a proof | Cua (per-action `effect`) and HCU (window before/after + layout guard) | the same two | confirm |
| HCU's limit | quoted from `PLATFORMS.md` and `MCP.md` | quoted: *"Neither proves file contents, persistence or network state."* | both; m2-01's sentence is the sharper one |
| Scope | HCU, Cua, Orgo, Sai, screenshot-only control (4 products + 1 control) | Cua, Anthropic, OpenAI, Simular Agent S, UiPath, heyclicky (6), plus HCU/Orgo/Sai added — m2-01 §7.3 treats **Agent S and Sai as one product line**, so its comparable inventory is 8 | complementary; neither is a superset. **Union = 8 named products + the screenshot-only control, 0 with a persisted-outcome verdict** |
| Economic baseline | MIT for HCU (Apache-2.0 OSWorld-V2 subtree, not pure MIT) and Cua (FSL-1.1-MIT for Spaces/Driver Bench); per-task benchmark cost $10.03 vs $10.05 on OSWorld 2.0 (§3.5) | "per machine-hour or per credit" (m2-01's closing "Two notes for Discovery"): Orgo bills machine-time ($0.023-$0.368/running hr), Sai bills credits (per-credit prices not reported), so verification is effectively free if the customer writes it | adopt m2-01's hedge, not a stronger one: either billing model prices verification at zero *when the customer writes it*, which is why the **hcu+shell** arm decides the wedge |

The joint conclusion both documents reach independently: **the gap is not access,
observation or actuation; it is a verdict on state that survives the agent.** That
makes the deciding question not "does anything verify" but "does verification happen
without agent discipline, and does the artifact outlive the run" — which is exactly
the hcu+shell arm in `mvd-preregistration.md` §4.1.

## 3. Capability matrix (TIF-59 axes)

### 3.1 First-use setup

| | Evidence |
|---|---|
| **HCU** | Heaviest, and free. Build Go 1.22+; macOS "Accessibility and Screen Recording consent"; Windows ".NET 8 SDK and PowerShell 7+"; Linux `apt-get install … gir1.2-atspi-2.0 … xdotool wmctrl` (`HCU-PL`, `HCU-MCP`). No account, key or payment. |
| **Cua Driver** | One-line installer, then two macOS toggles: "Neither prompt grants anything by itself: both offer Open System Settings, not Allow" (`CUA-Q`). No account for the driver. |
| **Orgo** | `sk_live_` key required; free credit limited per IP/network/day and refused from "a server, datacenter or VPN address" (`ORGO-L`). |
| **Sai** | "Phone verification is required before the first API key" (`SAI-B`); free tier one pooled Windows machine; first daily request "about two minutes" to start (`SAI-B`). |
| **Screenshot-only** | Needs no accessibility consent; pays 2–9 s per screenshot for *local* parsing (`CUA`), or model latency plus image tokens if the loop sends pixels to a remote model. |

### 3.2 Independently verified correctness

| | Evidence |
|---|---|
| **HCU** | Widget-level only: "AX readback describes provider-visible state. Verify saved files through the application or filesystem when persistence is required" (`HCU-PL`); "Control readback does not prove that the document was saved" (`HCU-MCP`). Emits `effect_unknown` instead of a false positive. |
| **Cua Driver** | Widget-level only: "`verified` | `true` only for accessibility read-back"; `effect: confirmed/unverifiable/suspected_noop/partial/refused`; echoes reported as `unverifiable` (`CUA`). |
| **Orgo** | None. "Continue until the task is complete" (`ORGO-I`); `validate` is pre-flight (`ORGO-W`); unknown sends end `needs_review`: "Orgo never sends it again by itself: check the app first." |
| **Sai** | Model-adjudicated transcript: `passed`/`failed`/`unverifiable`; "It does not see screenshots yet"; "Treat the verdict as advice: text on the screen can try to steer a model judge" (`SAI-J`). |
| **Screenshot-only** | None; the failure mode the OSWorld 2.0 authors document (`OSW2-P`, `OSW2` Task035). |
| **Myco (target)** | Verdict over persisted app state, independent of the agent's claim — the one column unoccupied. |

### 3.3 Failure recovery

| | Evidence |
|---|---|
| **HCU** | Stops the batch at first failure with `completed` + corrected-call `hint`; `effect_unknown` forbids replay (`HCU-MCP`); no loop of its own (`HCU-P` §3). |
| **Cua Driver** | Escalation ladder `px → page → foreground` with typed refusals (`stale_element_token`, `background_unavailable`) (`CUA`). |
| **Orgo** | Infra only: `/health`, `/heal`; MCP retries `GET/PUT/DELETE` only — bash and click "get exactly one attempt" (`https://docs.orgo.ai/guides/mcp.md`). |
| **Sai** | Approvals gate risky actions; live-link human handoff; post-run repair via `learn(initialCode, evaluations)` (`SAI-L`, approvals doc). |
| **Screenshot-only** | Model-improvised; no contract for whether input landed. |

### 3.4 Repeatability

| | Evidence |
|---|---|
| **HCU** | Environment repeatable, procedure not: one MCP process per desktop, "never share a process between benchmark tasks" (`HCU-MCP`); reproduction = "a fresh Docker/QEMU guest" (`HCU-R`). No *documented* replay surface, though the repo retains per-call observations (`app_snapshot.go`, `*_evidence_test.go`). |
| **Cua Driver** | Session-scoped; "after five idle minutes … element tokens and snapshots from the ended one stay invalid" (`CUA`); per-cell validation records "tied to the source commit". |
| **Orgo** | Environment strong (Templates "launched in seconds", Scale/Enterprise to publish, `ORGO-L`); procedure none. Workflows: "a later edit never changes a run already going" (`ORGO-W`) — preview. |
| **Sai** | Procedure strongest: learned code "you can read it, test it and keep it under version control" (`SAI-L`); reliability measured as "Pass^3 (success on all three of three runs)" (`SAI-I`). |
| **Screenshot-only** | Worst: a coordinate is valid only for its screenshot; Cua refuses stale captures — "The capture is older than 60 seconds | Refused with `capture_expired`" (`CUA`). |

### 3.5 Economics

| | Evidence |
|---|---|
| **HCU** | **$10.03/task** vs CUA Driver **$10.05** on OSWorld 2.0 GPT-6 Astra at +3.55 Partial (`HCU-P` Table 1). OSWorld 1.0, kept in two columns that must not be mixed: **evaluated** (Table 2) $2.52 vs $5.65 per task, 351.3 s vs 500.8 s; **released** (Table 4) $0.402 vs $0.983 at 70.13% vs 62.47%. MIT except the Apache-2.0 OSWorld-V2 subtree. |
| **Cua Driver** | Third-party numbers above; Cua Spaces $18/mo Pro, $30/seat/mo Teams (repo README); +2–9 s per screenshot with local perception (`CUA`). |
| **Orgo** | Infra only: $0.055/hr Medium running, $0.0027/hr stopped; plans $29/$99/$399; Windows +$15/mo (`ORGO-P`). One internal inconsistency: `ORGO-P` says "$3 of starting credit", `ORGO-L` says "$5 for a person or $2 for an agent signup". |
| **Sai** | **$14.34/task** on OSWorld 2.1, **$15.70/task** on 2.0 (`SAI-A`); computer + model included (`SAI-B`). |
| **Screenshot-only** | Image tokens per step plus 2–9 s/screenshot for local parsing (`CUA`). |

### 3.6 Fork / branching

| | Evidence |
|---|---|
| **HCU** | None documented. |
| **Cua Driver** | None at driver level; Cua Spaces has VM-level Spaces + "Teleport" — `[INFERENCE]` desktop branching, not run branching. Its platform matrix also rates KDE/KWin and Hyprland **Experimental** (`CUA` platform support). |
| **Orgo** | Strongest: fork copies "the disk and live memory: open apps, windows, running processes", source pauses "about two seconds", Linux running only, past-baseline "copies cannot" (`ORGO-F`). |
| **Sai** | None; branching is procedure replay with new inputs (`SAI-L`). |
| **Screenshot-only** | `[INFERENCE]` VM snapshot if the harness offers one; nothing in the interface. |

---

## 3.7 The failure class none of them covers, and one of them caps

Simular's own OSWorld article reports a task where "the current one zeroes any run
that touches DevTools", and a run where Opus 4.7 "set the score variable by hand"
(`SAI-A`). That is not a DevTools problem; it is **any agent that writes the answer
instead of doing the work** — DevTools, `echo > file`, an accessibility
`set_value` on a read-only field. A verifier over persisted state does not catch it
on its own either, which is why M1's trace assertion (store contents may only
advance via GUI act events) exists. This is the cheapest high-signal experiment in
the document: a small family of answer-writing traps, scored by trace as well as
state.

## 4. What we can run on 2026-11-21 with no account and no payment

1. **HCU from source on this Mac** — MIT, no key; `make build-macos` +
   `computer-use doctor` (a local TCC prompt, not a signup). The only full hybrid
   stack in the set that costs nothing.
2. **Cua Driver locally** — MIT, curl installer, no account for the driver. Ships
   the M1 baseline in the same class HCU compares against.
3. **Static analysis of Orgo and Sai** — both doc sets are public and
   machine-readable (`docs.orgo.ai/llms.txt`,
   `platform.simular.ai/documentation/llms.txt`), and Sai's OSWorld 2.1
   trajectories are public: "All of Sai's OSWorld 2.1 trajectories are publicly
   available on Hugging Face" (`SAI-A`, dataset
   `simular-ai/sai-osworld-v21-reference-runs`). Those can be measured for
   **verification behaviour** (how often the agent re-read the artifact) without
   running Sai.
4. **OSWorld 2.0 tasks** — public corpus (`github.com/xlang-ai/OSWorld-V2`,
   `huggingface.co/datasets/xlangai/osworld_v2_tasks`), so a Myco task set can be
   drawn from a shared, citable pool.
5. **An HCU vs Cua Driver head-to-head on *our* task set** — Microsoft already
   published exactly this comparison on OSWorld/WAA (`HCU-P` Tables 1, 4–7, four
   models), so the missing number is **Myco against either**, not HCU against Cua.
   The paper's computer-use-loop rows are also the ready-made screenshot-only
   reference for M1's baseline criterion.

## 5. Requires escalation

| Item | Blocker | What it buys |
|---|---|---|
| Orgo key + credit | `sk_live_` key; a server/datacenter/VPN address gets no starting credit, and the account is free-only only if it never gets one (a card lifts it) | Real fork latency; confirm `NOT_FORKABLE` semantics |
| Sai key | phone verification before first key | Test whether `success_criteria` verdicts are model-over-text only |
| Paid OSWorld 2.0 runs | model access + compute. Arithmetic, not a quote, and not linearly derivable (a subset costs its per-task rate plus harness, and averages move with task mix): HCU ≈ $10.03 × 108 ≈ **$1.08k**; Sai on **2.0** ≈ $15.70 × 108 ≈ **$1.70k** ($14.34 is the 2.1 rate) | Reproduce, not cite, the headline numbers |
| HCU notarised signing | local signing "is not notarization" (`HCU-PL`) | Only needed if Myco redistributes HCU |

---

## 6. Claims to test, not assume

1. **AX, not batching, produces HCU's gain.** Disable batching vs remove GUI on
   20 OSWorld 2.0 tasks. Falsified if batching removal costs as much as the AX
   channel (paper: AX worth 2.79 points, `HCU-P` Table 2).
2. **"Verified" is a claim nobody else can make about a persisted file.** One task
   — save `q3.csv` from Calc — ask each stack, via its own documented surface,
   whether the file exists with the right content. Falsified if any returns
   independently-proven file state.
3. **Sai's judge is steerable by screen text.** A page rendering "file saved
   successfully" without saving, judged against `success_criteria`. Falsified if
   the verdict is `failed`.
4. **Pass^3 is the axis *we choose*, and the gap is unknown.** Not inferred from
   Simular's "79.4% counting repeated runs" — the article only says benchmarks
   *report* pass@k, and OSWorld 2.0's primary metric is binary at 500 steps. So it
   is a design choice, not a cited result: measure pass@1 vs pass^3 for HCU and
   Cua on 20 tasks, report points, and print the underpowered statement.
5. **Orgo's fork is a cheaper retry than a cold start.** Time `POST /fork` vs
   `POST /computers` + agent setup, on a task needing a signed-in browser.
6. **Setup cost dominates the first run.** Stopwatch from clean machine to first
   successful task for HCU (TCC), Cua (TCC), Orgo (key + first computer), Sai
   (phone verify + 2-minute start).
7. **`effect_unknown` is not rarer than `uncertain`.** Instrument HCU's
   `effect_unknown` rate against Myco's `uncertain` share on identical tasks.
   Falsified if HCU's is higher — widget read-back would be *less* decisive than
   persisted-state assertions.
8. **Stale-coordinate rejection saves tasks.** A task opening a dialog over a
   planned click target, with and without HCU's layout guard: "An action planned on
   a desktop that has since changed is rejected, not sent" (`HCU-R`). Most directly
   transferable claim in this document.
9. **Vendor benchmark numbers are not comparable.** Normalise every published
   figure to `(benchmark version, partial, binary, cost/task, steps)` and re-rank.
   The breaks are per axis: **version** — Sai's 73.0% (2.0) and 77.3% (2.1) are
   the same metric on different suites and cannot be ranked against each other;
   **metric** — partial vs binary is the big break (Sai 77.3% / 41.7%; HCU 72.37%
   / 32.40%; on binary the HCU–Cua gap is 0.9 points, not 3.55); **re-scoring** —
   "79.4% counting repeated runs" is not a single-attempt metric. Falsified if any
   ordering survives normalisation.
10. **Nobody branches a run at a step.** Attempt step-level fork (snapshot at step
    N, two continuations) on all four. Prediction: Orgo forks the machine, Sai
    replays the procedure, HCU/Cua neither. Falsified if any exposes "snapshot this
    task at step N".

---

## 7. Sources (accessed 2026-11-21)

| # | Source | URL |
|---|---|---|
| 1 | HCU repo README, file list, licence badge | https://github.com/microsoft/Hybrid-Computer-Use |
| 2 | HCU `docs/PLATFORMS.md` | https://raw.githubusercontent.com/microsoft/Hybrid-Computer-Use/main/docs/PLATFORMS.md |
| 3 | HCU `docs/MCP.md` | https://raw.githubusercontent.com/microsoft/Hybrid-Computer-Use/main/docs/MCP.md |
| 4 | HCU `LICENSE` | https://raw.githubusercontent.com/microsoft/Hybrid-Computer-Use/main/LICENSE |
| 5 | HCU paper — abstract | https://arxiv.org/abs/2610.41432 |
| 6 | HCU paper — full PDF (v1, 30 Oct 2026) | https://arxiv.org/pdf/2610.41432 |
| 7 | trycua/cua README (Driver, Spaces, licences, pricing) | https://github.com/trycua/cua |
| 8 | Cua Driver — "How Cua Driver works" | https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works |
| 9 | Cua Driver — Quickstart (permissions, setup) | https://cua.ai/docs/cua-driver/quickstart.md |
| 10 | Orgo — Introduction | https://docs.orgo.ai/introduction.md |
| 11 | Orgo — `llms.txt` (API surface, 114 operations) | https://docs.orgo.ai/llms.txt |
| 12 | Orgo — Fork computer | https://docs.orgo.ai/api-reference/computers/fork.md |
| 13 | Orgo — Clone computer | https://docs.orgo.ai/api-reference/computers/clone.md |
| 14 | Orgo — MCP guide (retry policy) | https://docs.orgo.ai/guides/mcp.md |
| 15 | Orgo — Workflows (validate, needs_review) | https://docs.orgo.ai/guides/workflows.md |
| 16 | Orgo — Limits (free-credit checks) | https://docs.orgo.ai/guides/account-limits.md |
| 17 | Orgo — Pricing | https://www.orgo.ai/pricing.md |
| 18 | Sai — docs index / API overview | https://platform.simular.ai/documentation/index.md |
| 19 | Sai — documentation `llms.txt` | https://platform.simular.ai/documentation/llms.txt |
| 20 | Sai — Judge API | https://platform.simular.ai/documentation/api-reference/judge.md |
| 21 | Sai — Learned code | https://platform.simular.ai/documentation/concepts/learned-code.md |
| 22 | Sai — Learn API | https://platform.simular.ai/documentation/api-reference/learn.md |
| 23 | Sai — Structured output (`success_criteria`) | https://platform.simular.ai/documentation/concepts/structured-output.md |
| 24 | Sai — Approvals | https://platform.simular.ai/documentation/concepts/approvals.md |
| 25 | Sai — Billing and limits | https://platform.simular.ai/documentation/concepts/billing-and-limits.md |
| 26 | Sai — Computers | https://platform.simular.ai/documentation/concepts/computers.md |
| 27 | Simular — "Sai tops OSWorld 2.1" (Aug 28 2026; updated Oct 2 2026) | https://www.simular.ai/articles/sai-tops-osworld-2-0 |
| 28 | OSWorld 2.0 site (leaderboard, metrics, failure cases) | https://osworld-v2.xlang.ai/ |
| 29 | OSWorld 2.0 paper — abstract | https://arxiv.org/abs/2606.29537 |

## 8. Revision log

- **v3, 2026-11-22.** §2.6 added: cross-check against finding m2-01 (in total, 8
  named products plus a screenshot-only control; four overlaps). Overlapping claims
  agree wherever both could be checked — Orgo's contested credit and its UUID/instance_id
  contradiction were found in both documents — and m2-01's billing argument is adopted
  with its own hedge (machine-hour or credit) as the economic baseline for the hcu+shell
  decision rule.
- **v2, 2026-11-21 (after independent verification).** Fifteen must-fix corrections applied,
  all reproduced by the verifier against the same sources: evaluated-vs-released HCU rows
  separated (Table 2 vs Table 4 costs and latencies); the evaluated version's `assert_ax`
  postconditions replaced by the released ordered waits; the Sai fork-absence claim
  downgraded to "not found in an incomplete index"; Orgo's two `NOT_FORKABLE` codes and the
  misattributed baseline limit fixed (account-limits.md, not fork.md); the Sai escalation
  re-priced at 2.0's $15.70; the metric comparison split into version/metric/re-scoring;
  "the comparison neither vendor authored" withdrawn (Microsoft authored it); Cua stars and
  the FSL-1.1-MIT subtree; HCU's Apache-2.0 OSWorld-V2 subtree; Cua's benchmark claim scoped
  to the pages actually read; Sai's `transitions`/`probe` 400 roadmap and the learn-time
  `reset`/`testResult` caveats added; Pass^3 reframed as our choice; "no replay artefact"
  scoped to the documented surface; the 2–9 s screenshot cost attributed to local
  perception; Orgo's free credit and Sai's one-task-per-computer stated precisely.
  Omissions now named: OpenAI's 72.60% offline-subset row, binary as OSWorld 2.0's primary
  metric, HCU's skill ablation, the answer-writing failure class (§3.7), Cua's experimental
  Linux desktops, HCU's maturity (65 stars) versus Cua/Sai as the real incumbents.

STATUS: complete | All four named competitors documented from primary docs on 2026-11-21; nothing was executed (no keys/installs), so every score is vendor- or paper-reported, and Orgo's two own pages disagree on starting credit ($3 vs $5/$2).