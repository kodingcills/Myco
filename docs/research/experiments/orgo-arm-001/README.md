# Orgo arm 001: rerun guide

Follow [PROTOCOL.md](PROTOCOL.md). Results: [RESULTS.md](RESULTS.md), raw data `raw.json`, per-operation ledger `ledger.jsonl` (append-only, secret-free).

## Spend rules (real money)

- The key lives in `~/.myco/secrets/orgo.env` as `ORGO_API_KEY=...`. The script parses it in-process and never prints, logs or writes it. Do not `source` it and do not pass it as an argument.
- Self budget $1.50, hard stop at $1.20 observed spend, at most two computers live at once, smallest (Small, 0.5 vCPU, 4 GB) Linux only. No top-up, no plan change, no billing portal.
- A read-only preflight runs first. It stops before any create unless the account is not Free and `billing/compute` offers Small. Free accounts are offered a Medium only, so on a credit-only Free account this experiment yields zero compute samples.

## Commands (run from the repo root)

```sh
pnpm exec tsx scripts/orgo/run.ts --dry-run [--scenario free|paid-gated|paid-open] [--charge-cents N]   # fake service, no network, writes to a temp dir
pnpm exec tsx scripts/orgo/run.ts preflight     # live, read-only: balance, workspace, offers, inventory
pnpm exec tsx scripts/orgo/run.ts run           # live: preflight, then E0-E5 only if it passes; cleanup in finally
pnpm exec tsx scripts/orgo/run.ts cleanup       # live: delete only computers named myco-discovery-*, then re-list
```

`--workspace <id>` selects the workspace when more than one is owned (use the one `npx -y orgo@2.5.0 whoami` reports). The watch link is written to `/private/tmp/orgo-setup/watch.txt` outside the repo and is never committed.

Guest-side state (RAM counter, 20 ms heartbeat, tmpfs and disk markers, boot id) is `scripts/orgo/state.py`; it needs only `python3` and coreutils on the Orgo computer.

## Tests

`pnpm test` runs `test/orgo/orgo.test.ts` (mocked HTTP and the in-memory fake: redaction, ledger, spend guard, cleanup selection, statistics, preflight, dry-run flows). No live call runs in CI. Before committing results, grep them: `grep -rnE 'sk_|[A-Za-z0-9+/]{32,}' docs/research/experiments/orgo-arm-001`.
