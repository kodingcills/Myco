# Live watch view (`myco watch`)

A read-only local web page for one or more runs. It shows two things side by side:

- **The agent's desktop** as a frame series: images from a frame directory, from the
  run's sealed capture in the verdict vault, or rendered from the mock transport in the
  demo.
- **The gate timeline**: every `myco_gate_check` decision as it lands. Each entry shows
  the verdict, whether the result was accepted, the reason codes, per-checkpoint verdicts
  for multi-step tasks, and the call number on the run (calls after the first are marked
  `retry`).

It is the demo surface. It reads only through operator-side interfaces (the gate's
decision log and the frame files) and cannot call or influence the gate, the vault, an
oracle or the agent.

Code: `src/watch/`. Tests: `test/watch/`.

## Run the demo (no VM, no model)

```sh
pnpm myco-watch --demo calc-multi-step    # multi-step Calc, one retry (TIF-270 demo)
pnpm myco-watch --demo todo-items         # todo gate demo (TIF-265 demo)
# or: bin/myco watch --demo calc-multi-step
```

The command prints `myco watch (demo …): http://127.0.0.1:8740/`. Open that URL. The
server starts first. Then the existing mock demo (`src/gate/demo.ts` or
`src/gate/multistep-demo.ts`) runs into a temporary directory, so frames and decisions
appear as they land. Pick a run from the menu. In `calc-multi-step`, the run
`ms-slip-then-repair-retry` shows the whole story: checkpoint 1 verified, checkpoints 2–3
refuted (`TARGET_MISMATCH`), then the retry from checkpoint 1 verified (`ORACLE_PASS`).
The demo prints `demo finished: PASS` and keeps serving until you press Ctrl-C. Use
`--port 0` for a free port and `--out <dir>` to keep the demo output.

Every frame and decision in the demo is `mock`. None of it is evidence.

## Watch a real run

```sh
pnpm myco-watch --run <runId> --task <taskId> \
  --decision-log <the file given to myco-gate --audit> \
  --frames <dir>                      # frames from <dir>/<runId>/*.png|jpg|jpeg|gif|webp|svg
# or: --sealed-capture <vaultRoot>    # images under <vaultRoot>/<runId>/captured/**
```

- `--run` is required and can be repeated. The page shows only the runs you name. A
  decision line for any other run is counted as "not shown" and never streamed.
- `--task` is optional and can be repeated. A task id appears on the page only if you
  name it here.
- The decision log is tailed live. A log that does not exist yet is waited for, never
  created.
- `--sealed-capture` lists image files under `captured/`, skipping `captured/persisted/`
  (the oracle's input). It never opens anything outside `captured/`: not the seal, the
  ground truth, the fixtures or any manifest. The view does not verify the capture's
  hashes, because it is a viewer, not a verdict. The verdict is the gate's.

## Security model

| Property | How it holds | Test (`test/watch/`) |
|---|---|---|
| Loopback only | The server binds `127.0.0.1` by default. Any bind address that is not loopback (127.0.0.0/8, `::1`, `localhost`) is refused unless `--allow-non-loopback` is given. The address the socket actually bound to is checked again. | `server-security`: loopback-only bind |
| No DNS rebinding | The `Host` header must name a loopback host on the bound port (or the explicit bind host). Any other host gets 421. | foreign Host header |
| No CORS | No response ever carries `Access-Control-Allow-*`. A request with a foreign `Origin` gets 403. | foreign Origin, no CORS headers on any route |
| Read-only | Every method other than GET (including HEAD and OPTIONS) gets 405 on every path, before routing. No route reads a body. | every non-GET method × every route |
| No handle on the gate | The server's only inputs are a log path and a frame source. The passive modules import only `node:fs` read calls, `node:http`, `node:net`, `node:path`, `src/gate/api.ts` (the reason-code list and the id check) and two type-only imports. They have no write call and no process spawn. | static import/write scan |
| Passive | The log and frames are opened `O_RDONLY \| O_NOFOLLOW`. Running the view, polling, and every request (including refused writes) leave every file unchanged: size, mode, mtime and sha256. | tree snapshot before/after, both unit and demo e2e |
| No path traversal | A frame is addressed as `/frames/<listed runId>/<index>`. The index selects from a listing the server built itself, so a name or path from the request is never used. Requests with `%`, `?`, `\`, or `.`/`..` segments get 400. Symlinks are not listed and not followed. | 23 traversal forms, symlink to a secret |
| Redaction by allowlist | The stream carries only `WatchEvent`s (`src/watch/events.ts`). Each field is rebuilt from a closed vocabulary or a strict pattern: verdict, reason codes from `REASON_CODES`, checkpoint numbers, operator-listed ids, ISO timestamps. The claim, the human-readable reasons, evidence paths and digests, the oracle family and version, and any unknown field are never streamed. File and directory names never leave the frame source. | planted `PLANTED_FAKE_MARKER` and a fake absolute path in every free-form log field, frame names and the operator directory; no HTTP response contains them, the operator directory, the home directory or the username |
| Page hardening | Strict CSP (`default-src 'none'`, script and style from self only, no inline code). The script builds nodes with `textContent`, never `innerHTML`. Frames are served with `sandbox` CSP. Every response sets `nosniff`, `no-referrer`, `no-store` and `X-Frame-Options: DENY`. | — |

### Limits

- **Frame pixels are passed through.** A screenshot shows whatever was on the desktop. The
  view does not OCR or blur images. Choose which captures to serve. The demo's frames are
  drawn from the mock app's visible content only. Host facts such as the fake
  spreadsheet's document path are never drawn (tested).
- **Unauthenticated.** Anyone who can reach the port can read the page. That is why the
  default is loopback and the override flag is explicit. Do not use
  `--allow-non-loopback` on an untrusted network.
- **Attribution follows the log.** An `ASSIGNMENT_MISMATCH` line records the run the
  agent *named*. If that run is one you listed, the line shows under it.
