# Finding M2-01 — Competitive teardown: what six computer-use products expose to developers

> **Status: research input, not a product decision.**
> The earlier "M2 = MCP/API" direction is **retracted** pending MVP Discovery
> (Linear P-TIF-5). This finding feeds Discovery's choice between
> **A** (verified desktops for coding agents), **B** (verified ops for software
> without APIs), and **C** (branchable desktops). Where this doc recommends a
> surface or a build, read it as *one option's requirements*, not as the decided
> wedge. Task-design implications route to the Evaluation Foundry (P-TIF-6).

Date: 2026-11-21. Level: L1 (vendor/repo primary docs, fetched and read directly).
Scope: developer surface, action-response shape, outcome proof, pricing, OS support.

## Question

For each of Cua, Anthropic computer use, OpenAI computer use/Operator, Simular
Agent S, UiPath agentic automation/Autopilot, and heyclicky: what does a
developer actually get to call, what exactly does one action call return, and
does any of them return a result that *proves the outcome* rather than
confirming the action was delivered?

Definition used throughout — **proves outcome**: the response contains a verdict
about postcondition/application state that was read from something other than
the act itself, and that verdict can be negative (so a claimed success can fail).
Action echoes, screenshots, and model self-reports are *not* outcome proof.

## Evidence

### 1. Cua (`github.com/trycua/cua`)

Primary: `README.md`; `libs/cua-driver/README.md`;
`cua.ai/docs/cua-driver/concepts/how-cua-driver-works`;
`cua.ai/docs/cua-driver/reference/mcp-tools` and its
`apps-windows-and-screen` subsection;
`cua.ai/docs/cua-driver/guides/use-the-sdk`; `cua.ai/pricing`;
`legal/COMMERCIAL.md`; `libs/cua-driver/docs/mcp-protocol-and-skills.md`.

- **(a) Surface.** MCP over stdio: `cua-driver mcp` (`README.md`
  "Integration surfaces"; protocol doc: modern MCP `2026-07-28` plus legacy
  `2025-06-18`). Typed SDKs: Python `cua_driver`, TypeScript
  `@trycua/cua-driver`, Rust `cua-sdk`, over UniFFI, in-process or via daemon.
  CLI: `cua-driver call <tool>`. Separate sandbox SDK (`cua`, `cua-sandbox`) for
  VMs/containers. ~70 tools in the reference, e.g. `get_window_state`,
  `click`, `type_text`, `hotkey`, `run_steps`, `verify_state`.
- **(b) Action response shape.** Per the "Action results" table
  (`reference/mcp-tools`), `click`, `double_click`, `right_click`, `drag`,
  `scroll`, `type_text`, `press_key`, `hotkey`, `set_value` return
  `path` (delivery rung: `ax`/`cgevent`/`pixel`/`x11_atspi`/`msaa`…),
  `verified` (`true`/`false`/absent), `effect`
  (`confirmed` | `unverifiable` | `suspected_noop`), `escalation`
  (`{recommended: "px"|"foreground"|"page", reason}`). SDK `ToolResult` carries
  `text`, `images`, `structured_json`, `is_error`, `error_code`, `verified`,
  `degraded` (use-the-sdk).
  The docs state the limit plainly: *"A delivered event is not an applied
  change"* and *"A tool returning `ok` is not evidence"* (how-it-works).
  `verified: true` is only accessibility read-back of that one widget.
  **Additionally** Cua ships a separate read-only tool, `verify_state`:
  *"Deterministically verify bounded predicates against one exact window…
  Predicate results are satisfied, unsatisfied, or unknown; unknown never implies
  success."* Inputs `expect` (1–8 predicates, AND), `stable_samples` (default 2),
  `timeout_ms` (default 5000), optional `include_screenshot` (screenshot returned
  as *uninterpreted* evidence). Platforms: macOS, Linux, Windows.
- **(c) Pricing.** Cua Spaces (desktop-sharing app): Free $0; Pro $180/yr
  ($15/mo) or $18/mo; Teams $300/seat/yr ($25/seat/mo) or $30/seat/mo
  (`cua.ai/pricing`). Driver and SDK are MIT and free of charge; no published
  per-call or per-machine driver price — `not_reported`.
- **(d) OS.** Driver: macOS, Linux, Windows. Sandbox images: Linux, Windows,
  macOS. Spaces app: macOS 26+ natively, Windows (preview) and Linux builds
  offered.

### 2. Anthropic computer use

Primary: `platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool`
(current `computer_toolset_20260801`; earlier `computer_20251124`,
`computer_20250124` with beta headers `computer-use-2025-11-24` /
`computer-use-2025-01-24`).

- **(a) Surface.** A Messages API client toolset, not an execution service. One
  `{"type": "computer_toolset_20260801"}` entry yields 17 member tools
  (`screenshot`, `left_click`, `type`, `zoom`, …); every `tool_use` block has
  `toolset_name: "computer"`. Inside the toolset, the action moved from
  `input.action` to the block `name`; the earlier `computer_20250124` form was
  `{"type":"tool_use","name":"computer","input":{"action":"left_click",
  "coordinate":[500,300]}}` (doc, "Migrate from `computer_20251124`").
- **(b) Response shape.** The *API* returns `tool_use` blocks; the
  *application* returns one `tool_result` per block. Quoted verbatim:
  `{"type":"tool_result","tool_use_id":"toolu_…","toolset_name":"computer",
  "content":[{"type":"text","text":"OK"}]}`. Doc text: *"Only `screenshot` and
  `zoom` results need an image; for the other members, a short text
  acknowledgment such as `OK` is enough"*, and *"a short text such as `OK` is
  enough for the other actions."* Failures are `is_error: true`. So the response
  is a screenshot and/or an acknowledgment of execution — you write it yourself.
  Nothing about postcondition state. The limitations section is explicit:
  *"Always carefully review and verify Claude's computer use actions and logs.
  Do not use Claude for tasks requiring perfect precision…"*.
- **(c) Pricing.** No computer-use-specific fee; billed as normal tool use plus
  token overhead. Published: `computer_toolset_20260801` default members add
  ~4,500 input tokens (~4,590 on Sonnet 5, ~4,520 elsewhere); `computer_20250124`
  tool definition ~735 input tokens; 466–499 system-prompt tokens; screenshots
  billed as image input. Per-token prices: `not_reported` here (pricing page not
  fetched in this pass; out of scope for this question).
- **(d) OS.** None. Anthropic ships no desktop executor — the VM/container is
  the caller's (reference implementation: Docker). Platform support listed is
  per API platform (Claude API, Bedrock, Google Cloud, Foundry).

### 3. OpenAI computer use / Operator

Primary: `developers.openai.com/api/docs/guides/tools-computer-use` (and
`…-integration`); `openai.com/index/introducing-operator/`;
`openai.com/index/introducing-chatgpt-agent/`.

- **(a) Surface.** Responses API tool `tools: [{type: "computer"}]` (current).
  The model returns `computer_call` items; the developer supplies a *driver*.
  The legacy research-preview tool `tools: [{type: "computer_use_preview"}]` on
  model `computer-use-preview` is documented only as a migration source
  (`tools-computer-use-integration` §"Migration from computer-use-preview":
  preview = one `action` per call, current = batched `actions[]`, and
  `truncation: "auto"` no longer required). **Operator itself was retired as a
  developer target**: the Operator post carries the update *"Operator is now
  fully integrated into ChatGPT as ChatGPT agent… the standalone Operator site
  (operator.chatgpt.com) will sunset"* (July 17, 2025 update), and the
  ChatGPT-agent post exposes agent mode in the ChatGPT app only — it describes
  no API for that agent. Operator's developer surface is therefore
  `not_reported`; there is none.
- **(b) Response shape.** Request direction (model → driver):
  `{"type":"computer_call","call_id":"call_002","actions":[{"type":"click",
  "button":"left","x":405,"y":157}, …]}`, with
  `pending_safety_checks` on the call. Answer direction (developer → model):
  `{"type":"computer_call_output","call_id":"call_002","output":{"type":
  "computer_screenshot","image_url":"data:image/png;base64,…",
  "detail":"original"}}`. The doc is explicit that `status: "completed"` means
  only that the model finished generating — *"your application still needs to
  execute it"*.
- **(c) Pricing.** Token-based per Responses request; screenshots count as image
  input. Published per-token rates and computer-tool surcharges:
  `not_reported` (pricing page not fetched in this pass). Operator
  consumer-plan message quotas (400/mo Pro, 40/mo others) are product pricing,
  not a developer price.
- **(d) OS.** None imposed. The sample app ships JavaScript/Playwright and
  Python/PyAutoGUI drivers; the integration guide's rehearsal desktop is a
  Debian/XFCE Docker container.

### 4. Simular Agent S

Primary: `github.com/simular-ai/Agent-S` `README.md`,
`gui_agents/s3/README.md`; `platform.simular.ai/documentation`,
`/documentation/api-reference/message`, `/documentation/api-reference/turns`,
`/documentation/concepts/structured-output`, `/pricing`.

- **(a) Surface.** Two things. (i) Open-source library `pip install gui-agents`:
  Python `AgentS3(engine_params, grounding_agent)` + `OSWorldACI` grounding,
  `agent.predict(instruction=…, observation={"screenshot": bytes})` returning
  `(info, action)` — you `exec(action[0])` yourself. CLI `agent_s`.
  (ii) Hosted **Sai API**: `POST /v1/agents/message` over HTTPS, Python/TS/Go/
  Java/C#/Ruby SDKs, and the `@simular-ai/sai-mcp` MCP server with tools
  `sai_task_start`, `sai_task_wait`, `sai_task_approve`, `sai_task_abort`,
  `sai_machines`, `sai_models`, `sai_upload`, plus `sai_control_*`.
- **(b) Response shape.** Turn record: `{turnId, sessionId, machineId, status,
  output, reason_code, raw_answer, usage, trajectory:{recorded,url}, evidence[],
  output_errors[], template, inputs}`. `status` ∈ running | needs_input |
  finalizing | succeeded | failed. Optional `options` add
  `output_schema` (JSON Schema, ≤32 KB) → typed `output`; `success_criteria`
  (string ≤4,000 chars, **or 1–20 checks** `{id, check, returnEvidence?}`) →
  `evidence: [{id, passed, score, evidence?}]`; `idempotency_key`;
  `recordTrajectory`.
- **Verification nuance (the important one).** `success_criteria` is a
  *model judgement*: *"A model decides whether the result meets it"*; each check
  is *"scored from 0 to 1 (`score`) and passes at 0.5 or above"*; and *"The checks
  read the turn's record… so a page can influence them. Treat a pass as evidence,
  and verify high-stakes results in your own system."* `criteria_unchecked` is a
  distinct failure reason, but there is no three-valued pass/fail/unknown verdict
  and no readback of application state independent of the agent's own record.
- **(c) Pricing.** Explore free (daily credits, limited Windows cloud computer);
  Pay as you go **$50/month**; Enterprise custom (`/documentation` key facts,
  `/pricing`). Published benchmark cost: $14.34/task on OSWorld 2.1
  (leaderboard, vendor-reported) — a benchmark cost, not a product price.
- **(d) OS.** Hosted cloud computers: Windows, Linux. Bring-your-own: Mac,
  Windows. Library: macOS, Windows, Linux.

### 5. UiPath agentic automation / Autopilot

Primary: `docs.uipath.com/agents/automation-cloud/latest/user-guide/about-this-guide`;
`docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests`;
`docs.uipath.com/autopilot`; `uipath.com/pricing`.

- **(a) Surface.** Studio (low-code) and Studio Web; coded agents (code-based
  agents deployable to the platform); Orchestrator OData APIs
  (`/orchestrator_/odata/Jobs`, `…/Jobs/UiPath.Server.Configuration.OData.StartJobs`);
  Maestro for BPMN orchestration; Autopilot as the in-product AI layer
  (`docs.uipath.com/autopilot`). A `/agents/.../api-guide/agents-api` page for a
  dedicated agents API returned no API content on fetch (site fell back to the
  publication index) — agent-execution REST surface beyond Orchestrator jobs:
  `not_reported`.
- **(b) Response shape.** `StartJobs` returns job records
  `{Key, StartTime, EndTime, State, Source, BatchExecutionKey, Info,
  CreationTime, StartingScheduleId, Id, Type, InputArguments, OutputArguments}`;
  `State` observed values `Pending`, `Successful`, `Faulted`; failure detail in
  free-text `Info` (example: `"Logon failure: unknown user name or bad password"`).
  A job's `State: Successful` reports that the *workflow ended without throwing* —
  a control-flow outcome, not a verified application postcondition. The Healing
  Agent and ScreenPlay features (pricing-page add-ons) repair automation
  selectors; nothing in the fetched docs describes a per-action receipt that
  proves a business postcondition.
- **(c) Pricing.** Community free forever; Basic **starting at $25/month**;
  Standard and Enterprise "Contact Sales" (no number). Test Cloud add-ons
  published: Performance Testing $20K/2,500 VUs; Screenplay $10K/50K runs;
  Self-Healing $5K/5K heals; Enterprise extra ALM connector +$5K. Limits:
  Basic 2 robots, 5 Basic + 5 Plus + 1 Pro users.
- **(d) OS.** Robots/Studio run on Windows (attended/unattended); Orchestrator
  is cloud-hosted or self-hosted on Linux VMs/Kubernetes (AKS/EKS/OpenShift) or
  air-gapped.

### 6. heyclicky (`heyclicky.com`)

Primary: `https://www.heyclicky.com/` (also `https://www.heyclicky.com/docs`,
which serves the same landing page; downloads point at
`github.com/farzaa/clicky-releases/releases/latest/download/HeyClicky.dmg`).

- **What it is.** It exists and it is a real computer-use product, but a
  *consumer desktop companion*, not a developer platform. Meta description:
  *"an ai buddy for your mac or windows pc. ask out loud and it sees your screen,
  teaches you any app and runs agents for you."* Features: push-to-talk hotkey,
  points at where to click, draws on screen, voice answers, "agents"
  (research/write/build), routines, and on the Max tier "drives your computer all
  day".
- **(a) Surface. None found.** The site contains no API, SDK, MCP server, CLI,
  webhook, or developer documentation; the only public artifacts are `.dmg`
  downloads. `heyclicky.com/docs` renders the marketing page. Explicitly, the
  FAQ says apps work with *"no plugins or integrations needed"* — the opposite
  of a developer surface.
- **(b) Response shape.** `not_reported` (no developer interface exists to
  return anything).
- **(c) Pricing.** Free $0 (limited daily usage, 2 app connections); Pro $16/mo
  billed yearly ("save $4/mo"); Max $80/mo billed yearly ("save $20/mo"); $10
  usage reset; student 50% off first month. Per-action or API pricing:
  `not_reported`.
- **(d) OS.** macOS Sonoma 14.2+; Windows 10/11.

## Teardown table

| Product | Developer surface | Action response shape | Proves outcome? | Pricing | OS support |
|---|---|---|---|---|---|
| **Cua** | MCP stdio (`cua-driver mcp`, MCP `2026-07-28`); SDKs Py/TS/Rust; CLI `cua-driver call` (`README.md`; `docs/mcp-protocol-and-skills.md`) | `{path, verified: true\|false\|absent, effect: confirmed\|unverifiable\|suspected_noop, escalation:{recommended,reason}}` (`reference/mcp-tools` §"Action results"); SDK `ToolResult{text,images,structured_json,is_error,error_code,verified,degraded}` | **Partly.** Per-action: accessibility read-back of the one widget only (`verified`). Separately, `verify_state` gives a deterministic predicate verdict `satisfied\|unsatisfied\|unknown` (`reference/mcp-tools/apps-windows-and-screen`) — still accessibility state, absence conservative `unknown`. No document/file postcondition. | Spaces Free / $180-yr Pro / $300-seat-yr Teams (`cua.ai/pricing`); Driver+SDK MIT, no per-call price `not_reported` | macOS, Linux, Windows (Spaces app: macOS 26+, Windows preview, Linux) |
| **Anthropic computer use** | Messages API client toolset `computer_toolset_20260801` (17 members); earlier `computer_20251124`/`computer_20250124` + beta header; no executor | `tool_result` per `tool_use`: `{"type":"tool_result","tool_use_id":…,"toolset_name":"computer","content":[{"type":"text","text":"OK"}]}`; image only for `screenshot`/`zoom`; `is_error:true` on failure | **No.** Execution acknowledgment + screenshot; the app writes it. Docs: "a short text such as `OK` is enough", "Always carefully review and verify" | No feature fee; toolset adds ~4,500 input tokens (~4,590 Sonnet 5); `computer_20250124` def ~735 tokens; per-token price `not_reported` | None — caller's VM/container (reference: Docker) |
| **OpenAI computer use / Operator** | Responses `tools:[{type:"computer"}]` + developer-supplied driver; legacy `computer_use_preview` (migration only); Operator sunset — agent mode is ChatGPT-app-only | `computer_call{call_id, actions[], pending_safety_checks}` → `computer_call_output{call_id, output:{type:"computer_screenshot", image_url, detail:"original"}}`; `status:"completed"` means model finished, "your application still needs to execute it" | **No.** Screenshot is a next-turn observation; no postcondition verdict. Driver may refuse actions | Token-based; computer-tool surcharge/rates `not_reported`; Operator consumer quotas (400/mo Pro) are not a dev price | None imposed; sample drivers Playwright and PyAutoGUI (Linux rehearsal container) |
| **Simular Agent S** | `pip install gui-agents` (`AgentS3.predict()` → `(info, action)`, caller `exec`s); Sai API `POST /v1/agents/message`; `@simular-ai/sai-mcp` (`sai_task_start/wait/approve/abort`) | Turn record `{turnId,status,output,reason_code,raw_answer,usage,trajectory,evidence[],output_errors[]}`; `status` running\|needs_input\|finalizing\|succeeded\|failed | **No — model-judged.** `success_criteria` → `evidence[{id,passed,score,evidence?}]`, "a model decides", score ≥0.5 passes, "a page can influence them… verify high-stakes results in your own system". No `unknown`, no app-state readback | Explore free; Pay-as-you-go $50/mo; Enterprise custom (`/pricing`); library free | Cloud: Windows, Linux; BYO: Mac, Windows; library: macOS/Windows/Linux |
| **UiPath** | Studio / Studio Web; coded agents; Orchestrator OData (`StartJobs`, `GET /odata/Jobs`); Maestro BPMN; Autopilot (in-product) | Job record `{Key, StartTime, EndTime, State, Source, Info, InputArguments, OutputArguments}`; `State` = Pending/Successful/Faulted; failure text in `Info` | **No.** `Successful` = workflow completed without fault; free-text `Info` is not a postcondition; no per-action receipt in fetched docs | Community free; Basic from $25/mo; Standard/Enterprise "Contact Sales" `not_reported`; add-ons Screenplay $10K/50K runs, Self-Healing $5K/5K heals, Perf $20K/2,500 VUs | Robots/Studio on Windows; Orchestrator cloud or self-hosted Linux/K8s |
| **heyclicky** | **None.** Consumer macOS/Windows app; no API/SDK/MCP/CLI/docs; `/docs` serves the landing page; downloads are `.dmg` only | `not_reported` (no developer interface) | **No.** No programmatic result at all | Free $0; Pro $16/mo billed yearly; Max $80/mo billed yearly; API pricing `not_reported` | macOS Sonoma 14.2+; Windows 10/11 |

## Where none of them prove outcomes

The structural gap is the same in five of six, and it is a gap in the *contract*,
not in the engineering quality of any one product.

1. **The response describes the act, not the world.** Anthropic's contract asks
   the integrator for a literal `"OK"` for every non-screenshot action; OpenAI's
   contract takes a PNG of the screen *after* — a fresh observation, not a
   verdict; UiPath's `State: Successful` reports that a workflow did not throw.
   In each case the party that performed the act also authors the account of it.
   Anthropic's own limitations section concedes the consequence: *"Always
   carefully review and verify Claude's computer use actions and logs."*
2. **Where a verdict exists, the judge shares the agent's inputs.** Simular is
   the only vendor shipping an explicit `evidence` array, and its docs disqualify
   it as independent proof in the same paragraph: the checks *"read the turn's
   record… so a page can influence them"*, pass at a 0.5 model score, and the
   guidance is *"verify high-stakes results in your own system."* Right shape,
   wrong witness.
3. **Cua comes closest and stops exactly at the seam Myco targets.** `effect`
   and `verified` are read back through the accessibility API — genuinely
   non-self-reported — but only for the widget just touched (`verified: true`
   "only for accessibility read-back"), and Cua states the boundary itself: *"A
   tool returning `ok` is not evidence"* and *"A delivered event is not an
   applied change."* `verify_state` then generalises to bounded window/accessibility
   predicates with `satisfied | unsatisfied | unknown` and `unknown never implies
   success` — structurally Myco's three-valued verdict — yet it *"evaluates
   structured window/accessibility state"* and treats absence as `unknown`
   unless the search domain is proven exhaustive. It cannot see a saved `.xlsx`
   on disk, cannot compare a cell value to a host-computed expectation, and does
   not close/reopen the document. That is precisely M1's UNO-readback +
   persisted-file-parse pair (ADR-0002/ADR-0005).
4. **No product returns a portable receipt.** Nothing in these six surfaces an
   artifact a second party can check per action: no content hash of the saved
   file, no expected-vs-actual pair, no signed verdict, no distinct "could not
   look" channel separate from "looked and failed". Simular's `criteria_unchecked`
   is the nearest thing, and it is scoped to a model check, not to an unreadable
   artifact.
5. **The installed base optimises for the opposite.** heyclicky's consumer
   framing ("screenshots are never stored"), Anthropic's data-retention stance
   (client-side tool, screenshots stay in your environment), and Operator's
   sunset into a ChatGPT-app feature all point away from a per-action audit
   artifact. Nobody is currently competing on "prove it happened correctly."

`[INFERENCE]` The commercial reason: these products sell *capability* (an agent
that can do the task), and a verified-outcome contract would expose a
false-success rate that a capability sale never has to publish. Myco's
differentiator is not a better actor but a second, independent witness.
differentiator is not a better actor but a second, independent witness.

## Decision

**Adopt** — this teardown is the baseline Myco M2 compares against, with three
concrete consequences:

- **Adopt Cua's vocabulary, not Cua's scope.** Myco's receipt should carry an
  `effect`-style per-action truth (`confirmed | unverifiable | suspected_noop`)
  *plus* a separate three-valued `verified | refuted | uncertain` postcondition —
  Myco already has the second (ADR-0002); the first is a receipt field worth
  adding, because it is the honest way to say "delivered, not applied".
- **Adopt `verify_state`'s honesty rule.** "Unknown never implies success" and
  conservative absence are the correct semantics for M1's `uncertain`; cite Cua
  as independent confirmation from a competitor, not as a source of design.
- **Reject model-judged criteria as proof.** Simular's `success_criteria` is
  useful for its own product but fails the independence bar by its own docs.
  Myco must not adopt a scored-judge verdict; it may adopt the *shape*
  (`{id, passed, evidence}` per criterion) with host-side expected values as the
  witness.

The public comparison section of M2 can state, with pointers: five of six
developer surfaces return an act-echo or a screenshot; one (UiPath) returns a
workflow-exit state; one (Cua) returns accessibility read-back scoped to the
acted widget plus a bounded window-predicate verdict; none returns a persisted
artifact compared against host-computed expectations.

## Proposed smallest experiment

**Not needed to resolve the decision** — the claims are documentary. One cheap
confirmation is worth doing only when the comparison page is drafted:

- 30 minutes, no paid install: on the Windows 11 ARM64 VM (or a scratch Linux
  container), call Cua Driver's `verify_state` against a Calc window with a
  **deliberately wrong** predicate (e.g. `expect` a cell text that was never
  entered) and confirm all three outcomes are reachable, and that `unknown` is
  returned for an absent element. Expected cost: a handful of
  `cua-driver call` invocations. This validates that the "closest competitor"
  row is accurate rather than a doc reading.
- Everything else in the table is a quote; no experiment improves on a quote.

## Next action

1. Feed the "Where none of them prove outcomes" section to the M2 public
   comparison doc as its spine — it is the thesis, and it now has a pointer per
   claim.
2. Add an `effect`-class field design note to the M2 receipt schema (Cua's
   `confirmed | unverifiable | suspected_noop`), keeping Myco's three-valued
   postcondition verdict separate.
3. Cite `cua.ai/docs/cua-driver/concepts/how-cua-driver-works` in ADR-0002's
   "independent confirmation" list: an external vendor independently adopted
   three-valued verification and the "unknown never implies success" rule.
4. Do **not** cite heyclicky in the comparison table as a computer-use agent
   competitor; cite it, if at all, as consumer-side evidence that the market
   currently sells capability without audit.

## Reopen if

- Cua ships a document- or file-level postcondition (e.g. `verify_state`
  predicates over persisted files, or a receipt artifact with a hash). That
  would collapse Myco's stated delta to session shape, receipt format, and the
  second app.
- Simular's `success_criteria`/`evidence` becomes readback-based (checks
  evaluated against application state rather than the turn record) — it would
  become the nearest competitor and must be re-teardowned.
- Anthropic or OpenAI adds a postcondition field to the `tool_result` /
  `computer_call_output` contract.
- UiPath publishes a per-action or per-agent verdict API beyond `Jobs.State`.
- Any of these six publishes a price for per-action verification work; today all
  are `not_reported`, and a price would change the economics comparison.

## Cost spent

Tool calls: 30 (1 directory listing, 1 glob, 1 sibling-findings read, 1
PIPELINE.md read, ~20 primary-source fetches across cua.ai/raw.githubusercontent/
platform.claude.com/developers.openai.com/openai.com/platform.simular.ai/
docs.uipath.com/uipath.com/heyclicky.com, 4 targeted greps, 1 `web_search`
attempt that failed with HTTP 402 and was abandoned). Tokens: not reported by the
harness. No installs, no accounts, no VM access; `myco-win11` untouched.

Unverified / limitations of this finding:

- `[UNVERIFIED]` Whether UiPath exposes a dedicated agents-execution REST API —
  `docs.uipath.com/agents/…/api-guide/agents-api` did not resolve to API content
  (site fallback). Orchestrator jobs are the confirmed surface.
- `[UNVERIFIED]` Per-token prices for Anthropic and OpenAI computer use — their
  pricing pages were not fetched, so `not_reported` above means "not fetched in
  this pass", not "not published".
- `[UNVERIFIED]` Agent-S repository licence text was not read.
- `[INFERENCE]` The motive sentence in "Where none of them prove outcomes" is
  reasoning, not a sourced claim.
- `web_search` was unavailable (HTTP 402 from the local search provider), so no
  discovery-tier cross-check was performed; every claim above comes from a
  primary page fetched directly.

---
