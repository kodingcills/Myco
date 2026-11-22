# Finding M2-02 — v0 MCP tool surface for verified desktop operations

> **Status: research input, not a product decision.**
> The earlier "M2 = MCP/API" direction is **retracted** pending MVP Discovery
> (Linear P-TIF-5). This finding feeds Discovery's choice between
> **A** (verified desktops for coding agents), **B** (verified ops for software
> without APIs), and **C** (branchable desktops). Where this doc recommends a
> surface or a build, read it as *one option's requirements*, not as the decided
> wedge. Task-design implications route to the Evaluation Foundry (P-TIF-6).

Date: 2026-11-21. Level: L1 (primary specs read directly; every claim carries a section pointer).

## 1. Question

What should Myco's v0 MCP tool surface be — operation granularity, error signalling,
idempotency, long-running operations, receipts in the response, permission gating — such
that any agent (Claude Code, Cua, Codex) can call desktop operations and receive proof,
without a verdict the actuator has no right to make?

Sub-questions answered below:

1. One tool per verb, or one `act` tool with a discriminated-union input?
2. Typed error payloads vs bare string messages.
3. Idempotency: keys, or declared hints?
4. Long-running ops: `notifications/progress`, MCP tasks, or blocking calls?
5. Where does the receipt live in the response?
6. How is an irreversible action gated?

## 2. Evidence

### 2.1 MCP specification — tools, results, errors

Sourced from `modelcontextprotocol.io/specification/{2025-06-18,2025-11-25,2026-07-28}/server/tools`.

| Topic | Spec text | Section | Consequence for Myco |
|---|---|---|---|
| Structured output | "Structured content is returned as a JSON object in the `structuredContent` field of a result." | Tools → Data Types → Structured Content (2025-06-18) | Receipt goes in `structuredContent`, not stringified. |
| Back-compat hedge | "a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block." | same | Emit both; text block is the serialization, not a summary. |
| Output schema | "If an output schema is provided: Servers **MUST** provide structured results that conform to this schema. Clients **SHOULD** validate structured results against this schema." | Tools → Structured Content → Output Schema | Declare `outputSchema`; validate on the server before returning. |
| Two error channels | "1. **Protocol Errors**: … Unknown tools / Invalid arguments / Server errors. 2. **Tool Execution Errors**: … API failures, invalid input data, business logic errors" | Tools → Error Handling | `StaleRefError` is a *tool execution* error, not `-32602`. |
| Tool-execution error | `{"content":[…], "isError": true}` | Tools → Error Handling | Plus a structured payload; see §2.7. |
| Invalid-args placement | "Invalid tool arguments are instead reported as tool execution errors, with `isError` set to true" | Schema → `InvalidParamsError` (2026-07-28 schema; not present in 2025-06-18) | Malformed `act` input ⇒ `isError:true`, not JSON-RPC error. |
| Annotations | `readOnlyHint`, `destructiveHint` (default **true**), `idempotentHint` (default **false**), `openWorldHint` (default **true**); "all properties in ToolAnnotations are **hints**" | Schema → `ToolAnnotations` | Hints are advisory only; they cannot carry the gating decision. `destructiveHint` defaults to true — Myco must set it explicitly. |
| Human in the loop | "there **SHOULD** always be a human in the loop with the ability to deny tool invocations … Present confirmation prompts to the user for operations" | Tools → User Interaction Model | Spec pushes confirmation to the *client*, not the server. |
| Tool naming | `name` 1–128 chars, `[A-Za-z0-9_.-]`, case-sensitive, unique per server (SHOULD-level, not a hard MUST) | Tools → Tool Names (2026-07-28) | `myco.act` is a legal name. |
| Statelessness | "The protocol has no concept of a state handle; … a handle is an ordinary string in a tool result and an ordinary argument to subsequent tool calls." | Tools → Stateful Tools (2026-07-28, non-normative) | `session_id` as an explicit argument, minted by `create`. Already what `myco-rt-mcp` does. |
| Handle hygiene | Authorization / Opacity / Lifetime / Expiry errors — "A call against an expired or unknown handle should return a tool execution error that says so" | Tools → Stateful Tools | Opaque refs and `StaleRefError` are the spec's own recommended shape. |

**Long-running operations.** Two separate mechanisms exist and must not be conflated:

- **Progress** (all revisions): client supplies `progressToken` in `_meta`. "The `progress` value
  **MUST** increase with each notification"; "Progress notifications **MUST** stop after
  completion"; the receiver **MAY** send none
  (`…/2025-06-18/basic/utilities/progress`, §Progress Flow + §Behavior Requirements). This is
  *cosmetic* — it does not change the fact that `tools/call` blocks.
- **Tasks** (2025-11-25, experimental): `tools/call` with `task` returned as `CreateTaskResult`;
  poll `tasks/get` respecting `pollInterval`; `tasks/result` blocks until terminal; states
  `working | input_required | completed | failed | cancelled`
  (`…/2025-11-25/basic/utilities/tasks` §Task Status Lifecycle). Statuses are *protocol-level*,
  not outcome-level: a task can `complete` and its `CallToolResult` still carry
  `outcome.kind:"failed"`.
- **Migration risk:** tasks were then "Move[d] … out of the core protocol and into an official
  extension (`io.modelcontextprotocol/tasks`)"; `tasks/result` and `tasks/list` were removed and
  servers may return handles unsolicited (2026-07-28 §Changelog, major change 6). Building on
  `tasks/result` today wires Myco to a retired shape.

**Elicitation** (2025-11-25): three-action model `accept | decline | cancel`
(`…/2025-11-25/client/elicitation` §Elicitation Responses). Form mode's `requestedSchema` is
"limited to flat objects with primitive properties only" (§Requested Schema) — so a structured
*grant* form is expressible, but not a nested one. In 2026-07-28 elicitation moves under the
MRTR `input_required` pattern instead (§Changelog items 7 and minor 11).

### 2.2 Anthropic tool use

| Pattern | Source | Text / fact |
|---|---|---|
| `tool_result` envelope | `platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls` §Handling results from client tools | `tool_use_id`, `content`, `is_error`; "Add a `user` message with one `tool_result` block for each `tool_use` block … even if the tool failed." |
| `is_error` semantics | same §Handling errors with is_error | "Set to `true` if the tool failed or the call was invalid." |
| Error message quality | same, Tip | "Write instructive error messages. Instead of generic errors such as `"failed"`, include what went wrong and what Claude should try next (for example, `"Rate limit exceeded. Retry after 60 seconds."`)." |
| Retry bounding | same | "Claude might then call the tool again … so limit how many retries your loop allows." |
| Strict inputs | same, Tip | `strict: true` "guarantees that tool inputs always match your schema exactly". |
| **Granularity** | `platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools` §Best practices for tool definitions | "**Consolidate related operations into fewer tools.** Rather than creating a separate tool for every action (`create_pr`, `review_pr`, `merge_pr`), group them into a single tool with an `action` parameter. Fewer, more capable tools reduce selection ambiguity". |
| Response shaping | same | "Return semantic, stable identifiers … rather than opaque internal references, and include only the fields Claude needs". |
| Tool count | `anthropic.com/engineering/writing-tools-for-agents` §Choosing the right tools for agents | "More tools don't always lead to better outcomes … Too many tools or overlapping tools can also distract agents." |
| Namespacing | same §Namespacing your tools | Prefix by service (`asana_search`); "Effects vary by LLM and we encourage you to choose a naming scheme according to your own evaluations." |
| Error responses as steering | same §Optimizing tool responses for token efficiency | "you can prompt-engineer your error responses to clearly communicate specific and actionable improvements, rather than opaque error codes or tracebacks." |
| Truncation budget | same | "For Claude Code, we restrict tool responses to 25,000 tokens by default." |

**Tension to record:** Anthropic's consolidation advice is explicit, but its stated reason is
*ambiguity/token* reduction for a model choosing among near-identical verbs. Myco's verbs are
not near-identical (`observe` vs `act` vs `evidence`), and Anthropic's own guidance to
"enumerate fewer, clearer tools" is a performance heuristic, not a correctness rule. Where the
two conflict, correctness wins (§3).

### 2.3 OpenAI function calling

| Topic | Source | Text |
|---|---|---|
| Schema shape | `developers.openai.com/api/docs/guides/function-calling` §Function tool example | `{type:"function", name, description, parameters, strict:true}` |
| Strict requirements | same §Strict mode | "`additionalProperties` must be set to `false` for each object … All fields in `properties` must be marked as `required`." Optional via `"type": ["string","null"]`. |
| Recommendation | same | "We recommend always enabling strict mode." |
| Fallback | same | Responses "will attempt to normalize your schema into strict mode when possible, and will fall back to non-strict"; the tool then reports `strict: false`. |
| Parallel calls | same §Parallel function calling | Model may emit several calls in one turn; "You can prevent this by setting `parallel_tool_calls` to `false`". |
| Result correlation | same §The tool calling flow | `function_call_output` carries `call_id`. |
| Structured returns | OpenAI Agents SDK, `openai.github.io/openai-agents-python/tools/` §Programmatic Tool Calling | "a structured return annotation … automatically becomes a strict object output schema, and the returned value is validated against that schema before it is returned". |

**Hard constraint for Myco:** strict mode forbids optional properties. Every Myco input schema
must either mark all properties `required` (with `null` unions where genuinely optional) or
accept provider-side normalisation. This is a *provider* constraint, not an MCP one, and it is
the reason the v0 schemas below carry `required` on every property.

**Parallel calls are unsafe for Myco actuation.** Two `act` calls in one turn on the same
session would interleave against one mutating desktop. MCP has no parallel-call prohibition —
MCP's own sampling spec merely notes clients "MAY expose this as an extension"
(`…/2025-11-25/client/sampling` §Parallel Tool Use). The server must therefore serialise.

### 2.4 Reference MCP servers

**`server-filesystem`** (`github.com/modelcontextprotocol/servers`, `src/filesystem/README.md`):

| Observation | Pointer | Reading |
|---|---|---|
| One tool per verb, ~16 tools: `read_text_file`, `write_file`, `append_file`, `edit_file`, `move_file`, `copy_file`, `create_directory`, `list_directory`, … | §Tools | Fine-grained surface, but this is a *filesystem*, not a mutating application. |
| Annotations set on **every** tool, including `openWorldHint:false`, with a per-tool rationale column ("Re‑applying edits can fail or double‑apply") | §Tool annotations (MCP hints) | Rationale-per-tool is the useful artefact; copy the practice. |
| `--read-only` mode registers only `readOnlyHint:true` tools; "a call to it fails as an unknown tool" | §Read-only Mode | **Capability withholding beats per-call refusal** — the strongest, simplest gate. |
| `edit_file` has `dryRun` (default false) | §Tools → `edit_file` | Preview-then-apply is an established pattern in the reference set. |
| Writes to a read-only directory are refused with a full explanatory message naming the path and the reason | §Read-only directories | Error messages that name the exact rule violated. |

**`github-mcp-server`** (`github.com/github/github-mcp-server`):

| Observation | Pointer | Reading |
|---|---|---|
| ~90 tools, but *grouped into toolsets* (`repos`, `issues`, `pull_requests`, …) selected at startup; "Enabling only the toolsets that you need can help the LLM with tool choice and reduce the context size" | README §Tool Configuration | Reduce surface by *configuration*, not by mangling verbs into a union. |
| Consolidated tools carry a discriminating `method` field and return method-discriminated object outputs | `docs/error-handling.md` §Typed Tool Results | Consolidation is done with **strongly typed per-method outputs**, never a loose bag. |
| Layer split: "**User-actionable errors** (authentication failures, rate limits, 404s) should be returned as failed tool calls using the error response functions; **Developer errors** (JSON marshaling failures, internal logic errors) should be returned as actual Go errors" | `docs/error-handling.md` §Design Principles | Exactly the three-way classification Myco needs: refusal / failure / bug. |
| A tool may return `IsError: true` **with a structured status** (`status:"awaiting_user_submission"`) that explicitly "does not mean the issue was created or updated" | same | The precedent for "not-yet-decided" as a first-class, typed result. |
| `structuredContent`/`outputSchema` emitted **only** for protocol `2026-07-28`+; older eras get legacy text | `docs/typed-tool-schemas.md` | Era-gated typed output is real production practice, so Myco must not assume `structuredContent` reaches every client. |

### 2.5 Idempotency and long-running operations

| Source | Text | Relevance |
|---|---|---|
| Temporal, `docs.temporal.io/activity-definition` §Idempotency | "An Activity is idempotent if multiple Activity Task Executions do not change the state of the system beyond the first Activity Task Execution." Also: "You can achieve idempotency … through … unique identifiers, known as idempotency keys … These are enforced by the service you are calling from your Activity, not by the Activity itself." And: "design your Activities to be more granular … However, you must balance this against the potential for a larger Event History". | Keys are enforced by the *callee*; and the granularity trade-off is explicitly two-sided (recovery vs. history size), not a one-way vote for fine tools. |
| Temporal, `docs.temporal.io/activities` | "Larger pieces of functionality should be broken up into multiple Activities. This makes it easier to do failure recovery, have short timeouts, and be idempotent." | The failure-recovery argument for finer operations. |
| Stripe, `docs.stripe.com/api/idempotent_requests` | "Stripe saves the status code and body of the first request made with a given idempotency key after endpoint execution begins. Retries with the same key return the saved response, including `500` errors." Keys ≤255 chars; suggest UUIDv4; "you can remove keys from the system automatically after they're at least 24 hours old"; "The idempotency layer compares incoming parameters to those of the original request and errors if they're not the same". | The canonical semantics: **first response is replayed verbatim**, parameter mismatch is an error, keys expire. |
| MCP `ToolAnnotations.idempotentHint` | Default `false`; meaningful only when `readOnlyHint == false` | A hint, not a mechanism. |
| OpenAI Agents SDK, `…/tools/` §local runtime tools | `needs_approval=True` or a callable policy; "Without an `on_approval` callback, the run pauses before invoking the executor … and returns pending requests in `result.interruptions`" | Approval as a *reversible pause before side effect*, not an error after the fact. |

Note on gaps: neither the MCP spec nor Anthropic/OpenAI tool-use docs define idempotency keys
for agent tools. The only primary definitions found are at the service-API and workflow-engine
level (Stripe, Temporal). `[INFERENCE]` Any idempotency key Myco ships is therefore Myco's
own contract, not an industry-standard agent-tool pattern.

### 2.6 Myco constraints that bound the design

From this repo (not external):

| Constraint | Source |
|---|---|
| Opaque refs bound to a `stateVersion`; acting on a stale one raises `StaleRefError`; ambiguous matches raise `AmbiguousTargetError` | `docs/architecture/m1.md` ADR-0003; `src/core/adapter.ts` |
| Three-way outcome `delivered_verified \| delivered_unverified \| failed`, "never a bare `ok`" | same; `runtime/crates/myco-rt-core/src/ops.rs` `ActionOutcome` |
| `delivered_verified` ≠ application committed; a value write carries `verification_scope:"element_value"` and `application_commit:"not_verified"` | `docs/research/adapters.md` §… items 1 and 12 |
| Verdicts (`verified \| refuted \| uncertain`) belong to the verifier alone; runtime session records **forbid** `verdict` | `docs/architecture/evidence-schema.md` (ADR-0002/ADR-0012 `recordKind`); `docs/architecture/runtime.md` |
| Evidence artefacts must be M1-012-schema-compatible: `trace.jsonl` (TraceEvent) + `result.json` (`RunRecord` or `SessionRecord`) + `ledger.jsonl` | `docs/architecture/evidence-schema.md` |
| Existing runtime MCP server exposes exactly `create/observe/act/evidence/reset/destroy`, stringifies every result into one text block, and uses `isError:true` for failures | `runtime/crates/myco-rt-mcp/src/main.rs` `tool_defs()` / `call_tool()` |
| IRREVERSIBLE gating is a stated product principle: "Gate irreversible actions until the work behind them is verified" | `docs/product/vision.md` §Approach |

## 3. Decision

**Adopt.** A **hybrid surface**: one tool per *phase* (observation, actuation, evidence,
lifecycle) with **exactly one** union-typed actuation tool (`myco.act`) whose union is closed and
whose outcome is three-way; typed error objects carried inside `isError:true` results; receipts
returned as `structuredContent` conforming to an `outputSchema`; idempotency keys on actuation
only; blocking calls plus `notifications/progress` for long operations, with MCP tasks rejected
for v0; irreversible gating done **in the server** by splitting confirm from execute.

Reasons, one per sub-question:

1. **Granularity — hybrid, not either/or.** Anthropic's consolidation advice targets
   near-synonymous verbs; Myco's four *phases* are not interchangeable, so they stay separate
   tools. Within actuation, one tool with a closed union is correct: the union is already closed
   in ADR-0004, the three-way outcome is uniform across members, and the alternative (six tools,
   each returning `ActionOutcome`) would multiply schema surface without changing behaviour.
   GitHub's precedent shows consolidation is only safe when per-method outputs stay typed — so
   `myco.act`'s `outputSchema` must be a union of per-kind variants, not a loose object.
2. **Typed errors.** Bare strings satisfy MCP (§2.1) but fail Anthropic's own guidance (§2.2:
   "include what went wrong and what Claude should try next") and Myco's need to branch on
   `StaleRefError` vs `AmbiguousTargetError`. Keep `isError:true`, put a typed object in
   `structuredContent`, and *also* render a one-line human sentence in `content[0].text`.
3. **Idempotency.** Declared hints alone cannot prevent a double-typed cell (§2.5: hints are
   advisory). Use a server-enforced `idempotency_key` on `myco.act` only, with Stripe semantics
   (replay first response, error on parameter mismatch). `observe`/`evidence` are naturally
   idempotent; lifecycle ops carry hints.
4. **Long-running ops.** Progress notifications are the only mechanism stable across every
   revision Myco may meet. MCP tasks are experimental in 2025-11-25 and reshaped in 2026-07-28
   (§2.1) — adopting them now buys a migration. Block, stream progress, and keep per-call
   timeouts bounded (the runtime already bounds every wait: `Backend::act` "MUST bound all
   waits").
5. **Receipts.** `structuredContent` conforming to `outputSchema`, with the serialized JSON
   duplicated in a TextContent block for era-compatible clients (§2.1 back-compat hedge;
   §2.4 GitHub's era gating proves this is necessary in practice). The receipt *references*
   M1-012 artefacts by path; it does not inline a `trace.jsonl`.
6. **Permission gating.** Do it in the server, not the client. The spec only says clients
   **SHOULD** prompt (§2.1); the filesystem server's `--read-only` proves capability withholding
   is the reliable gate (§2.4); Agents SDK approval is a pre-execution pause, not a post-hoc
   error (§2.5). So: `myco.act` on a class-`irreversible` action returns `needs_confirmation`
   **without actuating**, and the same call with `confirm:{token}` executes.

**Rejected with reasons:**

- **One `myco.act` tool for observe + act + evidence** (the "one tool with a union" extreme).
  Rejected: it collapses read and write into one `destructiveHint`, destroying the
  `read-only` mode that both the filesystem server and Myco's own permissions model rely on.
  It also makes a receipt impossible to return for a pure read without conflating it with an
  action outcome.
- **Six tools per action verb** (`click`, `type_text`, `key_press`, `launch`, …). Rejected:
  duplicates the three-way outcome contract six times, and Anthropic's guidance (§2.2) is
  directly against it.
- **MCP tasks for v0.** Deferred; see §6.
- **Client-side confirmation only.** Rejected: unverifiable, and lets a misconfigured client
  actuate irreversibly.

### 3.1 v0 tool surface — exact names and fields

Namespace prefix `myco.` (legal per §2.1 Tool Names). Seven tools. Every object schema sets
`additionalProperties:false` and marks **all** properties `required` (OpenAI strict mode, §2.3);
genuinely optional values are `type:["T","null"]`.

#### `myco.session.create` — provision

| | |
|---|---|
| in | `{ backend: "qemu-linux" \| "utm-windows", idempotency_key: string }` |
| out | `{ session_id: string, state_version: integer, backend: string, created_at: string }` |
| annotations | `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false` |
| errors | `backend_unavailable`, `permission_denied` |

#### `myco.observe` — read structured state, mint refs

| | |
|---|---|
| in | `{ session_id: string, window: string \| null, include_screenshot: boolean, max_nodes: integer }` |
| out | `{ session_id, state_version: integer, nodes: Node[], windows: Window[], screenshot_artifact: string \| null, truncated: boolean, receipt: Receipt }` |
| `Node` | `{ ref: string, role: string, name: string, value: string \| null, bounds: [x,y,w,h], states: string[] }` |
| annotations | `readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false` |
| errors | `stale_session`, `backend_unavailable` |

`max_nodes` exists because Anthropic's token guidance caps responses (§2.2, 25k default);
`truncated:true` is the visible consequence rather than a silent cut.

#### `myco.act` — the one union-typed actuator

| | |
|---|---|
| in | `{ session_id, action: Action, idempotency_key: string, confirm: { grant: string } \| null }` |
| `Action` | closed union, `kind`-discriminated: `launch{command,args}` \| `click{target: Ref}` \| `typeText{target: Ref,text}` \| `keyPress{keys}` — verbatim ADR-0004 |
| `Ref` | the Rust type is `ElementRef`, not `Ref`: `{ payload: string, issued_at: StateVersion }` where `StateVersion` is a `u64` newtype (`runtime/crates/myco-rt-core/src/state.rs:8-21`). The wire form is `payload: string, issued_at: integer`. |
| out | `{ outcome: Outcome, session_id, state_version_after, receipt: Receipt }` |
| `Outcome` | `{ kind:"delivered_verified", verification:{ scope:"element_value", application_commit:"not_verified", readback: object } }` \| `{ kind:"delivered_unverified", reason: string }` \| `{ kind:"failed", error: TypedError }` \| `{ kind:"needs_confirmation", grant: string, expires_at: string, pending: Action }` |
| annotations | `readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false` |
| `isError` | `true` iff `outcome.kind=="failed"`. `needs_confirmation` is **not** an error. |

Four outcome kinds, not three. `needs_confirmation` is a *distinct* fourth because it is not a
verdict about the world — nothing was attempted. Folding it into `failed` would make "we did not
try" indistinguishable from "we tried and it did not land", which is exactly the ambiguity M1
spent a milestone eliminating.

#### `myco.evidence.export` — the receipt's backing artefacts

| | |
|---|---|
| in | `{ session_id: string, run_id: string \| null }` |
| out | `{ run_id: string, trace_path: string, result_path: string, record_kind: "session", validated: boolean, receipt: Receipt }` |
| annotations | `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false` |
| note | Files conform to `docs/architecture/evidence-schema.md`; `record_kind:"session"` guarantees **no `verdict` field** (ADR-0012). |

#### `myco.session.reset` / `myco.session.destroy`

| | `reset` | `destroy` |
|---|---|---|
| in | `{ session_id, idempotency_key }` | `{ session_id, idempotency_key, confirm: {grant} \| null }` |
| out | `{ session_id, state_version, reset_ms: number, receipt }` | `{ session_id, destroyed: true, receipt }` |
| destructive | `false` | `true` (class `irreversible`, always gated) |

#### `myco.compare` — the M2 differentiator, and the only place a verdict-like word appears

| | |
|---|---|
| in | `{ run_id: string, task_id: string, expected: object }` |
| out | `{ run_id, status:"verified"\|"refuted"\|"uncertain", checks: CheckVerdict[], score: number }` |
| rationale | This tool is the **verifier**, not the actuator. Putting the verdict behind a separate tool makes "verdicts are never the actuator's to make" structural, not a convention: `myco.act` has no field capable of carrying `verified`. |

### 3.2 The receipt

Conforms to `outputSchema`; duplicated verbatim in `content[0].text`.

```json
{
  "receipt_id": "rcpt_01H...",
  "session_id": "sess_7f3a",
  "run_id": "9c2e...",
  "action_kind": "typeText",
  "outcome": "delivered_verified",
  "evidence": {
    "state_version_before": 41,
    "state_version_after": 42,
    "readback": { "element_value": "myco-act-probe" },
    "verification_scope": "element_value",
    "application_commit": "not_verified",
    "screenshot_artifact": "runs/<runId>/obs-42.png"
  },
  "artifacts": {
    "trace_path": "runs/<runId>/trace.jsonl",
    "result_path": "runs/<runId>/result.json",
    "schema": "m1-012"
  },
  "verdict": null,
  "verdict_reason": "verdicts belong to myco.compare, not to the actuator",
  "at": "2026-11-21T10:14:03.221Z"
}
```

**`verdict: null` is deliberate and load-bearing.** The M1-012 `SessionRecord` branch already
forbids `verdict` (`additionalProperties:false`); the receipt carries the field explicitly as
`null` so that a downstream consumer reading *either* shape sees the same fact, and so that a
future schema change cannot quietly start populating it. `application_commit:"not_verified"` is
copied into every receipt because `delivered_verified` is not proof the app committed
(`docs/research/adapters.md`, item 12) — a receipt that hid this would be the exact false
confidence M2 exists to prevent.

### 3.3 TypedError — the error payload

`{ code: "stale_ref" | "ambiguous_target" | "element_not_found" | "session_expired" | "backend_unavailable" | "timeout" | "permission_denied" | "post_action_verification" | "invalid_argument" | "internal", message: string, recoverable: boolean, retry_after_ms: integer | null, details: object }`

- `message` is one instructive sentence per Anthropic's guidance (§2.2).
- `recoverable:true` ⟺ the agent can retry meaningfully after re-observing. `stale_ref` and
  `ambiguous_target` are `recoverable:true` **with a required next step**: re-`observe`. That
  instruction belongs in `message`, because the model reads the message.
- `internal` is the one code that also bubbles a JSON-RPC `-32603` (GitHub's
  user-actionable vs developer split, §2.4).

### 3.4 Where this diverges from the MCP defaults, and why

| MCP default / spec stance | Myco v0 | Why |
|---|---|---|
| Errors are either JSON-RPC or a bare `isError:true` with free text | Always a typed `structuredContent.error` alongside `isError:true` | §2.2 and §2.4 both demand machine-branchable, instructive errors; text-only loses `stale_ref` vs `ambiguous_target`. |
| `ToolAnnotations` are hints; `destructiveHint` defaults **true**; `idempotentHint` defaults **false** | Set every hint explicitly on every tool, with a rationale per tool; gating does **not** trust hints | `server-filesystem` §Tool annotations precedent; a default-`true` `destructiveHint` plus a client that ignores hints yields ungated writes. |
| Confirmation is the **client's** job ("Clients SHOULD prompt") | Server-side `needs_confirmation` round-trip for class-`irreversible` actions | Client behaviour is unverifiable from the server; `docs/architecture/runtime.md` / ADR-0003's permissions model and `docs/product/vision.md` make gating a product invariant. |
| `isError:false` means success | `isError:false` with `outcome.kind=="needs_confirmation"` | `needs_confirmation` is an incomplete request, not a failure; GitHub precedent (§2.4 `awaiting_user_submission`) shows partial states carried outside `isError`. |
| Tasks are the spec's long-op mechanism (experimental) | Not used in v0; `notifications/progress` only | Reshaped between 2025-11-25 and 2026-07-28 (§2.1 change 6); adopting now guarantees rework. |
| No idempotency mechanism | Server-enforced `idempotency_key` on mutating tools | Stripe semantics (§2.5) are the only primary definition; hints are advisory only. |
| No verdict concept | `verdict` in the receipt, always `null` | Enforces ADR-0002 separation structurally. |
| `inputSchema` may omit `additionalProperties` | Every object is `additionalProperties:false` with all properties `required` | OpenAI strict mode requires it (§2.3); omitting it means best-effort calls. |
| Tools may return any text | Response body bounded by `max_nodes` / `truncated` | Anthropic's 25k-token cap (§2.2). |

### 3.5 Serialisation and concurrency

`myco.act` calls against one `session_id` **MUST** serialise server-side. Rationale: OpenAI models
emit parallel calls in one turn (§2.3) and MCP does not prohibit it (§2.1, sampling §Parallel Tool
Use); two concurrent actuations on one desktop are not independently verifiable. A second
concurrent `act` on a busy session returns `{code:"timeout", recoverable:true}` rather than
queueing forever — bounded, per `Backend::act` "MUST bound all waits".

## 4. Proposed smallest experiment

One throwaway MCP stdio server (no VM) with exactly three tools — `myco.observe`,
`myco.act`, `myco.compare`-absent — backed by the existing `FakeApp` (`src/fake/app.ts`), driving
five scripted calls:

1. `myco.observe` → assert `outputSchema` validates and `receipt.verdict === null`.
2. `myco.act` `typeText` with a ref from that observation → assert `outcome.kind`
   `delivered_verified` and `evidence.application_commit === "not_verified"`.
3. `myco.act` again with the **same** `idempotency_key` → assert the byte-identical first
   response is replayed and the fake app recorded **one** write.
4. `myco.act` with a ref from before step 2 → assert `isError:true`,
   `error.code === "stale_ref"`, and that the message names re-`observe` as the next step.
5. Two `myco.act` calls issued without awaiting each other → assert the second receives a
   bounded refusal, not interleaved actuation.

Pass bar: all five assertions hold, and the step-2 `structuredContent` validates against the
declared `outputSchema` with the repo's existing draft-07-subset validator
(`schemas/validate.ts`). This is a script, not a permanent suite; it exists to prove the surface
is implementable before anyone writes the real server.

## 5. Next action

1. File the schema PR: `inputSchema`/`outputSchema` for the seven tools plus `Receipt` and
   `TypedError` as JSON Schema, validated by `schemas/validate.ts`.
2. Extend `runtime/crates/myco-rt-mcp` from six string-returning tools to the seven typed ones —
   the existing `tool_defs()`/`call_tool()` shape is the place to change, and the existing
   `isError` handling stays.
3. Run the §4 experiment against `FakeApp` before touching any VM.
4. Send `myco.compare`'s `outputSchema` to the M1 evidence owner for sign-off, since it is the
   only tool allowed to emit `verified | refuted | uncertain`.

## 6. Reopen-if

- MCP's `io.modelcontextprotocol/tasks` extension stabilises (moves out of experimental) **and**
  a target client (Claude Code, Cua, Codex) ships support — then re-evaluate tasks as the
  long-op mechanism, keeping the `Outcome` union unchanged.
- A client refuses `isError:false` + `outcome.kind:"needs_confirmation"` (treats every non-`ok`
  result as failure) — then move confirmation to a two-tool `myco.act.prepare`/`myco.act.commit`
  pair.
- Field evidence shows models choosing among seven tools measurably worse than among four — then
  fold `myco.session.reset`/`destroy` into `myco.session` with a `verb` field, mirroring the
  GitHub `method`-discriminated pattern.
- The three-way outcome gains a fourth state in M1 (e.g. `delivered_then_reverted`), so
  `Outcome` stops matching ADR-0004.
- Strict-mode `required`-on-every-field proves to break real provider calls for the
  `confirm`/`null` fields — then split `confirm` into its own tool rather than loosen the schema.

## 7. Cost spent

- Tool calls: 34 (24 spec/doc fetches, 8 repo reads, 1 failed `web_search` — HTTP 402, no
  credits; one alternate strategy used instead of re-running it).
- Primary sources fetched: MCP spec (tools 2025-06-18 and 2026-07-28, progress, tasks 2025-11-25,
  elicitation 2025-11-25, schema 2025-06-18 and 2026-07-28, changelog 2026-07-28), Anthropic
  define-tools + handle-tool-calls + writing-tools-for-agents, OpenAI function calling + Agents
  SDK tools, `server-filesystem` README, `github-mcp-server` README + error-handling +
  typed-tool-schemas, Temporal activity-definition + activities, Stripe idempotent requests.
- Token estimate: not reported (no harness counter exposed).
- Unverified: `myco.compare`'s exact check vocabulary — depends on an M1 sign-off not yet given.
````

[You have received this identical output 3 times. Re-reading 'agent://M2MCPSurface/report' will not change it — use a narrower selector (path:A-B), or proceed with the edit.]
