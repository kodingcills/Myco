# Direction A — first-use quickstart

Status: **dry-run path works today; the live path is gated on the Coordinator's host
GO.** This page is the exact sequence a fresh coding agent follows. It was run
end-to-end on 2026-11-22; the measured numbers are below and are not estimates.

## What you get

A task package, a real verdict from persisted state, and a run directory you can
attach to a PR. The demo task is the dogfood `myco-todo` app with its seeded
persistence bug: the UI says "saved N item(s)" while the store drops `BUG`-prefixed
items.

## 1. Install and check the toolchain

```sh
pnpm install --frozen-lockfile
pnpm typecheck
```

## 2. Run the task (dry-run, no desktop)

```sh
pnpm test:task tasks/todo-save.yaml
```

Expected, and observed:

```
[myco] Final Verdict: REFUTED
[myco] False Success Caught: YES
UI Status Claim:   "saved 7 item(s)"
Agent Self-Report: "All 4 items added and confirmed saved"
Items Missing:     ["bug: login page crashes on save", "BUG: token expires too early"]
```

Exit code **1** means `refuted`; **2** means `uncertain`; **0** means `verified`.
The dry-run is a simulated contract harness — it proves the task package, the
oracle, and the report shape, **not** that a desktop was driven.

Measured on this Mac: **1.3 s wall-clock**, 14 `[myco]` log lines, one command.

## 3. Inspect the evidence

```sh
ls runs/direction-a-todo-save
# artifacts/ ledger.jsonl manifest.json result.json trace.extended.jsonl trace.jsonl
```

`result.json` carries the verdict and per-check reasons; `trace.jsonl` carries the
step events; `manifest.json` hashes the bundle. The `.mycotrace` archive next to the
directory is the same bundle in one file.

## 4. Open the report

The v0 Viewer reads a `.mycotrace` or a run directory offline. It is a static build:

```sh
pnpm --filter viewer build
# open viewer/dist/index.html and drop runs/direction-a-todo-save.mycotrace
```

The viewer is the human surface; it computes nothing and shows `Unknown` for a
record with no verdict.

## 5. The live path (gated)

Live Direction A needs the RT-020 Linux guest, `myco-todo` deployed, and the
Coordinator's host GO. The preflight is the gate:

```sh
pnpm tsx scripts/discovery-preflight.ts --probe preflight.json
```

`preflight.json` is the probe result (see `src/discovery/preflight.ts`). It refuses
to proceed unless the Coordinator GO, the host lock, the guest, the app, the store,
the oracle, and a clean guest all check out. A failed preflight is an abort, not a
retry.

## What this quickstart does not claim

- The dry-run is not head-to-head evidence and is never counted as a live run.
- The live path has not been run from this page yet; when it is, the measured
  time-to-first-verified-result replaces the dry-run number above.
- No account, no paid service, no VM is needed for steps 1–4.
