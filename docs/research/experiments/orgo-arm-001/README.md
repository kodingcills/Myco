# Orgo arm 001: rerun guide

> **NOT CLEARED FOR LIVE USE.** The Free Medium probe is implemented and tested with the in-memory service. Only the read-only preflight has run live. Any live experiment requires explicit outer-loop approval and `ORGO_LIVE_APPROVED=yes`. The Free probe additionally requires `ORGO_PROBE_APPROVED=yes` and is blocked before allocation pending a verified 25¢ billing bound.

Follow [PROTOCOL.md](PROTOCOL.md) and its adopted [Medium gate-probe amendment](PROPOSED-AMENDMENT.md). [RESULTS.md](RESULTS.md), `raw.json` and `ledger.jsonl` carry the original preflight evidence.

## Spend rules (real money)

- The key lives in `~/.myco/secrets/orgo.env` as `ORGO_API_KEY=...`. The script parses it in-process and never prints, logs or writes it. Do not `source` it and do not pass it as an argument.
- A read-only preflight selects the Free probe when the tier or mode is Free, the workspace is empty, at least 25¢ of credit is available, and the compute catalog offers exactly Medium (2 vCPU, 8 GB, $0.055/h). Eligible paid accounts retain the Small Linux path.
- The Free probe has a 25¢ cap, a 15¢ observed-balance stop and a 5¢ reserve. The fake exercises one hourly Linux base with a requested one-hour end and requires confirmation of 2 vCPU and 8 GB from create or computer detail before continuing. The fork and clone POSTs are single observations of the running and stopped-source gates. The runner immediately deletes any unexpected copy and ends the experiment run. The paid Small path retains its $1.50 budget, $1.20 stop and two-computer limit.
- Orgo documents hourly rates, prepayment for a computer with an end, and cases where create succeeds without saving that end. The public billing and lifecycle docs do not establish a 25¢ provider ceiling or a worst-case bound for the whole probe, including delayed charges, failed requests and unexpected allocations. The 15¢ stop reacts to observed balance changes. Both approval switches still leave the Free experiment blocked. [Billing](https://docs.orgo.ai/guides/billing) · [End times](https://docs.orgo.ai/guides/computer-ends) · [Clone](https://docs.orgo.ai/api-reference/computers/clone)
- The 20-minute experiment deadline covers preflight, HTTP transfers, polling and balance waits. Cleanup and reconciliation get a separate 60-second budget with a five-second maximum per HTTP request. The experiment does not call purchase, top-up, billing portal, plan or quote endpoints.

## Cleanup

**Use an exclusive workspace from preflight through all recovery sweeps.** Delta cleanup deletes every computer absent at preflight, including computers created by another actor. Run one command at a time against the workspace and journal.

Use a fresh `--out` directory for each run. Before the first allocation, the runner creates a private, Git-ignored `recovery.local.json` there with the original inventory, workspace and run mode. It records computer IDs from successful allocation responses and later inventory discoveries. Keep the journal even if cleanup sees zero computers, since a timed-out allocation can appear after the last read. The journal contains full resource IDs and belongs with local recovery state.

Cleanup uses the original baseline and recorded IDs. It makes up to four delete-and-relist passes, rechecking inventory even after an empty read. If a transfer fails, the deadline expires, or a computer appears after the final sweep, rerun `cleanup --out <same-dir>` while the workspace is still exclusive. Use the same mode and workspace. Standalone cleanup requires the journal, so it can recover auto-named forks without treating them as part of a fresh baseline. The original run report is preserved.

## Commands (run from the repo root)

```sh
pnpm exec tsx scripts/orgo/run.ts --dry-run [--scenario free|free-quote|free-fork-open|free-clone-open|paid-gated|paid-open] [--charge-cents N] [--deadline-ms N] [--fail-mid-e2]   # fake service, no network, writes to a temp dir
pnpm exec tsx scripts/orgo/run.ts preflight     # live, read-only: balance, workspace, offers, inventory
pnpm exec tsx scripts/orgo/run.ts run --out <fresh-dir>       # Free is blocked before allocation pending a verified 25¢ bound
pnpm exec tsx scripts/orgo/run.ts cleanup --out <same-dir>     # recover from the original run journal
pnpm exec tsx scripts/orgo/run.ts render        # no network, no key: rebuild RESULTS.md from raw.json
```

The simulation options `--scenario`, `--charge-cents`, `--deadline-ms` and `--fail-mid-e2` require `--dry-run`. Unknown options, unknown commands and an unknown or missing `--scenario` value are rejected. `--workspace <id>` selects the workspace when more than one is owned (use the one `npx -y orgo@2.5.0 whoami` reports). The watch link is written to `/private/tmp/orgo-setup/watch.txt` outside the repo and is never committed.

Billing history is read over REST from `/api/credits/transactions` (what the Orgo CLI calls; not in the public OpenAPI file, so best effort and null on any failure). No package is downloaded at run time.

Guest-side state (RAM counter, 20 ms heartbeat, tmpfs and disk markers, boot id) is `scripts/orgo/state.py`; it needs only `python3` and coreutils on the Orgo computer.

## Tests

`pnpm test` runs `test/orgo/orgo.test.ts` (mocked HTTP and the in-memory fake: redaction, ledger, spend guard, cleanup scope, statistics, preflight, run bound, strict arguments, dry-run flows including a mid-E2 crash). No live call runs in CI. Before committing results, grep them: `grep -rnE 'sk_|[A-Za-z0-9+/]{32,}' docs/research/experiments/orgo-arm-001`.
