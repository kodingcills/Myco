# Orgo arm 001: rerun guide

> **NOT CLEARED FOR LIVE USE.** The Free Medium probe is implemented and tested with the in-memory service. Only the read-only preflight has run live. Any live experiment requires explicit outer-loop approval and `ORGO_LIVE_APPROVED=yes`. The Free probe additionally requires `ORGO_PROBE_APPROVED=yes`.

Follow [PROTOCOL.md](PROTOCOL.md) and its adopted [Medium gate-probe amendment](PROPOSED-AMENDMENT.md). [RESULTS.md](RESULTS.md), `raw.json` and `ledger.jsonl` carry the original preflight evidence.

## Spend rules (real money)

- The key lives in `~/.myco/secrets/orgo.env` as `ORGO_API_KEY=...`. The script parses it in-process and never prints, logs or writes it. Do not `source` it and do not pass it as an argument.
- A read-only preflight selects the Free probe when the tier or mode is Free, the workspace is empty, at least 25¢ of credit is available, and the compute catalog offers exactly Medium (2 vCPU, 8 GB, $0.055/h). Eligible paid accounts retain the Small Linux path.
- The Free probe has a 25¢ budget, 15¢ stop and 5¢ reserve. Create one hourly Linux base with a one-hour end. The fork and clone POSTs are single observations of the running and stopped-source gates. The runner immediately deletes any unexpected copy and ends the experiment run. The paid Small path retains its $1.50 budget, $1.20 stop and two-computer limit.
- The 20-minute run bound applies to polling and spend checks. Cleanup runs after the deadline. The experiment does not call purchase, top-up, billing portal, plan or quote endpoints.

## Cleanup

**Nothing else may be created in the workspace during a probe.** Delta cleanup deletes every computer absent at preflight, including computers created by another actor.

In-run cleanup deletes every computer id this run created, plus every computer present now that was absent at preflight, regardless of name (Orgo auto-names forks `agent-N (fork)`), plus names starting `myco-discovery-`. The standalone `cleanup` command takes its own fresh preflight inventory as the baseline, so on its own it deletes only `myco-discovery-*` names. It then re-lists. The final `computers list` must be empty.

## Commands (run from the repo root)

```sh
pnpm exec tsx scripts/orgo/run.ts --dry-run [--scenario free|free-quote|free-fork-open|free-clone-open|paid-gated|paid-open] [--charge-cents N] [--deadline-ms N] [--fail-mid-e2]   # fake service, no network, writes to a temp dir
pnpm exec tsx scripts/orgo/run.ts preflight     # live, read-only: balance, workspace, offers, inventory
pnpm exec tsx scripts/orgo/run.ts run           # live: preflight, then E0-E5 only if preflight passes and the required approval switches are set; cleanup in finally
pnpm exec tsx scripts/orgo/run.ts cleanup       # live: delete per the cleanup rules above, then re-list
pnpm exec tsx scripts/orgo/run.ts render        # no network, no key: rebuild RESULTS.md from raw.json
```

The simulation options `--scenario`, `--charge-cents`, `--deadline-ms` and `--fail-mid-e2` require `--dry-run`. Unknown options, unknown commands and an unknown or missing `--scenario` value are rejected. `--workspace <id>` selects the workspace when more than one is owned (use the one `npx -y orgo@2.5.0 whoami` reports). The watch link is written to `/private/tmp/orgo-setup/watch.txt` outside the repo and is never committed.

Billing history is read over REST from `/api/credits/transactions` (what the Orgo CLI calls; not in the public OpenAPI file, so best effort and null on any failure). No package is downloaded at run time.

Guest-side state (RAM counter, 20 ms heartbeat, tmpfs and disk markers, boot id) is `scripts/orgo/state.py`; it needs only `python3` and coreutils on the Orgo computer.

## Tests

`pnpm test` runs `test/orgo/orgo.test.ts` (mocked HTTP and the in-memory fake: redaction, ledger, spend guard, cleanup scope, statistics, preflight, run bound, strict arguments, dry-run flows including a mid-E2 crash). No live call runs in CI. Before committing results, grep them: `grep -rnE 'sk_|[A-Za-z0-9+/]{32,}' docs/research/experiments/orgo-arm-001`.
