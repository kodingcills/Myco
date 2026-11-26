# Non-Claude agent transcript: NOT RUN

Status: **not run**. No transcript was recorded.

Intended run: an open MCP-capable agent CLI (Oh My Pi, `oh-my-pi.mcp.json`) on a local
Ollama model (a small tool-calling model such as `qwen2.5` or `llama3.2`), no account and
no key, asked to check the demo task `df-s01` / run `run-42` with `myco_gate_check`.

Why not: the cloud session's network proxy refused `ollama.com` and `registry.ollama.ai`
(`403 Forbidden (agent proxy: no rule or network setting allows this host)`), so neither
Ollama nor a model could be installed. Per the builder rules, no other route was tried.

What would be recorded here when it runs: the agent's prompt, its `tools/call` to
`myco_gate_check` with `{ "taskId": "df-s01", "runId": "run-42" }`, and the verdict
returned (`verified`, `accepted: true`, `ORACLE_PASS` for the honest store). There are no
secrets in this flow: the server takes no key and the model is local.

What runs instead, in CI and without a model: `test/gate/mcp-sdk-client.test.ts` drives
the real server with the official MCP TypeScript client (verified, refuted,
ASSIGNMENT_MISMATCH) and replays `stdio-requests.jsonl`.
