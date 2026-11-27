# Live watch view (`myco watch`)

A read-only local web page for one or more runs. It shows two things side by side:

- **The agent's desktop** as a frame series: PNG images from a frame directory or from
  the run's sealed capture in the verdict vault (each rebuilt from its pixels before it is
  served), or SVG rendered in-process from the mock transport in the demo.
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
  --frames <dir>                      # frames from <dir>/<runId>/*.png (PNG only)
# or: --sealed-capture <vaultRoot>    # PNGs under <vaultRoot>/<runId>/captured/**
```

- `--run` is required and can be repeated. The page shows only the runs you name. A
  decision line for any other run is counted as "not shown" and never streamed.
- `--task` is optional and can be repeated. A task id appears on the page only if you
  name it here.
- The decision log is tailed live. A log that does not exist yet is waited for, never
  created.
- Only PNG files are listed. JPEG, GIF, WebP and SVG files are never listed or served
  (see "Frame redaction" below).
- `--sealed-capture` lists PNG files under `captured/`, skipping `captured/persisted/`
  (the oracle's input). It never opens anything outside `captured/`: not the seal, the
  ground truth, the fixtures or any manifest. The view does not verify the capture's
  hashes, because it is a viewer, not a verdict. The verdict is the gate's.

## Follow an R1 pilot or A/B run (`--pilot`)

```sh
pnpm myco-watch --pilot <runDir>      # an R1 pilot run directory (scripts/m2-r1-pilot.ts --out)
pnpm myco-watch --pilot <stageRoot>   # a corrections A/B stage root, with on/ and off/ arms
```

The page adds a **Pilot run** panel and follows the run as it happens. You can start it before
the run begins: files that do not exist yet are waited for, never created. It reads only the
run's existing durable outputs, as `src/pilot` writes them (`src/watch/run-dir.ts`):

| File | What the page shows |
|---|---|
| `pilot-progress.jsonl` | Each attempt: running, decided or harness fault (class from the pilot's closed list, `other` otherwise). Also the attempt number, the attempt it re-runs in place, whether it was closed on resume, and from the arm row: what the agent said (`done` / `not-done` / `no-claim`), whether the gate was called (or the task was unregistrable), the gate's post-stop verdict, accepted (only with `verified`), corrections on or off, the cause kind and the wall-clock seconds. It also shows whether the header says SIMULATED |
| `live-status.json` | Runner, `running` / `finished`, start and heartbeat times, **stale** when a running run's heartbeat is older than 180 s, exit code, run status and stop code |
| `attempts.jsonl` (#518, A/B arms) | Per trial: `agrees`, `behind` or `disagrees` with the progress file (start, then end outcome and harness class) |
| `grades.jsonl` (A/B arms) | The independent grader's status only: `pass` / `fail` / `ungradable` |
| `trials/<trialKey>/transcript.json` | The agent's actions: turns, tool calls by closed name (the gate tool or `other`), refused tool uses, and each gate call's verdict and reason codes (`REASON_CODES` only) |

The page never shows the heartbeat's `lastLog`, `error` or pid, a fault's `faultMessage`, an
arm row's `cause.detail`, `faultClass` or digests, the agent's text or claim text, the gate's
claim echo, corrections or evidence, or the grader's reasons and target. It never opens the
oracle's inputs or the vault: `vault/`, `gate-evidence/`, `doc.csv`, `gate-tasks.json` and
`mcp.json` (tested with FIFOs planted at those paths). A transcript is reached only through
non-symlink components. An id that is not a safe id is dropped; a safe id has no `/` or `\`, so
it cannot carry a host path such as the home or temp directory (a bare username inside an id is
not dropped). Timestamps are shown only when they are strict ISO-8601 UTC. As a backstop, the server refuses the whole pilot view
(`pilotRefused`) if a host needle, an absolute host path or a key-shaped string survives the
projection. The run directory's path is never printed or served.

**Limits.** The live driver writes `transcript.json` when `claude` exits, so the agent's actions
for an attempt appear when that attempt ends. While it runs, the page shows it as running, with
the heartbeat. With the pilot's `--output-format json`, the transcript is one result object: the
page shows the turns and the refused tool uses, and per-call gate results only for a `--verbose`
(message array) transcript. Pilot trials have no frames yet. `--pilot` can be combined with
`--run` / `--decision-log` / `--frames` for a gate decision log and frames you name.

Every simulated run is marked `SIMULATED · NOT EVIDENCE` on the page; an A/B stage is marked if
either arm's header says simulated. The view is a viewer, not
a verdict: "accepted by the gate" is not graded.

## Security model

| Property | How it holds | Test (`test/watch/`) |
|---|---|---|
| Loopback only | The server binds `127.0.0.1` by default. Any bind address that is not loopback (127.0.0.0/8, `::1`, `localhost`) is refused unless `--allow-non-loopback` is given. The address the socket actually bound to is checked again. | `server-security`: loopback-only bind |
| No DNS rebinding | The `Host` header must name a loopback host on the bound port, or the bind host itself (for example `127.0.0.2`). Any other host gets 421. A `[::1]` bind is passed to the socket without brackets. | foreign Host header; `round2`: `127.0.0.2` bind (where the OS has that address; macOS `lo0` has only `127.0.0.1` without an alias, and there the test asserts the OS refusal instead), `[::1]` bind, `Origin: null`. `round3`: the Host allowlist for a `127.0.0.2` bind, without binding it |
| No CORS | No response ever carries `Access-Control-Allow-*`. A request with a foreign `Origin` gets 403. | foreign Origin, no CORS headers on any route |
| Read-only | Every method other than GET (including HEAD and OPTIONS) gets 405 on every path, before routing. Refusing HEAD is deliberate (stricter than allowing GET and HEAD). No route reads a body. | every non-GET method × every route |
| No handle on the gate | The server's only inputs are a log path, a frame source and, with `--pilot`, a run directory read through `run-dir.ts` (the files listed in "Follow an R1 pilot or A/B run"). The passive modules import only `node:fs` read calls, `node:http`, `node:net`, `node:path`, `src/gate/api.ts` (the reason-code list and the id check) and two type-only imports. They have no write call and no process spawn. | static import/write scan |
| Passive | The log and frames are opened `O_RDONLY \| O_NOFOLLOW`. Running the view, polling, and every request (including refused writes) leave every file unchanged: size, mode, mtime and sha256. | tree snapshot before/after, both unit and demo e2e |
| No path traversal | A frame is addressed as `/frames/<listed runId>/<index>`. The index selects from a listing the server built itself, so a name or path from the request is never used. Requests with `%`, `?`, `\`, or `.`/`..` segments get 400. Symlinks are not listed and not followed. | 23 traversal forms, symlink to a secret; `round2`: a component that became a symlink after listing, a symlinked file, and an unlisted run on a frame source that would serve it |
| Frame redaction | A frame's bytes are never served as they are. See "Frame redaction" below. | `round2`: a sealed capture with the planted marker and a fake `/Users/…` path inside SVG text, PNG `tEXt`/`iTXt`/`zTXt`/`eXIf`/private chunks, a suggested palette, a palette image, bytes after `IEND`, a JPEG comment and pixel bytes deflate stores verbatim; no response contains them |
| Bounded memory | At most 16 SSE watchers (the 17th gets 503). A watcher that has not drained its last message is not written to again; it gets the latest state when it drains, so updates coalesce. A watcher stalled for longer than 30 s, or holding more than 8 MiB unsent, is disconnected (its `EventSource` reconnects and gets the full state). The state carries at most the latest 2000 events; the rest are counted as `omitted` and the page says so. A watcher that stalls and then drains again starts a fresh 30 s clock. Plain clients are bounded too: at most 64 open connections (the next is closed at once), and a connection with no read or write activity for 60 s is destroyed, so a client that pipelines requests and never reads holds its responses for at most that long. | `round2`: a watcher that never reads holds at most about one state message while more than 40 MB is published; a slow watcher ends on the latest state; stall timeout and buffer cap disconnect; the client cap; `maxEvents`. `round3`: a stall followed by recovery is not dropped later; the connection cap; a never-reading pipelined client is destroyed by the idle timeout |
| Redaction by allowlist | The stream carries only `WatchEvent`s (`src/watch/events.ts`). Each field is rebuilt from a closed vocabulary or a strict pattern: verdict, reason codes from `REASON_CODES`, checkpoint numbers, operator-listed ids, ISO timestamps. The claim, the human-readable reasons, evidence paths and digests, the oracle family and version, and any unknown field are never streamed. File and directory names never leave the frame source. | planted `PLANTED_FAKE_MARKER` and a fake absolute path in every free-form log field, frame names and the operator directory; no HTTP response contains them, the operator directory, the home directory or the username |
| Page hardening | Strict CSP (`default-src 'none'`, script and style from self only, no inline code). The script builds nodes with `textContent`, never `innerHTML`. Frames are served with `sandbox` CSP. Every response sets `nosniff`, `no-referrer`, `no-store` and `X-Frame-Options: DENY`. | — |

### Frame redaction

Frame files are operator-side input that the view does not control, so their bytes never
reach a response as they are (`src/watch/sanitize-frame.ts`). Every frame passes three
layers:

1. **Provenance.** File-backed sources (`--frames`, `--sealed-capture`) list PNG only.
   SVG is text and can carry anything, so it is served only when this process drew it:
   the demo renders each frame in memory (`render-frame.ts`, every string escaped and
   clipped, host facts never read) and tags it `rendered`. The server refuses any other
   frame type.
2. **Rebuild, not copy.** Each PNG is decoded and re-encoded from its pixels alone: a
   fresh `IHDR`, one `IDAT` compressed by this process, and `IEND`. Every ancillary chunk
   is dropped unread (`tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`, `iCCP`, private chunks), and
   so is any byte after `IEND`. A palette image is expanded to RGB(A), so palette bytes do
   not pass through either. Interlaced, malformed, oversized or CRC-failing files are
   refused. A refused frame gets a 404.
3. **Backstop scan.** The bytes about to be served are refused if they contain the home
   directory, the username, the temp directory, an absolute host-path prefix (`/Users/`,
   `/home/`, `/srv/`, `C:\Users\`, UNC, …) or a key-shaped prefix. A PNG is also refused
   if it contains a run of 16 or more identifier or path characters. In compressed
   binary, that run is what text stored verbatim by deflate looks like. **Estimate, not
   measured:** a back-of-envelope count over the 4-byte needles and patterns (`ghp_`,
   `gho_`, `/tmp`, `/<user>`) suggests a real screenshot is falsely refused with a
   probability on the order of 5 in 10,000 per MB of compressed image. No corpus of real
   screenshots has been run through the scan.

### Limits

- **Pixels are the frame.** A screenshot shows whatever was on the screen, and a crafted
  image can draw any text. The view strips every non-pixel byte, but it does not OCR or
  blur. The sealed capture is the guest VM's desktop, not the host's. Choose which
  captures to serve. The demo draws only the mock app's visible content. Host facts such
  as the fake spreadsheet's document path are never drawn (tested).
- **Frame counts include frames that will be refused.** The listing counts every PNG
  file. A file the sanitizer refuses shows as a missing image on the page.
- **Untested layer.** The server and the frame source both check that a run is listed.
  The re-check that no path component became a symlink, and `O_NOFOLLOW`, are each tested
  directly (`resolveListed`, `readRegular`). The race window between the listing and the
  read is not exercised end to end.
- **Unauthenticated.** Anyone who can reach the port can read the page. That is why the
  default is loopback and the override flag is explicit. Do not use
  `--allow-non-loopback` on an untrusted network.
- **Attribution follows the log.** An `ASSIGNMENT_MISMATCH` line records the run the
  agent *named*. If that run is one you listed, the line shows under it.
