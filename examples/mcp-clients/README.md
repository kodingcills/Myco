# `myco-gate` MCP client examples

Example configs that start the `myco-gate` stdio MCP server for one trial. The setup,
tool schema, verdict shape and security model are in
[docs/gate/clients.md](../../docs/gate/clients.md).

Every file uses the same placeholders. Replace them per trial (the harness writes this
config, not the agent):

| Placeholder | Meaning |
|---|---|
| `/path/to/Myco` | absolute path to this repo, after `pnpm install` |
| `/path/to/evidence` | the operator's evidence root (`<root>/<runId>/<stateFile>`) |
| `df-s01`, `run-42` | the trial this agent session is assigned (`--task`, `--run`) |
| `/path/to/gate-decisions.jsonl` | optional decision log (`--audit`) |

No file has an `env` value: the server needs no environment variable, key or token.

| File | Client | Where it goes | Status |
|---|---|---|---|
| [`claude-code.mcp.json`](claude-code.mcp.json) | Claude Code | the project's `.mcp.json` (or `claude mcp add`, see [api.md](../../docs/gate/api.md#wiring-it-into-claude-code)) | tested (mock demo, `test/gate/mcp-server.test.ts`) |
| [`oh-my-pi.mcp.json`](oh-my-pi.mcp.json) | Oh My Pi (`omp`) | the project's `.omp/mcp.json` (Oh My Pi also discovers `.mcp.json`) | **not run** (below) |
| [`gemini-cli.settings.json`](gemini-cli.settings.json) | Gemini CLI | merge `mcpServers` into `.gemini/settings.json` | **not run** (below) |
| [`generic.mcp.json`](generic.mcp.json) | any client using the common `mcpServers` shape (`command`, `args`, `env`) | the client's MCP config | the same launch line is tested with the official SDK client |
| [`stdio-requests.jsonl`](stdio-requests.jsonl) | no client: raw JSON-RPC lines | pipe to the server's stdin | tested (`test/gate/mcp-sdk-client.test.ts`) |
| [`agent-transcript.md`](agent-transcript.md) | a non-Claude agent on a local model | – | **not run** |

`test/gate/mcp-sdk-client.test.ts` also checks that every JSON config here launches the
server with `mcp`, an evidence root, a task and a run, and carries no environment values.

Notes per client:

- **Oh My Pi.** Its native format is `{ "mcpServers": { name: { type: "stdio", command,
  args, env, cwd } } }` (`MCPStdioServerConfig` in `@oh-my-pi/pi-coding-agent` 19.2.1).
  Oh My Pi may resolve `env` values as variable names or `!command` lines, which is one
  more reason to leave `env` empty for this server.
- **Gemini CLI.** `trust: false` keeps Gemini CLI's per-call confirmation;
  `includeTools` limits it to the one gate tool. Gemini CLI itself needs a Google login or
  API key, which this change does not use (no credentials, 2026-11-26 ruling).
- **Antigravity** and other MCP hosts that accept the `mcpServers` shape can use
  `generic.mcp.json`; none was run.

## Why no agent was run

The brief asked for a real non-Claude agent (Oh My Pi or another open MCP agent) driving a
local Ollama model, with no account or key. In the cloud session that built this, the
network proxy refused both `ollama.com` (the Ollama download) and `registry.ollama.ai`
(model pulls) with `403 Forbidden (agent proxy: no rule or network setting allows this
host)`. The builder's rules say to stop at a refusal and not work around it, so no other
download route for Ollama or a model was tried, and no agent was run. Gemini CLI was not
tried because it needs a login or key. The deterministic client test covers the protocol
side; an agent run needs an environment that allows those hosts.
