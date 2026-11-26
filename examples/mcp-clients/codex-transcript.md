# Codex CLI → `myco-gate`: transcript (run 2026-11-26)

Status: **run**. A non-Claude MCP client (OpenAI Codex CLI, `codex-cli 0.168.0`, model
calls on its existing ChatGPT login on the operator's Mac) launched `myco-gate mcp` as a
stdio MCP server, called `myco_gate_check`, and got the gate's verdict back end to end.

Scope (ruling, 2026-11-26): Codex is approved only as the second, non-Claude MCP client
for this compatibility check. No Anthropic API, no key handled: Codex used its existing
login as-is, and the gate server takes no key, token or environment variable.

| # | Server bound to (`--task`/`--run`) | Codex's `myco_gate_check` arguments | verdict | accepted | reasonCodes |
|---|---|---|---|---|---|
| 1 | `df-s01` / `demo-df-s01` (clean save) | `df-s01`, `demo-df-s01` | `verified` | `true` | `ORACLE_PASS`, `CLAIM_RECORDED` |
| 2 | `df-s02` / `demo-df-s02` (app silently drops BUG items) | `df-s02`, `demo-df-s02` | `refuted` | `false` | `ORACLE_FAIL`, `CLAIM_RECORDED` |
| 3 | `df-s02` / `demo-df-s02` (same server as 2) | `df-s01`, `demo-df-s01` (another trial) | `uncertain` | `false` | `ASSIGNMENT_MISMATCH`, `CLAIM_RECORDED` |

Every verdict Codex reported matches the gate's own decision log (`--audit`) line for line.

## Codex invocations

Three `codex exec` invocations in total, which is the cap:

1. **Did not reach the model.** Launched without stdin redirected, `codex exec` printed
   `Reading additional input from stdin...` and waited. It was stopped after about 5
   minutes. It made no model call and no tool call, and wrote no events. Fix: `< /dev/null`.
2. Honest run, server bound to df-s01: one tool call (row 1).
3. Server bound to df-s02: two tool calls in one session (rows 2 and 3).

## Setup

Demo evidence comes from the mock end-to-end demo: no VM, no model, no network. It writes
`demo-df-s01/.myco-todo.json` (all 4 items) and `demo-df-s02/.myco-todo.json` (BUG items
dropped) under an evidence root the agent cannot write:

```sh
pnpm myco-gate demo --transport mock --out /path/to/demo   # DEMO: PASS; evidence in /path/to/demo/evidence
```

Codex flags used (from `codex exec --help`, codex-cli 0.168.0):

- `--ignore-user-config`: the user's `~/.codex/config.toml` is not loaded, and so it is
  not modified. Codex's existing login was used unchanged and was not read by us.
- `-c mcp_servers.myco-gate.command=…` / `-c mcp_servers.myco-gate.args=[…]`: the whole
  MCP server config is passed as command-line overrides. The launch line is the same one
  in [docs/gate/clients.md](../../docs/gate/clients.md). The server config has no
  environment-variable block.
- `-s read-only`, `approval_policy="never"`: no shell writes, and no interactive prompts in
  `exec` mode. The tool is annotated `readOnlyHint: true`, and Codex called it without asking.
- `--ephemeral`: no Codex session files persisted. `--json`: the event stream below.

Paths are written as `/path/to/…` placeholders. Nothing else is edited. Every line under
"Codex events" and "Gate decision log" is verbatim output. No line contains a host path,
key or token; the check is at the end.

## Invocation 2: honest run (df-s01)

```sh
codex exec --ignore-user-config --ephemeral --skip-git-repo-check --json -s read-only \
  -C /path/to/empty-workdir \
  -c approval_policy='"never"' \
  -c 'mcp_servers.myco-gate.command="/path/to/Myco/node_modules/.bin/tsx"' \
  -c 'mcp_servers.myco-gate.args=["/path/to/Myco/scripts/myco-gate.ts","mcp","--evidence-root","/path/to/demo/evidence","--task","df-s01","--run","demo-df-s01","--audit","/path/to/honest.audit.jsonl"]' \
  'Use the myco-gate MCP server. Call its myco_gate_check tool exactly once with taskId "df-s01", runId "demo-df-s01" and claim "All 4 items saved." Do not run shell commands. Then report the verdict, accepted and reasonCodes exactly as returned.' < /dev/null > honest.jsonl
```

Codex events (`--json`, verbatim):

```jsonl
{"type":"thread.started","thread_id":"01a21772-12f3-7ec3-a056-6e103ed07be7"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll call the Myco gate once and report the three fields it returns."}}
{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"result":{"content":[{"type":"text","text":"{\"apiVersion\":\"myco.gate/v1\",\"verdict\":\"verified\",\"accepted\":true,\"reasonCodes\":[\"ORACLE_PASS\",\"CLAIM_RECORDED\"],\"reasons\":[\"all 4 items persisted\"],\"evidenceRefs\":[{\"kind\":\"persisted-state\",\"runId\":\"demo-df-s01\",\"path\":\".myco-todo.json\",\"sha256\":\"6fec977be572d5ac5d23cfa072b8b655541b2b0d50b308d2db00ba67c99d57aa\",\"bytes\":168}],\"request\":{\"taskId\":\"df-s01\",\"runId\":\"demo-df-s01\",\"claim\":\"All 4 items saved.\"},\"oracle\":{\"family\":\"todo-items\",\"version\":\"1\",\"specSha256\":\"256857431c44c6da4659f978ab38fff93b2267cf7cfc48b9546810b07bbb2680\"},\"checkedAt\":\"2026-11-26T10:41:29.646Z\"}"}],"structured_content":{"apiVersion":"myco.gate/v1","verdict":"verified","accepted":true,"reasonCodes":["ORACLE_PASS","CLAIM_RECORDED"],"reasons":["all 4 items persisted"],"evidenceRefs":[{"kind":"persisted-state","runId":"demo-df-s01","path":".myco-todo.json","sha256":"6fec977be572d5ac5d23cfa072b8b655541b2b0d50b308d2db00ba67c99d57aa","bytes":168}],"request":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"oracle":{"family":"todo-items","version":"1","specSha256":"256857431c44c6da4659f978ab38fff93b2267cf7cfc48b9546810b07bbb2680"},"checkedAt":"2026-11-26T10:41:29.646Z"}},"error":null,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"```json\n{\n  \"verdict\": \"verified\",\n  \"accepted\": true,\n  \"reasonCodes\": [\"ORACLE_PASS\", \"CLAIM_RECORDED\"]\n}\n```"}}
{"type":"turn.completed","usage":{"input_tokens":81359,"cached_input_tokens":67200,"cache_write_input_tokens":0,"output_tokens":140,"reasoning_output_tokens":0}}
```

Gate decision log (`--audit`, verbatim):

```jsonl
{"apiVersion":"myco.gate/v1","verdict":"verified","accepted":true,"reasonCodes":["ORACLE_PASS","CLAIM_RECORDED"],"reasons":["all 4 items persisted"],"evidenceRefs":[{"kind":"persisted-state","runId":"demo-df-s01","path":".myco-todo.json","sha256":"6fec977be572d5ac5d23cfa072b8b655541b2b0d50b308d2db00ba67c99d57aa","bytes":168}],"request":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"oracle":{"family":"todo-items","version":"1","specSha256":"256857431c44c6da4659f978ab38fff93b2267cf7cfc48b9546810b07bbb2680"},"checkedAt":"2026-11-26T10:41:29.646Z"}
```

## Invocation 3: refuted run and assignment mismatch (server bound to df-s02)

```sh
codex exec --ignore-user-config --ephemeral --skip-git-repo-check --json -s read-only \
  -C /path/to/empty-workdir \
  -c approval_policy='"never"' \
  -c 'mcp_servers.myco-gate.command="/path/to/Myco/node_modules/.bin/tsx"' \
  -c 'mcp_servers.myco-gate.args=["/path/to/Myco/scripts/myco-gate.ts","mcp","--evidence-root","/path/to/demo/evidence","--task","df-s02","--run","demo-df-s02","--audit","/path/to/refuted.audit.jsonl"]' \
  'Use the myco-gate MCP server. Make exactly two myco_gate_check calls, one after the other: (1) taskId "df-s02", runId "demo-df-s02", claim "All 4 items saved."; (2) taskId "df-s01", runId "demo-df-s01", claim "All 4 items saved.". Do not run shell commands and make no other calls. Then report, for each call, the verdict, accepted and reasonCodes exactly as returned.' < /dev/null > refuted.jsonl
```

Codex events (`--json`, verbatim):

```jsonl
{"type":"thread.started","thread_id":"01a21772-6e35-7350-bba6-c472a6c0ed26"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run the two gate checks in order and report the returned fields."}}
{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s02","runId":"demo-df-s02","claim":"All 4 items saved."},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s02","runId":"demo-df-s02","claim":"All 4 items saved."},"result":{"content":[{"type":"text","text":"{\"apiVersion\":\"myco.gate/v1\",\"verdict\":\"refuted\",\"accepted\":false,\"reasonCodes\":[\"ORACLE_FAIL\",\"CLAIM_RECORDED\"],\"reasons\":[\"not persisted: bug: login page crashes on save, BUG: token expires too early\"],\"evidenceRefs\":[{\"kind\":\"persisted-state\",\"runId\":\"demo-df-s02\",\"path\":\".myco-todo.json\",\"sha256\":\"23a77ba9323862ced7f29ddef795f2bf82b1dae8105ae3cb335f45d23d7138b2\",\"bytes\":85}],\"request\":{\"taskId\":\"df-s02\",\"runId\":\"demo-df-s02\",\"claim\":\"All 4 items saved.\"},\"oracle\":{\"family\":\"todo-items\",\"version\":\"1\",\"specSha256\":\"18558b475f4ca317d8a931efc75bd381b2787f1444fc4d4f828aa49ea21dd8a8\"},\"checkedAt\":\"2026-11-26T10:41:49.615Z\"}"}],"structured_content":{"apiVersion":"myco.gate/v1","verdict":"refuted","accepted":false,"reasonCodes":["ORACLE_FAIL","CLAIM_RECORDED"],"reasons":["not persisted: bug: login page crashes on save, BUG: token expires too early"],"evidenceRefs":[{"kind":"persisted-state","runId":"demo-df-s02","path":".myco-todo.json","sha256":"23a77ba9323862ced7f29ddef795f2bf82b1dae8105ae3cb335f45d23d7138b2","bytes":85}],"request":{"taskId":"df-s02","runId":"demo-df-s02","claim":"All 4 items saved."},"oracle":{"family":"todo-items","version":"1","specSha256":"18558b475f4ca317d8a931efc75bd381b2787f1444fc4d4f828aa49ea21dd8a8"},"checkedAt":"2026-11-26T10:41:49.615Z"}},"error":null,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"myco-gate","tool":"myco_gate_check","arguments":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"result":{"content":[{"type":"text","text":"{\"apiVersion\":\"myco.gate/v1\",\"verdict\":\"uncertain\",\"accepted\":false,\"reasonCodes\":[\"ASSIGNMENT_MISMATCH\",\"CLAIM_RECORDED\"],\"reasons\":[\"this gate serves task \\\"df-s02\\\", run \\\"demo-df-s02\\\"; the request named task \\\"df-s01\\\", run \\\"demo-df-s01\\\"\"],\"evidenceRefs\":[],\"request\":{\"taskId\":\"df-s01\",\"runId\":\"demo-df-s01\",\"claim\":\"All 4 items saved.\"},\"checkedAt\":\"2026-11-26T10:41:49.617Z\"}"}],"structured_content":{"apiVersion":"myco.gate/v1","verdict":"uncertain","accepted":false,"reasonCodes":["ASSIGNMENT_MISMATCH","CLAIM_RECORDED"],"reasons":["this gate serves task \"df-s02\", run \"demo-df-s02\"; the request named task \"df-s01\", run \"demo-df-s01\""],"evidenceRefs":[],"request":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"checkedAt":"2026-11-26T10:41:49.617Z"}},"error":null,"status":"failed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"| taskId | runId | verdict | accepted | reasonCodes |\n|---|---|---|---|---|\n| `df-s02` | `demo-df-s02` | `refuted` | `false` | `[\"ORACLE_FAIL\",\"CLAIM_RECORDED\"]` |\n| `df-s01` | `demo-df-s01` | `uncertain` | `false` | `[\"ASSIGNMENT_MISMATCH\",\"CLAIM_RECORDED\"]` |"}}
{"type":"turn.completed","usage":{"input_tokens":54346,"cached_input_tokens":40192,"cache_write_input_tokens":0,"output_tokens":218,"reasoning_output_tokens":0}}
```

Gate decision log (`--audit`, verbatim):

```jsonl
{"apiVersion":"myco.gate/v1","verdict":"refuted","accepted":false,"reasonCodes":["ORACLE_FAIL","CLAIM_RECORDED"],"reasons":["not persisted: bug: login page crashes on save, BUG: token expires too early"],"evidenceRefs":[{"kind":"persisted-state","runId":"demo-df-s02","path":".myco-todo.json","sha256":"23a77ba9323862ced7f29ddef795f2bf82b1dae8105ae3cb335f45d23d7138b2","bytes":85}],"request":{"taskId":"df-s02","runId":"demo-df-s02","claim":"All 4 items saved."},"oracle":{"family":"todo-items","version":"1","specSha256":"18558b475f4ca317d8a931efc75bd381b2787f1444fc4d4f828aa49ea21dd8a8"},"checkedAt":"2026-11-26T10:41:49.615Z"}
{"apiVersion":"myco.gate/v1","verdict":"uncertain","accepted":false,"reasonCodes":["ASSIGNMENT_MISMATCH","CLAIM_RECORDED"],"reasons":["this gate serves task \"df-s02\", run \"demo-df-s02\"; the request named task \"df-s01\", run \"demo-df-s01\""],"evidenceRefs":[],"request":{"taskId":"df-s01","runId":"demo-df-s01","claim":"All 4 items saved."},"checkedAt":"2026-11-26T10:41:49.617Z"}
```

## Observations

- Codex read the tool's schema from `tools/list` and sent only `taskId`, `runId` and
  `claim`. It got `structuredContent` as `structured_content` and passed the verdict
  through unchanged.
- **Codex surfaces MCP `isError` as the tool item's `status`.** The `result` of an
  `mcp_tool_call` item has only `content` and `structured_content`, with no field named
  `isError`. The server's `isError: true` shows up as the item's `"status":"failed"` in
  the `item.completed` event. `error` stays `null` and the gate's result is still in
  `result`. In this run, the `refuted` answer (server `isError: false`) is
  `"status":"completed"`, and the rejected `ASSIGNMENT_MISMATCH` request (server
  `isError: true`, see clients.md §3) is `"status":"failed"`. A harness should still
  decide "done" by `structured_content.accepted` and `reasonCodes`. Treat `status: "failed"`
  as "the request was rejected", not as "the work is wrong".
  (Corrected in round 2: an earlier version wrongly said Codex does not show `isError`.)
- The `ASSIGNMENT_MISMATCH` reason names the bound task and run (`df-s02`/`demo-df-s02`).
  These are IDs, not host paths, which matches the codes-only reason rule.

## Secret check

Before commit, gitleaks scanned the changed files and found no leaks. A names-only grep
for key-shaped words found matches only in prose, none in the verbatim event or log
lines. The file was also checked by eye for tokens, auth paths, account emails and host
usernames.
