# Human handoff: security model

Capability track N ([protocol.md](protocol.md)). The handoff adds a human to the loop without
giving the agent a way to approve itself, without leaking host data to the agent, and without
touching the verdict.

## 1. Threats

| # | Threat | Defence |
|---|---|---|
| T1 | The agent resolves its own handoff ("approve") | §2: separate channel, capability split, loopback plus operator token, OS/VM boundary |
| T2 | The agent learns host data (paths, the token) from handoff output | §3: code-only results; notes validated both ways |
| T3 | A handoff changes a verdict, or a helped trial counts as unassisted evidence | §4 |
| T4 | Nobody answers and the trial is approved by default | §5: fail closed |
| T5 | Agent text attacks the operator (terminal escapes, AppleScript injection) | §6 |
| T6 | A web page in the operator's browser resolves a handoff (CSRF, DNS rebinding) | §2 |

## 2. The agent cannot resolve (T1, T6)

- **Capability split in the broker.** `agentChannel()` returns an object with `request` and
  `await` only. `operatorChannel()` returns the only `resolve`, and the broker issues it
  **once**: the operator endpoint takes it at start, and any later call throws. The agent's MCP
  server is built on the agent channel and has no other reference.
- **No outcome in the agent's input.** The two agent tools take `reason` + `note` and
  `handoffId`. Their schemas are closed; an `outcome` field is `UNKNOWN_FIELD`. Resolve-like
  tool names are `unknown tool`, resolve-like methods are `-32601`
  (`test/handoff/boundary.test.ts`).
- **Separate listener, loopback only.** The operator endpoint binds `127.0.0.1` on the host
  and has no option to bind anything else. In a live run the agent acts inside the guest VM,
  which has no route to host loopback. On the host side, the launch audit grants the agent no
  host shell, host filesystem or network tool (`src/integrity/surface.ts`), so it cannot open a
  host socket either.
- **Operator token.** Every request needs `Authorization: Bearer <token>`. The token is 32
  bytes from `crypto.randomBytes`, held in the harness's memory and in one 0600 connection file
  that the operator places outside the repository. It is compared in constant time (SHA-256 of
  both sides, then `timingSafeEqual`). It is never printed, logged, put in argv or environment,
  or sent to the agent. `connectionReachesAgent(plan, path, token)` lets the harness refuse a
  launch plan that names the connection file or carries the token. The CLI refuses a connection
  file whose mode is wider than 0600, or whose URL is not `http://127.0.0.1:<port>/`, so a
  tampered file cannot send the token elsewhere.
- **Browser-safe.** The Host header must be loopback with the right port (DNS rebinding). A
  present `Origin` must be allow-listed (none by default; the watch view's own origin once #513
  lands). `POST` needs `Content-Type: application/json`, which a cross-site form cannot send
  without a preflight. Bodies are capped at 4 KiB, and unknown body fields are refused.
- **OS-user boundary (optional hardening).** Where the agent runs on the same machine as the
  operator (a local, non-VM setup), run the agent as a separate OS user. The 0600 connection
  file then cannot be read by it. This is documented, not enforced, here.

No secret is stored in the repository. The connection file lives where the operator puts it,
for example `~/.myco/handoff/`, never in the run directory or an evidence pack.

## 3. Nothing host-side reaches the agent (T2)

Agent-facing results carry `status`, `handoffId`, `outcome`, a code, and the human's note. They
carry no deadline clock, no host path, no operator label and no token. Both notes are validated
(`noteRejection`): a bounded single line with no control characters, no host path shapes, and
nothing key-shaped. A human note that fails is refused at the operator endpoint, so it never
reaches the agent or the record. A refused agent note is answered with a code, never echoed.
The leakage test drives every result kind and checks every string against the host-path
pattern, the temp directory, the working directory, the token, and the key shapes.

## 4. A handoff never changes a verdict (T3)

- The broker has no reference to the gate, the vault or the grader. Nothing it records is an
  input to any of them. The gate still takes only `taskId`/`runId`/`claim` and reads the sealed
  capture after the agent stopped; the grader (`src/benchmark/grade`) still shares no code with
  the gate.
- The end-to-end test shows the same desktop end state with and without a handoff gives the same
  verdict. It also shows a human `fixed-it` on df-s02 (where the app silently drops items)
  stays `refuted`: the bytes decide.
- A human `fixed-it` is recorded as intervention, and the trial is labelled `assisted`. Any
  other handoff is `human-gated`. Neither is ever counted as unassisted R1 evidence
  (`checkBenchmarkWithHandoffs`; the label is recomputed, not trusted). R1 evidence rules in
  `src/benchmark/taskset-binding.ts` are unchanged. R7 is unchanged: handoffs add no cost
  field, and an assisted trial's cost still counts in R7's numerator wherever its arm row counts.

## 5. Fail closed on silence (T4)

See [protocol.md § Timeouts](protocol.md#timeouts-fail-closed). The deadline is set when the
handoff opens. On expiry the broker marks the attempt ended **before** it wakes any waiter, so
nothing that races the timeout sees an open broker. Approval exists only as an explicit human
`resolve`.

## 6. Agent text meets the operator (T5)

The terminal notifier passes agent-written fields through `terminalSafe`: every control
character, including ESC and BEL, and every bidi override becomes `?`, and the text is cut to a
fixed length. The bell is the notifier's own. The desktop notification carries no agent text.
On macOS the message is an `osascript` argv item read by `on run argv`, never spliced into
AppleScript source. Everything runs through `execFile` with an argv array, never a shell. No
network notifier ships in this PR: one would send run data off the host and needs its own
review.
