# `myco-state` security model

Capability track I. This page covers what the structured-state tools can reach and what
they cannot. It also covers why they cannot weaken the gate. The tool reference is in
[tools.md](tools.md).

## What the agent gets

Four read-only tools that read one thing: the live app and document of the agent's own
trial. The agent's inputs are a sheet (index or name), an A1 range, and two tree limits.
There is no field for a path, file, URL, run, task or trial, and a call with any other
field gets `UNKNOWN_FIELD`.

## Bound to one trial

- The harness starts one `myco-state` server per trial. It sets the binding in the
  server's environment: `MYCO_STATE_RUN_ID` (the trial's run id) and `MYCO_STATE_UNO_PIPE`
  (the trial's live soffice pipe). The pipe name comes from the run id plus random bytes,
  and it matches `^myco-state-[a-z0-9-]{8,64}$`. It is never a path.
- The server refuses to start without both, and with any argument except `mcp`.
- The reader finds the one spreadsheet loaded in that soffice. With none or more than one,
  it returns `DOCUMENT_UNAVAILABLE`; it never guesses.
- The launch audit (`src/integrity/launch.ts`) checks a `myco-state` server's environment:
  the run id must equal the trial's, the pipe must have the issued shape, there must be no
  other keys than the four binding keys, and the args must end in `mcp` with no flags.

The binding works like the gate's: one server, one trial, and nothing in a request can
point it elsewhere.

## What it can never reach

The server never opens a file. `src/state/{api,backend,server,cli}.ts` and
`linux/uno.ts` import no file-system API (`test/state/state-scope.test.ts`). The only
state module that touches the file system is the harness's own live-session launcher. It
makes a throwaway profile and clears a lock file. The reader script takes only `--pipe`,
never calls `getURL` or `getLocation`, and never prints exception text.

So these are out of reach by construction: the pristine fixture, the sealed vault and its
receipts, the oracle config and expected values, other trials, host paths and secrets.
Defense in depth on top of that:

- **Withheld strings.** The harness passes the trial dir, vault root, fixture dir, oracle
  config and other trials' dirs in `MYCO_STATE_WITHHELD`. A reply that contains any of
  them, raw or JSON-escaped, is replaced by `OUTPUT_WITHHELD`.
- **Path scrubbing.** UI-tree names have path-like text replaced with `[path]`.
- **Codes only.** Every refusal is a code. A backend exception, timeout or malformed reply
  becomes `BACKEND_ERROR`, and its text goes to the operator's stderr only. An unknown tool
  or method is not echoed.

The tests plant `PLANTED_FAKE_MARKER` in the pristine fixture, the vault, the oracle config
and another trial's dir. Then they check that no tool output contains the marker or any of
those paths:

- `test/state/state-scope.test.ts` (hermetic) runs a battery of valid and hostile calls,
  including path-like sheets and ranges and smuggled `path`, `runId`, `taskId`, `file` and
  `trial` fields;
- `test/linux/state-e2e.test.ts` runs against a real live Calc and checks every byte the
  server wrote.

## Read-only

- The server has no write path. The backend interface has four read methods only.
- The reader script has no setter, dispatch, store, close, load, select or terminate call.
  A static test enforces this.
- The acting channel for the Linux test harness (`scripts/linux/calc_live_act.py`) is a
  separate script. It is never reachable through the MCP server.

## Bounded output

| Bound | Value | Over the bound |
|---|---|---|
| Cells per `state_read_range` | 400 | `RANGE_TOO_LARGE` |
| Rows or columns per range | 200 | `RANGE_TOO_LARGE` |
| Characters per cell text or formula | 512 | cut, `truncated: true` |
| Characters per sheet or node name | 128 | cut |
| Sheets listed | 64 | `truncated: true` |
| UI tree depth | 8 (default 4) | `LIMIT_OUT_OF_RANGE` on request |
| UI tree nodes | 200 (default 60) | `LIMIT_OUT_OF_RANGE` on request |
| Children per UI node | 25 | `childrenOmitted: "width"` |
| Reply bytes | 64 KiB | `OUTPUT_TOO_LARGE` |

The backend applies the caps, and the server checks them again. A reply over any cap, or
with the wrong shape, is refused with `BACKEND_ERROR`. It is never passed through.

## Gate and grader independence

- `myco-state` is a separate server. Nothing is added to `myco-gate`'s `myco.gate/v1`
  surface: the agent still supplies only `taskId`, `runId` and `claim`.
- The gate never calls these tools. No module under `src/gate/` reaches `src/state/`, and
  none names the server (`test/state/state-independence.test.ts`). The gate keeps reading
  only the persisted bytes the harness captures after the agent stops.
- The grader (`src/benchmark/grade/`) shares no code with `src/state/`, in either direction.
  `test/benchmark/independence.test.ts` now also forbids any `state/` or `myco-state`
  reference in grader code.
- `myco-state` is not a default MCP server in the surface audit. The R1 gated harness
  (`runGatedTrial`) audits with the gate's class only, so it refuses a plan that starts
  `myco-state`. Structured-state trials can therefore never produce R1 rows through it.
- Live state is not proof. The second end-to-end case shows it: the client sees its edit in
  live state, never saves, and the gate refutes from the saved file.

## The new reach class

`src/integrity/surface.ts` has a new reach, `app-state`. It reads the agent's own live app
or document for its own trial, read-only, through a server bound to that trial. Only
`STATE_SERVER_CLASS`, which only the capability-arm audit passes, has tools of this reach.
