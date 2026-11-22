# Orgo arm 001: rerun guide

> **NOT CLEARED FOR LIVE USE.** The runner has not been approved for a live compute pass. Only the read-only preflight has run live. Live `run` refuses to start experiments unless `ORGO_LIVE_APPROVED=yes`, which needs explicit outer-loop approval after an independent re-verification.

Follow [PROTOCOL.md](PROTOCOL.md). A proposed Medium gate-probe amendment is in [PROPOSED-AMENDMENT.md](PROPOSED-AMENDMENT.md) (see its status line). Results: [RESULTS.md](RESULTS.md), raw data `raw.json`, per-operation ledger `ledger.jsonl` (append-only, secret-free).

## Spend rules (real money)

- The key lives in `~/.myco/secrets/orgo.env` as `ORGO_API_KEY=...`. The script parses it in-process and never prints, logs or writes it. Do not `source` it and do not pass it as an argument.
- Self budget $1.50, hard stop at $1.20 observed spend, at most two computers live at once, smallest (Small, 0.5 vCPU, 4 GB) Linux only, unless an adopted amendment says otherwise. No top-up, no plan change, no billing portal.
- A read-only preflight runs first. It stops before any create unless the account is not Free and `billing/compute` offers Small. Free accounts are offered a Medium only, so on a credit-only Free account this experiment yields zero compute samples.
- A real 30 minute run bound is enforced: the polling loops and every allocation check it and abort with an error, after which cleanup still runs.

## Cleanup

In-run cleanup deletes every computer id this run created, plus every computer present now that was absent at preflight, regardless of name (Orgo auto-names forks `agent-N (fork)`), plus names starting `myco-discovery-`. The standalone `cleanup` command takes its own fresh preflight inventory as the baseline, so on its own it deletes only `myco-discovery-*` names. It then re-lists. The final `computers list` must be empty.

## Commands (run from the repo root)

```sh
pnpm exec tsx scripts/orgo/run.ts --dry-run [--scenario free|paid-gated|paid-open] [--charge-cents N] [--deadline-ms N] [--fail-mid-e2]   # fake service, no network, writes to a temp dir
pnpm exec tsx scripts/orgo/run.ts preflight     # live, read-only: balance, workspace, offers, inventory
pnpm exec tsx scripts/orgo/run.ts run           # live: preflight, then E0-E5 only if it passes AND ORGO_LIVE_APPROVED=yes; cleanup in finally
pnpm exec tsx scripts/orgo/run.ts cleanup       # live: delete per the cleanup rules above, then re-list
pnpm exec tsx scripts/orgo/run.ts render        # no network, no key: rebuild RESULTS.md from raw.json
```

Unknown options, unknown commands and an unknown or missing `--scenario` value are rejected. `--workspace <id>` selects the workspace when more than one is owned (use the one `npx -y orgo@2.5.0 whoami` reports). The watch link is written to `/private/tmp/orgo-setup/watch.txt` outside the repo and is never committed.

Billing history is read over REST from `/api/credits/transactions` (what the Orgo CLI calls; not in the public OpenAPI file, so best effort and null on any failure). No package is downloaded at run time.

Guest-side state (RAM counter, 20 ms heartbeat, tmpfs and disk markers, boot id) is `scripts/orgo/state.py`; it needs only `python3` and coreutils on the Orgo computer.

## Tests

`pnpm test` runs `test/orgo/orgo.test.ts` (mocked HTTP and the in-memory fake: redaction, ledger, spend guard, cleanup scope, statistics, preflight, run bound, strict arguments, dry-run flows including a mid-E2 crash). No live call runs in CI. Before committing results, grep them: `grep -rnE 'sk_|[A-Za-z0-9+/]{32,}' docs/research/experiments/orgo-arm-001`.
