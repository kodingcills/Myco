# Scheduled and triggered runs: security model (track S)

The scheduler turns outside events into agent runs. That is a new way in, so this page says
what each trigger can and cannot do, where the secrets are, and what fails closed. The
binding gate guarantees are unchanged; [README.md](README.md) describes the feature.

## Trust boundaries

| Party | Can | Cannot |
|---|---|---|
| Operator (owns the schedule file, `stateDir`, secrets files) | Choose tasks, triggers, budgets, policies; pause/kill; read the ledger | — |
| A trigger (cron slot, inbox file, webhook sender, manual request) | Say "schedule X fired", with an idempotency key | Choose a task, a run id, a claim, a fixture, an expected value, a verdict or any oracle input. Inbox file contents and webhook bodies are never read by the run. The executor sees only the inbox file's name and SHA-256. |
| The agent (inside the run) | Call `myco.gate/v1` with taskId, runId and claim, as in any run | Anything new. The scheduler adds no agent-facing input. |

**The gate is unchanged.** Scheduled runs go through `runGatedTrial`: the gate is bound to
one trial, the persisted bytes are captured per trial after the agent stops, and agent-facing
reasons carry codes only. Grader independence is unaffected: `src/benchmark/grade` shares no
code with the gate or the scheduler. Calc stays CSV-only. R1 evidence rules are untouched,
because scheduled rows are never evidence (`evidence: false`, `simulated` unless the executor
explicitly says otherwise).

## Secrets

- **No secrets in schedule files.** The file names a secrets file by absolute path and the
  variable in it by name (`secretsFile`/`secretName`, `keyFile`/`keyName`). The strict
  parser has no field that can hold a secret value. On top of that, every string (and
  every key) is screened for key-shaped text: vendor prefixes, PEM blocks, and long
  letter-and-digit tokens. A match refuses the file, and the error names the JSON path,
  never the value.
- **Point of use.** The webhook secret is read from its file per request by
  `readSecretFromFile` (src/baseline/secret-file.ts) and held in a local variable. The
  ledger key is read once at service start into memory. Neither goes into the environment,
  argv, a log, a row, a notification, an HTTP response or an error message. Errors name the
  file and the variable, never the contents.
- **Trigger keys are hashed.** Claims and ledger rows store a SHA-256 of the trigger key, not
  the raw delivery id or file name.
- **Planted-marker tests** put a marker in the secrets file and in the schedule file, then
  check that it appears in no response, row, claim, notification, diagnostic, CLI output or
  file under `stateDir` (`test/schedule/webhook.test.ts`, `e2e.test.ts`,
  `cron-config.test.ts`, `cli.test.ts`, `service.test.ts`).
- Diagnostics are codes (`errorCode()`: an errno code or class name), never error messages,
  which can carry host paths.

## The webhook

- **Loopback only.** It binds `127.0.0.1` or `::1`. Any other host is refused at start, and
  there is no flag to widen it. Exposing it beyond the machine needs an operator-run reverse
  proxy, which is out of scope and not recommended.
- **HMAC-SHA256** over `myco.schedule.webhook/v1\n<scheduleId>\n<deliveryId>\n<body>`,
  compared in constant time. Because the schedule id and the delivery id are inside the MAC, a
  captured request cannot be aimed at another schedule or replayed under a new delivery id.
  A replay under the same delivery id is a `DUPLICATE` (409) and runs nothing. A signed
  request that was refused without a claim (423 `PAUSED`, 429 `BUDGET_CONCURRENCY`) is meant
  to be retried, so it stays replayable until it runs; the MAC carries no timestamp.
- **Delivery-id format.** A delivery id outside 1 to 128 characters of `[A-Za-z0-9._-]` is
  refused 401 `BAD_SIGNATURE` even when the signature over it is correct.
- **One refusal code.** A missing header, a malformed header and a wrong signature all return
  401 `BAD_SIGNATURE`.
- **Fail closed on the secret.** A missing or unreadable secrets file returns 503
  `SECRET_UNAVAILABLE` for every request. It never disables the check.
- **Limits.** The body is capped at 64 KiB (413), only POST is accepted (405), and unknown
  paths return 404. A DNS-rebinding page in a browser can reach 127.0.0.1, but it cannot sign
  a request without the secret.
- Unauthenticated requests write no ledger row (a diagnostic code only), so they cannot fill
  the ledger.

## The inbox

The inbox scan never follows a symlink: it uses `lstat`, and anything that is not a regular
file is skipped. It also ignores dotfiles (partial copies) and sub-directories, and does not
hash files over 64 MiB. Files are not moved or deleted. Each event is keyed by name plus
content digest, so re-delivering the same name with new content is a new event, and the same
file seen on every tick is not.

## State and fail-closed behaviour

`stateDir` is created with mode 0700, and the claims, cursor and pause files with 0600.

| Failure | Outcome |
|---|---|
| Claim cannot be written | The trigger does not run (`STATE_WRITE_FAILED`). |
| `claims.jsonl` or `cursor.json` corrupt | The service refuses to start. |
| `<stateDir>/LOCK` held (another service, or one that crashed) | The service refuses to start. |
| Ledger row cannot be written | The run is reported `error` / `LEDGER_FAILED`, never verified, and notified. |
| Policy throws or is malformed | Denied. |
| Executor throws, times out, is killed, or returns a malformed, inconsistent or other-run result | Not verified. A timed-out or killed run keeps its concurrency slot until the executor settles. |
| Notifier throws | Diagnostic only; the record is unchanged. |
| Zero policies configured | The scheduler refuses to construct; `serve` needs `--allow-task`. |

Every guard above has a mutation proof (`python3 scripts/schedule-mutation-proof.py`): break
the guard, and `test/schedule` fails.

## Out of scope here

No VM, no model, no network beyond loopback, no accounts, billing or hosting. A live executor
that drives an agent on the Windows VM is a separate task under the VM lock.
