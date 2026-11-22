# Orgo arm 001 results

> **NOT CLEARED FOR LIVE USE.** The runner has not been approved for a live compute pass. Live experiments require `ORGO_LIVE_APPROVED=yes`. A Free probe also requires `ORGO_PROBE_APPROVED=yes`. The committed evidence is from the read-only preflight.

Generated 2026-11-22T04:46:49.846Z (live). Authoritative tables below; raw data in `raw.json`, per-operation ledger in `ledger.jsonl`.

## Preflight (read-only, before any compute call)

| Field | Value |
| --- | --- |
| Plan tier | free |
| Compute mode | free |
| Credit balance | $3.00 |
| Computers in workspace | 0 |
| Offers | Medium (2 vCPU, 8 GB, 40 GB disk, $0.055/h) |
| Eligibility check | Small protocol: gated |
| Size obtained | No computer created |

p95 is omitted for N=1.

**Gate: precondition failed. No compute call was made, so E0-E5 have zero samples.**

- Free account: Orgo runs hourly computers as Medium only and a create naming another size still gets a Medium (docs: create, account-limits, instance-types)
- billing/compute offers no Small (0.5 vCPU, 4 GB): Medium 2 vCPU 8 GB

- E0 create: not run (precondition gate; documented semantics only, see PROTOCOL.md)
- E1 plant: not run (precondition gate; documented semantics only, see PROTOCOL.md)
- E2 fork: not run (precondition gate; documented semantics only, see PROTOCOL.md)
- E3 clone: not run (precondition gate; documented semantics only, see PROTOCOL.md)
- E4 stop/start/suspend: not run (precondition gate; documented semantics only, see PROTOCOL.md)
- E5 stopped fork: not run (precondition gate; documented semantics only, see PROTOCOL.md)

## Documented, not tested (docs.orgo.ai; static text, no live outcome)

| Operation | Documented behaviour | Live result |
| --- | --- | --- |
| Free-account create | Free runs hourly Medium only, a create naming another size still gets a Medium (create, account-limits, instance-types) | Offer list above agrees: Medium only |
| Free-account computer count | One computer on starting credit alone, 403 HOURLY_LIMIT beyond it; the count is checked on create, clone and fork | not tested: a fork or clone would need a second computer |
| Fork | Running Linux source, live memory copied, source pauses about 2 s, new UUID and instance_id, auto-stop forced always-on; 409 HOURLY_QUOTE_REQUIRED when the source is hourly ('a copy needs its own purchase'); the fork page lists no quote or confirm parameter | not tested |
| Clone | Disk only, starts from a fresh boot; 400 NOT_CLONABLE for a stopped (frozen) source; 409 HOURLY_QUOTE_REQUIRED for an hourly source | not tested |
| Suspend / resume | Plan-only memory save; an hourly computer answers 409 HOURLY_USE_STOP | not tested |
| Stop / start | Disk archived, RAM and processes lost; stopped hourly computers bill disk only | not tested |
| Fork of a stopped source | 409 computer_asleep or 409 NOT_FORKABLE (400 NOT_FORKABLE if never provisioned; Windows and older VM types are 409 NOT_FORKABLE) | not tested; Windows is documented only |

Account note: the billing history shows a $3.00 initial grant for the free tier, not the $5 that the account-limits page documents for a person. No credit was added and no plan was bought.

## E6 spend and reconciliation

| Item | Value |
| --- | --- |
| Start balance | $3.00 |
| End balance | $3.00 |
| Ledger spend | $0.00 |
| Computers after cleanup | 0 (deleted this run: 0) |

Billing history (amounts only):

```json
[
  {
    "amount_cents": 300,
    "balance_after_cents": 300,
    "type": "initial_grant",
    "created_at": "2026-11-22T04:29:23.532Z"
  }
]
```


## Not measured

- Plan-only features (plan-funded suspend/resume, plan-funded forks), other sizes, other operating systems (Windows is documented, not tested), scale, and any account that is not credit-only Free.
- Orgo returns action delivery, not outcome proofs: this experiment makes no verification claim, and no attempt-to-verified result is measured.
