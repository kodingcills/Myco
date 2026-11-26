# `myco-state`: structured app state for agents (tool reference)

Capability track I. Status: Linux headless Calc backend shipped; Windows backend not built yet.

Agents working in a desktop app usually guess what the app holds from screenshots.
`myco-state` lets them read it instead: the cells (values and formulas as the app holds
them), the sheets and their used ranges, whether the document has unsaved edits, and a
bounded summary of the window's accessibility tree. Every tool only reads.

> **Live state is not proof of completion.** These tools report what the app holds in
> memory right now. An edit can show here and still not be saved. Only the completion gate
> (`myco-gate`, which reads the persisted bytes the harness captures after the agent stops)
> and the independent grader decide whether a task is done. Every successful reply carries
> this notice in its `notice` field, and the server's `initialize` instructions say it too.

The security model is in [security.md](security.md). The measurement plan is in
[measurement-plan.md](measurement-plan.md).

## Running it

The harness starts one server per trial. The agent never starts it and cannot name its
target.

```sh
MYCO_STATE_RUN_ID=<run id> MYCO_STATE_UNO_PIPE=<pipe> pnpm myco-state mcp
```

| Variable | Set by | Meaning |
|---|---|---|
| `MYCO_STATE_RUN_ID` | harness | The trial this server is bound to. The launch audit checks it equals the trial's run id. |
| `MYCO_STATE_UNO_PIPE` | harness | The UNO pipe of the trial's live soffice (`statePipeFor(runId)`, shape `myco-state-<hex>-<hex>`). Not a path. |
| `MYCO_STATE_WITHHELD` | harness, required | JSON array of 1 to 64 absolute host paths (trial dir, vault, fixture, oracle config, other trials) that no reply may contain. The server does not start without it. |
| `MYCO_PYTHON` | operator, optional | Python with LibreOffice's UNO bridge (default `python3`). |

`myco-state` takes no argument except `mcp`. With a missing or malformed binding, or any
extra argument, it exits 2 and serves nothing.

The Linux path's live session (`src/state/linux/live-calc.ts`) starts one headless soffice
for the trial, with a throwaway profile, the agent's own copy of the document loaded, and
the UNO pipe. The state server's reader (`scripts/linux/calc_state.py`) connects to that
pipe for each call.

## Tools

All four tools are `readOnlyHint: true`, `destructiveHint: false`. Each input schema has
`additionalProperties: false`. No tool takes a path, a file, a URL, a run id, a task id or
a trial.

### `state_list_sheets`

No arguments. Returns the open document's sheets, at most 64.

```json
{ "sheets": [{ "index": 0, "name": "employees", "usedRange": "A1:F21" }],
  "sheetCount": 1, "truncated": false }
```

`usedRange` is `null` for an empty sheet.

### `state_read_range`

| Argument | Type | Meaning |
|---|---|---|
| `range` | string, required | A1 cell or range, such as `"B8"` or `"A1:F21"`. At most 400 cells, and at most 200 rows or columns. |
| `sheet` | integer or string, optional | 0-based index or exact name. If you omit it, the tool reads the first sheet. |

Returns `rows`: one array per row, one entry per cell.

```json
{ "sheet": { "index": 0, "name": "employees" }, "range": "B8:B8",
  "rows": [[{ "ref": "B8", "kind": "text", "value": "Enzo Kaur", "display": "Enzo Kaur" }]] }
```

| Field | Meaning |
|---|---|
| `kind` | `empty`, `number`, `text` or `formula`. |
| `value` | The number or text the cell holds. For a formula, its current result. `null` when the cell is empty or the formula is an error. |
| `display` | The text the app shows for the cell. |
| `formula` | For a formula cell, the formula as the app holds it (`=C2*2`). |
| `formulaResult` | For a formula cell: `number`, `text` or `error`. |
| `truncated` | Present when `display` or `formula` was longer than 512 characters (UTF-16 code units, as JavaScript counts them; an emoji is 2) and was cut. |
| `pathScrubbed` | Present when path-like text in `display`, `value` or `formula` was replaced with `[path]` (for example a pasted file URL). |

While any formula in the document (any sheet, any named expression) calls `CELL` or
`INFO`, every `state_read_range` and `state_ui_tree` call returns `OUTPUT_WITHHELD`, even
for cells that do not use it. Delete that formula to read again. See
[security.md, Host paths](security.md#host-paths).

### `state_document_status`

No arguments.

```json
{ "modified": true, "hasStorageLocation": true, "readOnly": false,
  "sheetCount": 1, "activeSheet": "employees" }
```

`modified: true` means the live document has edits that are not stored yet. After a
successful save it reads `false`. `hasStorageLocation` says whether the document has a
location; the location itself is never reported.

### `state_ui_tree`

| Argument | Type | Default | Maximum |
|---|---|---|---|
| `maxDepth` | integer >= 1 | 4 | 8 |
| `maxNodes` | integer >= 1 | 60 | 200 |

Returns a breadth-first summary of the app window's accessibility tree. The walk is
breadth-first, so the node budget covers the top levels first. Each node lists at most 25
children, because a spreadsheet table has millions.

```json
{ "tree": { "role": "root_pane", "name": "[path] — LibreOffice Calc", "childCount": 7,
            "children": [{ "role": "menu_bar", "name": "", "childCount": 11, "childrenOmitted": "depth" }] },
  "nodes": 8, "truncated": true }
```

`childrenOmitted` says why a node's children are missing or incomplete: `depth`, `nodes`
or `width`. Path-like text in names and roles (window titles carry file names) is
replaced with `[path]`. The tree is available only where the backend has an accessibility
implementation behind the window; where it does not (some headless LibreOffice builds),
the tool returns `UI_TREE_UNAVAILABLE`.

## Replies and codes

A successful reply:

```json
{ "api": "myco.state/v1", "ok": true, "tool": "state_read_range", "backend": "linux-uno",
  "notice": "Live app state, read-only. Not proof of completion: …", "data": { … } }
```

A refusal has `isError: true` and carries a code only:

```json
{ "api": "myco.state/v1", "ok": false, "tool": "state_read_range", "code": "RANGE_TOO_LARGE" }
```

| Code | When |
|---|---|
| `INVALID_REQUEST` | The arguments are not a plain object, or a field has the wrong type. |
| `UNKNOWN_FIELD` | An argument the tool does not declare, such as `path` or `runId`. |
| `UNKNOWN_TOOL` | Returned as JSON-RPC error -32602 `unknown tool`. The name is not echoed. |
| `INVALID_RANGE` | `range` is not an A1 cell or range. |
| `RANGE_TOO_LARGE` | More than 400 cells, or more than 200 rows or columns. |
| `UNKNOWN_SHEET` | No sheet with that index or name. |
| `LIMIT_OUT_OF_RANGE` | `maxDepth` or `maxNodes` is outside its bounds. |
| `OUTPUT_TOO_LARGE` | The serialized reply would exceed 64 KiB. |
| `OUTPUT_WITHHELD` | The document holds a `CELL`/`INFO` formula (cell reads and the UI tree only), or the reply would contain a harness-withheld host path, including a re-spelling of one (separators, case or prefix changed). |
| `UI_TREE_UNAVAILABLE` | The backend has no accessibility tree for the window. |
| `DOCUMENT_UNAVAILABLE` | The trial's app has no single open spreadsheet, or cannot be reached. |
| `BACKEND_ERROR` | The backend failed, timed out, or returned something over a cap. The detail goes to the operator's log, never to the agent. |

JSON-RPC framing follows `myco-gate`. A parse error gets -32700, and the server keeps
serving. A batch gets -32600. An unknown method gets -32601 `method not found`, without
echoing the method. A notification gets no reply.

## Backends

`StateBackend` (`src/state/backend.ts`) has four read methods and no other method. It has
no write, open or path argument.

| Backend | Status | Reads |
|---|---|---|
| `linux-uno` | shipped | A live headless LibreOffice Calc over Python-UNO (`src/state/linux/uno.ts`, `scripts/linux/calc_state.py`). |
| `windows-uia` | not built | Planned: the guest's Calc over UIA/UNO, through the guest agent. It implements the same four methods. The VM work is local and single-owner, so it comes later. |
| `fake` | tests | An in-memory grid (`test/state/fake-backend.ts`). |

## Arms

`src/state/arms.ts` builds and audits the launch plans for the measurement
(`screenshot-only`, `hcu+shell`, `structured-state`). See
[measurement-plan.md](measurement-plan.md).
