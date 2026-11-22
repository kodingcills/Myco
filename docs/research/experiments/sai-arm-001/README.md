# Sai arm 001

Read [the protocol](PROTOCOL.md) and [partial results](RESULTS.md) before working on the harness. The ledger and results JSON are records of the earlier Free Explore session.

From the repository root, run the offline plan and focused tests:

```sh
node --import tsx scripts/sai/run.ts --dry-run
pnpm exec vitest run test/sai/harness.test.ts --maxWorkers 1
```

The live runner is inherited and currently requires a local API key. The resumed experiment permits only an existing authenticated integration that keeps credentials out of the runner. Live execution is blocked until that integration is available. The dry run and tests require no credentials and make no network calls.

Use Free Explore only. Preserve existing trials and recheck credits before starting a new one. Stop immediately at a payment, rate-limit or credit gate. Do not answer approval prompts. Capture a link-only approval privately outside the repository, abort the task, and keep the URL out of diagnostics.
