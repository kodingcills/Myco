# Scheduled and triggered runs (capability track S)

Status: M2 scope (Tiffany, 2026-11-26 10:41 ET override). Tier 2. Local-only, loopback-only,
$0 by default. The code is `src/schedule/`, the CLI is `pnpm myco-schedule`, the tests are
`test/schedule/`. Security model: [security.md](security.md). Pre-registered measurement bar
proposal for the capability spec: [measurement-bar.md](measurement-bar.md).

## What it adds

A desktop agent run usually starts because a person typed a prompt. Track S lets runs start
unattended, and still be trusted:

- **Cron**: a 5-field cron expression, evaluated in UTC.
- **File arrival**: a file lands in an operator-configured inbox directory.
- **Webhook**: a signed HTTP POST to the service on 127.0.0.1.
- **Manual**: `myco-schedule trigger --schedule <id>`.

Every triggered run goes through the same gated path as any other run (`runGatedTrial`:
launch audit, sealed vault, gate bound to the one trial, persisted-bytes capture after the
agent stopped, the harness's own check). Each run is reported with the gate's verdict
(`verified` / `refuted` / `uncertain`) in a MAC-chained ledger, and anything other than
`verified` notifies the operator. The trigger only says *which schedule fired*. The schedule
fixes the task. The scheduler derives the run id from the trigger key. The gate's agent-facing
contract (`myco.gate/v1`: the agent supplies taskId, runId and claim only) is unchanged.

## The schedule file

```json
{
  "version": "myco.schedule/v1",
  "stateDir": "/var/lib/myco/schedule",
  "ledgerKey": { "keyFile": "/home/op/.myco/secrets/schedule.env", "keyName": "MYCO_SCHEDULE_LEDGER_KEY" },
  "tickSeconds": 30,
  "webhook": { "port": 8787, "secretsFile": "/home/op/.myco/secrets/schedule.env", "secretName": "MYCO_WEBHOOK_SECRET" },
  "notifier": { "kind": "file", "path": "/var/lib/myco/schedule/notifications.jsonl" },
  "schedules": [
    {
      "id": "nightly-calc",
      "taskId": "fc-v1-001",
      "cron": "30 2 * * *",
      "events": { "inbox": { "dir": "/var/lib/myco/inbox" }, "webhook": true, "manual": true },
      "budget": { "runsPerDay": 4, "wallTimeS": 900, "concurrency": 1 },
      "missed": "run-latest"
    }
  ]
}
```

The parser is strict and fails closed. An unknown key, a wrong type, a relative path, a
missing budget or an unsupported cron term refuses the whole file, so a typo cannot drop a
guardrail. Secrets are never in this file: it names a secrets file by path and the variable
in it by name (see [security.md](security.md)). Any string that looks like a key is refused,
and the error names the JSON path, never the value.

Cron supports `*`, numbers, `a-b`, `*/n`, `a-b/n` and comma lists. Day 7 is Sunday. When both
day-of-month and day-of-week are restricted, either one matching is enough (the Vixie rule).
Names (`MON`), `L`, `W`, `#` and `?` are refused rather than guessed.

## Guardrails

| Guardrail | Behaviour | Code in the row |
|---|---|---|
| Idempotent triggers | Each trigger has a key: the cron slot's time, the inbox file's name and SHA-256, the webhook delivery id, or the manual request id. The key's digest is written with fsync to `claims.jsonl` **before** the run starts. A key never runs twice, across restarts too. Claims are checked in memory, so only one service may use a `stateDir`: the service takes `<stateDir>/LOCK` exclusively (`O_EXCL`) at start, a second `serve` on the same `stateDir` refuses to start, and a lock left by a crashed service is not taken over (remove it once no service runs). Claims are re-read from disk after the lock is taken, so a key claimed by a service that stopped just before is not missed. A corrupt claims file stops the service from starting, because skipping a line could forget a claim. | `DUPLICATE` |
| Runs per day | Admitted triggers per schedule per UTC day, counted from the durable claims, so a restart does not reset the count. A refused key is claimed, so it is not retried. | `BUDGET_RUNS_PER_DAY` |
| Concurrency | Runs of one schedule in flight at once. A webhook or a direct submit over the limit is refused (the sender can retry with the same delivery id). Inbox files and manual requests stay queued until a slot is free. A run keeps its slot until its executor has actually stopped, even after its `timeout` or `killed` row is written, so an executor that ignores the abort signal still blocks further runs of that schedule. Stopping the service (SIGINT/SIGTERM on `serve`) writes the remaining rows, then waits for every such executor to settle before it removes `LOCK`, so a restart cannot exceed the limit either; `serve` keeps running until then. | `BUDGET_CONCURRENCY` |
| Wall time | Each run gets an abort signal. Past `wallTimeS` the signal is aborted and the run is recorded as `timeout`, never verified. The shipped executors stop on it: the scripted transport rejects at once (no capture, no verdict), and `gatedRunExecutor` never launches the agent if the signal fired while preparing. An operator transport must stop the agent on `req.signal`; until it does, the run holds its concurrency slot. | `BUDGET_WALL_TIME` |
| Policies | The scheduler will not start without at least one policy (`RunPolicy`, the track O interface; lands with O). Every policy is applied to every trigger, whatever its source, after admission and before the executor. A policy that throws, or returns anything but a well-formed decision, denies. | `POLICY_DENIED` + the policy's code, `POLICY_ERROR`, `POLICY_INVALID` |
| Pause / kill | `<stateDir>/PAUSED` pauses every schedule. Create it with `myco-schedule pause`, or just `touch` it, whether the service is running or stopped. `myco-schedule kill` also aborts runs in flight on the next tick; aborted runs are recorded as `killed`, including a kill that lands while the policies are being evaluated. Pause is checked at admission and again after the policies. A trigger paused between admission and that second check keeps its claim: its key and its runs/day slot are used up and it does not run later. | `PAUSED`, `KILLED` |
| Fail-closed verdicts | A row is `accepted` only when the gate decided `verified` with `accepted: true` and `ORACLE_PASS` for this exact run id. Any other result is not verified: a throw, a launch-audit refusal, a timeout, a kill, or a malformed, inconsistent or mismatched result. | `EXECUTOR_ERROR`, `LAUNCH_AUDIT_REFUSED`, `RESULT_INCONSISTENT`, `RESULT_RUN_MISMATCH`, `EXECUTOR_INVALID_OUTPUT` |
| Ledger | One row per decision in a MAC-chained ledger (`src/integrity/ledger.ts`), so an edited, deleted or reordered row is detected. If the row cannot be written, the run is reported as `error`, never verified. | `LEDGER_FAILED` |
| Never evidence | Rows always carry `evidence: false`. `simulated` is true unless the executor explicitly says otherwise. Scheduled rows are operational records and never count as benchmark evidence. | — |

## Missed-run handling

The service keeps a cursor (`cursor.json`) holding the time of its last cron evaluation. On
each tick it lists the cron slots between the cursor and now:

- A slot evaluated within the grace window (the larger of 120 s and two ticks) runs normally.
- **Late slots**, for example after the service was down or the laptop slept:
  - `"missed": "skip"` (the default): no late slot runs. One summary row (`MISSED`, with
    the count and the first and last slot) is written, and the operator is notified.
  - `"missed": "run-latest"`: the most recent late slot runs once (only if no slot is on
    time). The rest go into one `MISSED` summary row.
- **While paused**: cron slots are skipped and recorded in one quiet `PAUSED` summary row.
  They are not caught up after resume. Inbox files, manual requests and webhook retries are
  events, not slots: they stay queued (the webhook answers 423 so the sender retries) and run
  after resume.
- **First start**: the cursor starts at "now". Slots from before the service ever ran are
  not run.
- A corrupt cursor stops the service from starting. A cursor more than a year old is
  scanned for its most recent year only.

The summary is one row, not one row per slot, so a week of downtime on a per-minute schedule
does not flood the ledger.

## Running it

```sh
pnpm myco-schedule serve   --config schedule.json --allow-task fc-v1-001
pnpm myco-schedule trigger --config schedule.json --schedule nightly-calc [--key req-42]
pnpm myco-schedule pause   --config schedule.json
pnpm myco-schedule kill    --config schedule.json
pnpm myco-schedule resume  --config schedule.json
pnpm myco-schedule status  --config schedule.json
```

`serve` runs the $0 scripted executor only: the real gate on fc-v1 tasks, with a scripted
agent and no model or VM. Every row is `simulated`. `--allow-task` is required, because the
service applies at least one policy. A live executor that runs an agent on the Windows VM is
out of this PR: it needs the VM lock and the lead's GO.

To fire the webhook, POST to `http://127.0.0.1:<port>/v1/trigger/<scheduleId>` with an
`x-myco-delivery` header (1 to 128 characters from `[A-Za-z0-9._-]`; this is the idempotency
key) and an `x-myco-signature` header. Compute the signature in-process with the secret read
from the secrets file (`webhookSignature` in `src/schedule/webhook.ts`). Never put the secret
on a command line. `test/schedule/webhook.test.ts` has complete signed requests.

The signature is `sha256=` followed by the hex HMAC-SHA256 over
`"myco.schedule.webhook/v1\n" + scheduleId + "\n" + deliveryId + "\n" + body`.

## Seams (for sibling tracks)

- `RunPolicy` (`src/schedule/runtime.ts`): track O's policy engine is adapted to its one
  method (lands with O).
- `RunExecutor` (`src/schedule/scheduler.ts`): `gatedRunExecutor(prepare)` wraps
  `runGatedTrial`. The live VM executor plugs in here.
- `Notifier`: `fileNotifier`, `stderrNotifier`, or your own. Notifications carry ids and
  codes only.
- The append-only attempt ledger (#518): scheduled rows can also be mirrored there once it
  lands (lands with #518). Today they go to the MAC-chained ledger only.
