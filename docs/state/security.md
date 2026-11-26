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
- It also sets `MYCO_STATE_WITHHELD`: the trial's host paths (trial dir, vault root,
  fixture dir, oracle config, other trials' dirs) as a JSON array of 1 to 64 absolute
  paths. The list is mandatory; see [Host paths](#host-paths).
- The server refuses to start without all three, and with any argument except `mcp`.
- The reader finds the one spreadsheet loaded in that soffice. With none or more than one,
  it returns `DOCUMENT_UNAVAILABLE`; it never guesses.
- The launch audit (`src/integrity/launch.ts`) checks a `myco-state` server's environment:
  the run id must equal the trial's, the pipe must have the issued shape, the withheld list
  must be present and valid, there must be no other keys than the four binding keys, and
  the args must end in `mcp` with no flag anywhere (`["--inspect", "mcp"]` is refused).
  `capabilityArmPlan` refuses to build a structured-state plan without withheld paths.

The binding works like the gate's: one server, one trial, and nothing in a request can
point it elsewhere.

## What it can never reach

The server never opens a file. `src/state/{api,backend,server,cli}.ts` and
`linux/uno.ts` import no file-system API (`test/state/state-scope.test.ts`). The only
state module that touches the file system is the harness's own live-session launcher. It
makes a throwaway profile and clears a lock file. The reader script takes only `--pipe`,
never calls `getURL` or `getLocation`, and never prints exception text.

So the contents of these are out of reach by construction: the pristine fixture, the
sealed vault and its receipts, the oracle config and expected values, other trials, and
secrets. The server can only return what the agent's own open document holds.

### Host paths

Host paths are NOT out of reach by construction. The document itself can produce one: a
formula such as `=CELL("filename")` evaluates to the document's own URL
(`'file:///<trial dir>/agent/saved.xlsx'#$Sheet1`), and Calc can rewrite an external
reference into an absolute file URL. Two enforced layers keep them out of every reply:

- **Withheld strings (mandatory).** The harness lists the trial dir, vault root, fixture
  dir, oracle config and other trials' dirs in `MYCO_STATE_WITHHELD`. The launch audit, the
  plan builder and the server itself all refuse to run without the list. The backend's raw
  cell, sheet and status strings are checked against each entry, as written, JSON-escaped
  and file-URL-encoded, BEFORE any scrubbing, so a partial scrub cannot hide one; a hit
  gives `OUTPUT_WITHHELD`. The serialized reply is checked again at the end.
- **Path scrubbing (every string).** Cell `display`, `value` and `formula`, sheet names and
  UI-tree names have path-like text replaced with `[path]`: file URLs (to the next quote,
  so a path with spaces goes whole), absolute POSIX paths, drive and UNC paths, and `~/`
  paths. A cell changed this way carries `pathScrubbed: true`. Dates (`2024/06/21`),
  formula division (`=(A1)/(B1)/2`) and web URLs are left alone. This covers host paths the
  list does not name (for example a home directory).

The scrubber is a pattern, so it is the second layer, not the guarantee: an exotic spelling
of a path that is not on the withheld list could get past it. The withheld list is the
layer that names the paths that matter.

### Other defense in depth

- **Codes only.** Every refusal is a code. A backend exception, timeout or malformed reply
  becomes `BACKEND_ERROR`, and its text goes to the operator's stderr only. An unknown tool
  or method is not echoed.

The tests plant `PLANTED_FAKE_MARKER` in the pristine fixture, the vault, the oracle config
and another trial's dir. Then they check that no tool output contains the marker or any of
those paths:

- `test/state/state-scope.test.ts` (hermetic) runs a battery of valid and hostile calls,
  including path-like sheets and ranges and smuggled `path`, `runId`, `taskId`, `file` and
  `trial` fields;
- `test/state/state-host-paths.test.ts` covers the two host-path layers, including a
  `=CELL("filename")` cell whose path has spaces;
- `test/linux/state-e2e.test.ts` runs against a real live Calc from a trial dir whose path
  has spaces, types `=CELL("filename")` into the agent's document and gets
  `OUTPUT_WITHHELD`, and checks every byte the server wrote.

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
| Characters per cell text or formula (UTF-16 code units; an emoji is 2) | 512 | cut, `truncated: true` |
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
