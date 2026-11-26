# Human handoff protocol (`myco.handoff/v1`)

Capability track N. The agent pauses when it is uncertain, needs approval, or is blocked (or
when a host policy says so). The human is notified, fixes or approves on the live desktop, and
the agent resumes. Every handoff is written to the run record. A handoff never changes a
verdict: the gate and the independent grader still decide from the persisted bytes.

Source: `src/handoff/`. Operator CLI: `pnpm myco-handoff`. Security model:
[security.md](security.md). Proposed measurement bar: [measurement.md](measurement.md).

## Parts

| Part | Who holds it | Module |
|---|---|---|
| Broker: one per trial, bound to `{runId, taskId}`; holds the state, the deadline and the log | the harness (host) | `broker.ts` |
| Agent channel: request a handoff, wait on it. **No resolve verb** | the agent's `myco-handoff` MCP server | `agent-server.ts` |
| Policy trigger and pause gate: force a pause; block actuator calls while paused | the host actuator path (track O) | `broker.ts`, `policy.ts` |
| Operator channel: list pending handoffs, resolve them. Issued **once** | the loopback operator endpoint | `operator-server.ts` |
| Operator CLI | the human, on the host | `cli.ts`, `scripts/myco-handoff.ts` |
| Notifier: terminal bell and line, desktop notification where available | the host | `notifier.ts` |
| Event sink: `requested` / `resolved` / `attempt-ended` lines | the run directory (later #518's attempt ledger) | `events.ts` |
| Evidence guard: assisted and human-gated trials never count as unassisted R1 | the benchmark check | `evidence.ts` |

`myco.gate/v1` is unchanged: its one tool still takes only `taskId`, `runId` and `claim`. The
handoff is a separate MCP server with its own tools, classified for the launch audit
(`HANDOFF_SERVER_CLASS`, reach `agent-local`). `runGatedTrial` refuses a launch plan that starts
it unless the operator passes `allowHandoffServer: true`.

## Agent side: the `myco-handoff` MCP server

Two tools. Inputs are closed (`additionalProperties: false`; an unknown field is refused with
`UNKNOWN_FIELD` and opens nothing).

| Tool | Input | What it does |
|---|---|---|
| `myco_handoff_request` | `reason`: `uncertain` \| `needs-approval` \| `blocked`; `note`: one line, ≤ 280 characters | Opens a handoff and waits (long-poll, default 20 s) |
| `myco_handoff_await` | `handoffId` (`ho-<n>`) | Keeps waiting on an open handoff |

Each call returns one result (`apiVersion: "myco.handoff/v1"`):

| `status` | Meaning | What the agent does |
|---|---|---|
| `paused` | Still open; carries `handoffId` | Call `myco_handoff_await` again |
| `resumed` | `outcome` is `approve` or `fixed-it`, with the human's `humanNote` or null | Carry on; after `fixed-it` the human changed the desktop, so look again |
| `rejected` | The human said no; `humanNote` or null | Do not do what it asked about |
| `ended` | `code` is `HANDOFF_TIMEOUT` or `HANDOFF_CANCELLED` | Stop: the attempt is over |
| `refused` | `code`: `INVALID_REASON`, `NOTE_*`, `HANDOFF_PENDING`, `UNKNOWN_HANDOFF`, `UNKNOWN_FIELD`, `INVALID_REQUEST` | Fix the call |

At most one handoff is open at a time. Note rules (`noteRejection`): a string, within the
bound, no control characters (newlines and escape sequences included), no bidi overrides, no
host path shapes, nothing key-shaped. A rejected note is answered with a code, never echoed.

## Host side: policy trigger (track O interface)

Track O is not merged; this PR defines only the seam (`src/handoff/policy.ts`):

```ts
interface HandoffPolicy {
  readonly id: string;
  evaluate(action: ProposedAction): PolicyPauseRequest | null | Promise<PolicyPauseRequest | null>;
}
// In the actuator path, before forwarding each agent action:
const decision = await guardAction(policy, broker.policyTrigger(), action);
```

`guardAction` first waits on the pause gate, so no action is forwarded while any handoff is
open, whoever opened it. Then it asks the policy. A forced pause resolves to `proceed`
(approve), `skip` (fixed-it: the human did it), `deny` (reject), or `ended` (timeout or the
trial closed). A policy that throws denies the action. A policy pause while a handoff is
already open joins that handoff. The record names the policy (`source: "policy"`, `policyId`).

## Human side: operator endpoint and CLI

The harness starts the endpoint on `127.0.0.1` with a fresh operator token
(`startOperatorServer`, `newOperatorToken`), and writes a 0600 connection file in a directory
the operator chooses outside the repository (`writeConnectionFile`, for example
`~/.myco/handoff/<runId>.json`). The token is never printed, logged, or put in argv or the
environment.

```sh
pnpm myco-handoff list    --connection ~/.myco/handoff/run-1.json
pnpm myco-handoff resolve ho-1 fixed-it --note "closed the dialog" --connection ~/.myco/handoff/run-1.json
```

| Endpoint | Body | Result |
|---|---|---|
| `GET /handoff/v1/pending` | none | `{pending: [{handoffId, runId, taskId, source, policyId, reason, note, requestedAt, deadlineAt}]}` |
| `POST /handoff/v1/resolve` | `{handoffId, outcome: approve\|reject\|fixed-it, note?, via?: cli\|watch-view\|api, operatorLabel?}` | `{resolved: <entry>}`, or `{code}` with 400 / 409 |

`operatorLabel` (`^[a-z0-9][a-z0-9._-]{0,31}$`, default `operator`) is what the record keeps as
"who resolved". It is a label the operator picks, not an OS user name, so no personal data goes
into a run record that may be published. Human notes follow the agent-note rules with a
500-character bound, so a human note that would leak a path or a key is refused before it
reaches the agent or the record.

**Live watch view (lands with #513).** `createOperatorHandler` is a plain Node request handler.
The watch view's loopback server mounts it at `/handoff/v1`, passes its own origin in
`allowedOrigins`, and shows `pending` beside the live desktop with three buttons that POST
`resolve` with `via: "watch-view"`. Nothing in this PR depends on #513's code.

## Timeouts (fail closed)

Every handoff has a deadline: `timeoutMs`, 15 minutes by default, configurable from 1 s to
24 h. When it passes:

1. The broker ends the attempt (`attemptEnd: "handoff-timeout"`) before anything else runs.
2. The handoff is recorded `resolution: "timeout"`, `resolvedBy: "host:timeout"`.
3. The agent's waiting call returns `ended` / `HANDOFF_TIMEOUT`. Every later request, await,
   policy pause, and pause-gate check returns `ended`. A late human resolve gets
   `ALREADY_RESOLVED`.
4. `onAttemptEnd("handoff-timeout")` tells the harness to stop the agent.

A timeout never approves. When the trial ends with a handoff still open (the agent stopped),
`broker.close()` records it `cancelled` by `host:harness`.

## What is recorded

The run record (`result.json`) has an optional `handoffs` field, `myco.handoff.log/1`
(`schemas/handoff.ts`):

```json
{
  "schema": "myco.handoff.log/1",
  "assistance": "assisted",
  "attemptEnd": null,
  "timeoutMs": 900000,
  "entries": [{
    "handoffId": "ho-1", "runId": "run-h1", "taskId": "df-s01",
    "source": "agent", "policyId": null,
    "reason": "needs-approval", "note": "About to save the list. OK to save?",
    "requestedAt": "2026-11-26T15:00:00.000Z", "resolvedAt": "2026-11-26T15:00:41.000Z",
    "durationMs": 41000,
    "resolution": "fixed-it", "resolvedBy": "operator:cli", "operatorLabel": "operator",
    "humanNote": "I saved it for you"
  }]
}
```

Trial events go to `handoffs.jsonl` in the run directory as they happen (append-only, one line
per `requested`, `resolved` and `attempt-ended`), so a crash mid-handoff still leaves the
request on disk. Once #518 merges, the same events go through its attempt ledger
(`attemptLedgerSink`, see TO FILE). For a benchmark ledger, one `myco.handoff.trial/1` row per
trial (`{trialKey, log}`) sits in a `handoffs.jsonl` beside `arm.jsonl`.

## Assistance labels

| Label | When | R1 evidence |
|---|---|---|
| `unassisted` | no handoff | counts |
| `human-gated` | handoffs, none `fixed-it` (approve, reject, timeout, cancelled) | refused: the human had the live desktop while the agent was paused |
| `assisted` | any `fixed-it` | refused: human intervention |

Checks recompute the label from the entries (`assistanceOf`). A row that declares a weaker
label than its entries imply is an error, and the stricter label is used.
`checkBenchmarkWithHandoffs` fails R1 when any arm row is assisted or human-gated, whether or
not `evidence` is set, because R1 is unassisted by definition. Under `evidence: true` it is
also a ledger error, like a corrections-on row.

## TO FILE (Linear limit)

- Wire `handoffEvidenceError` into `checkPack` / `readPack` (`src/m2/evidence.ts`) once #518
  merges; it owns that file.
- Implement `AttemptLedgerEventWriter` over `src/m2/attempt-ledger.ts` once #518 merges, and
  switch the harness to `attemptLedgerSink`.
- Add `--handoffs <file>` to `scripts/benchmark-check.ts` (calls `checkBenchmarkWithHandoffs`).
- Watch-view panel and mount (lands with #513).
- A live bridge: a stdio `myco-handoff-mcp` process in the agent's launch plan that reaches the
  host broker's agent channel over its own agent-only socket (no operator verbs). This PR
  serves the agent channel in-process (mock path).
- Track O's policies implement `HandoffPolicy`.
