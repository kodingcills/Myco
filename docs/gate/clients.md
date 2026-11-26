# Using `myco-gate` from any MCP client

`myco-gate mcp` is a plain MCP server over **stdio**. Nothing in it is specific to Claude
Code: any MCP client that can launch a stdio server can call the gate. This page is the
client-agnostic setup; the API itself (request, result, reason codes) is
[api.md](api.md). Example configs per client are in
[`examples/mcp-clients/`](../../examples/mcp-clients/README.md).

| Client | Status in this repo |
|---|---|
| Claude Code | wired and tested (`test/gate/mcp-server.test.ts`, the mock demo) |
| Official MCP TypeScript client (`@modelcontextprotocol/sdk`, pinned) | tested in CI, no model (`test/gate/mcp-sdk-client.test.ts`) |
| Plain shell (JSON-RPC lines on stdin) | tested in CI (`examples/mcp-clients/stdio-requests.jsonl`, replayed by the same test) |
| OpenAI Codex CLI (`codex exec`) | **run** 2026-11-26, `codex-cli 0.168.0`: verified, refuted and ASSIGNMENT_MISMATCH returned end to end ([transcript](../../examples/mcp-clients/codex-transcript.md), [config](../../examples/mcp-clients/codex.config.md)) |
| Oh My Pi, Gemini CLI, other MCP agents | example config only; **not run** (see the examples README for why) |

## 1. Launching the server

Every MCP client needs the same three things: a command, its arguments, and (optionally)
an environment and working directory.

| Field | Value |
|---|---|
| transport | `stdio` (newline-delimited JSON-RPC 2.0; one message per line). There is no HTTP transport. |
| `command` | `/path/to/Myco/node_modules/.bin/tsx` (absolute: clients start servers from their own working directory) |
| `args` | `/path/to/Myco/scripts/myco-gate.ts`, `mcp`, `--evidence-root`, `<dir>`, `--task`, `<taskId>`, `--run`, `<runId>`, optionally `--audit <file>`, `--tasks <file>`, `--no-builtin` |
| `env` | none needed. The server reads no environment variable, takes no key or token, and needs no network. Do not put secrets here. |
| `cwd` | not needed when the paths are absolute |
| protocol versions | `2025-06-18`, `2025-03-26`, `2024-11-05`. A client that asks for a newer version (the SDK asks for `2025-11-25`) is answered with `2025-06-18`, which current clients accept. |

stdout is the JSON-RPC channel. stderr is the operator's: diagnostics (raw errors, with
host paths) go there and never to the agent. Without `--task` and `--run` the server
refuses to start (exit 3). It exits 0 when stdin closes.

**One trial, one server.** The `--task`/`--run` pair is the assignment. A harness writes
the client config per trial, starts one server for one agent session, and stops it with
the session. Do not share a server between trials or agents.

## 2. The tool

`tools/list` returns exactly one tool:

- name: **`myco_gate_check`**
- annotations: `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`
- input schema (`GATE_REQUEST_SCHEMA` in `src/gate/api.ts`):

```json
{
  "type": "object",
  "properties": {
    "apiVersion": { "type": "string", "const": "myco.gate/v1" },
    "taskId": { "type": "string", "pattern": "<safe id>" },
    "runId": { "type": "string", "pattern": "<safe id>" },
    "claim": { "type": "string", "maxLength": 4000 }
  },
  "required": ["taskId", "runId"],
  "additionalProperties": false
}
```

The `initialize` result carries `instructions` that tell the model to call the tool when it
believes it is done and that only `verified` counts. Clients that ignore server
instructions should put the same sentence and the trial's `taskId`/`runId` in the task
prompt.

## 3. What a verdict looks like

The result is the `GateResult` from [api.md](api.md#result), returned twice: as
`structuredContent` and as JSON text in `content[0].text` (for clients that ignore
`structuredContent`). A real reply (`tools/call` for an honest df-s01 run):

```json
{"jsonrpc":"2.0","id":3,"result":{
  "content":[{"type":"text","text":"{…the same object as structuredContent…}"}],
  "structuredContent":{
    "apiVersion":"myco.gate/v1","verdict":"verified","accepted":true,
    "reasonCodes":["ORACLE_PASS","CLAIM_RECORDED"],
    "reasons":["all 4 items persisted"],
    "evidenceRefs":[{"kind":"persisted-state","runId":"run-42","path":".myco-todo.json",
                     "sha256":"f2e12984…","bytes":300}],
    "request":{"taskId":"df-s01","runId":"run-42","claim":"All 4 items saved."},
    "oracle":{"family":"todo-items","version":"1","specSha256":"25685743…"},
    "checkedAt":"2026-11-26T10:27:41.784Z"},
  "isError":false}}
```

- `accepted: true` exactly when `verdict` is `verified`. That is the only "done".
- `refuted` is a normal answer (`isError: false`): the persisted state contradicts the task.
- `isError: true` only when the request was rejected (`INVALID_REQUEST`, `UNKNOWN_FIELD`,
  `ORACLE_INPUT_REJECTED`, `UNSUPPORTED_API_VERSION`, `ASSIGNMENT_MISMATCH`). The verdict
  is then `uncertain`. Naming another task:
  `{"verdict":"uncertain","accepted":false,"reasonCodes":["ASSIGNMENT_MISMATCH"],"evidenceRefs":[],…}`.

Gate on `reasonCodes`, not `reasons`: codes are stable; reasons are for people. Do not
gate on the client's error flag either: Codex CLI's `--json` events do not show
`isError` at all (2026-11-26 run), so `accepted` and `reasonCodes` are what reach every client.

## 4. Plain JSON-RPC (no MCP client)

There is no HTTP transport, so there is no `curl` example. The equivalent of one HTTP
call is one line on the server's stdin.
[`examples/mcp-clients/stdio-requests.jsonl`](../../examples/mcp-clients/stdio-requests.jsonl)
is a whole session (initialize, initialized, tools/list, tools/call):

```sh
/path/to/Myco/node_modules/.bin/tsx /path/to/Myco/scripts/myco-gate.ts mcp \
  --evidence-root /path/to/evidence --task df-s01 --run run-42 \
  < examples/mcp-clients/stdio-requests.jsonl
```

It prints three reply lines (ids 1, 2, 3; the notification gets none), the last being the
reply above. `test/gate/mcp-sdk-client.test.ts` pipes this exact file to the server and
checks the replies, so the example cannot drift.

An HTTP transport would add a network listener (a Tier 2 change) for no gain over stdio
for local agents; it is not part of this change.

## 5. Security model

These hold for every client, because they are properties of the server, not of the client:

- **The agent supplies only `taskId`, `runId` and `claim`.** The schema has
  `additionalProperties: false`, and the gate's own parser rejects anything else whatever
  the client sends: an oracle input (`items`, `expected`, `path`, `verdict`, …) is
  `ORACLE_INPUT_REJECTED`, anything else unknown is `UNKNOWN_FIELD`. `claim` is recorded
  and never read by the oracle.
- **The gate is bound to one trial.** The operator fixes `--task`/`--run` on the command
  line. Naming any other task or run is `ASSIGNMENT_MISMATCH` and nothing is read.
- **Everything else is operator-side**: the task registry, the evidence location and the
  decision log come from flags in the client config, which the harness writes. A client
  config the agent can edit is outside this model: the harness must own it.
- **Grader independence.** The gate reuses nothing from the independent grader
  (`src/benchmark/grade/`); see [api.md](api.md#task-families).
- **Codes-only reasons to the agent.** No agent-facing reason carries a host path or a
  raw error message ([api.md](api.md#agent-facing-reasons-never-carry-host-paths-or-raw-error-messages)).
- **Read-only, one tool.** The server has no tool that acts, reads a file or takes a path.
  It is a separate process from the actuator (`myco-rt-mcp`).
- **Clients with auto-approve.** The tool is read-only, so auto-approving it is safe for
  the gate; a client's "trust" setting does not widen what the gate reads.

What this does not cover is the same as for Claude Code: the evidence root must be a
host-side capture the agent cannot write ([api.md](api.md#requirement-the-gate-judges-a-host-side-capture-taken-after-the-agent-stops)),
and the harness, not the client, enforces "done" by reading `accepted`.
