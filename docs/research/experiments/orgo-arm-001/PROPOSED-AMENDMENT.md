# Proposed amendment: Medium gate-probe

**Status: NOT ADOPTED: needs outer-loop approval because the outer loop asked for the smallest machine and said not the 8 GB example, and Medium (2 vCPU, 8 GB, $0.055/h) is the only size this Free account is offered.**

This is a proposal from the independent verifier pass on PR #81. It does not change [PROTOCOL.md](PROTOCOL.md).

## Why
The pre-registered preflight gated: the account is Free, `billing/compute` offers only Medium, and a create naming Small would still get a Medium. Zero compute samples exist. A single, tightly capped Medium probe could still record Orgo's actual responses for the gated operations.

## Proposal
1. On a Free account a single Medium may be created only as a gate-probe for E0, E1, E4 and E5, and to observe the E2 and E3 gates.
2. Probe budget $0.25 total, hard stop at $0.15 observed spend, `ends_in_hours` 1, and a 20 minute deadline enforced in the polling loops.
3. Cleanup deletes every computer present now that was absent at preflight, or in the created-id set, regardless of name. The source is named `myco-discovery-base`.
4. E2 and E3 become N=1 gate observations: record the first response. On 403 `HOURLY_LIMIT` or 409 `HOURLY_QUOTE_REQUIRED` stop that experiment: no purchase, no further attempt.
5. E4 suspend is a single probe expecting 409 `HOURLY_USE_STOP`. E5 keeps `allow()`. Sample counts are N=1 and no p95 is claimed.
6. Medium results are not Small results: report the size obtained, and do not compare latency or price across sizes.
7. The raw preflight JSON stays committed.
