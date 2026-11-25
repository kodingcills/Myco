# Security policy

## Reporting a vulnerability

Report security problems **privately** through GitHub Security Advisories:

<https://github.com/kodingcills/Myco/security/advisories/new>

Do **not** open a public issue, pull request or discussion for a security problem.

**Never paste a secret into a report.** If a key, token or password has leaked, say where you saw
it (file, commit, log line, URL) and describe it, but do not copy the value. Redact it in any log
or screenshot you attach.

Please include what you found, how to reproduce it, and what you think the impact is. We will
acknowledge the report in the advisory thread and keep you updated there.

## Supported versions

Myco has no releases yet. Only the `main` branch is supported, and fixes land there.

| Version | Supported |
|---|---|
| `main` | yes |
| anything else | no |

## In scope

- **Secret handling.** Any way a key or token reaches process environment, argv, logs, traces,
  committed files or CI output; a bypass of the secret-file loader (`src/baseline/secret-file.ts`),
  the pre-commit hook (`.githooks/pre-commit`) or the CI secret scan.
- **The VM lock.** Any way two drivers can control the Windows guest at once, or a lock can be
  taken, released or reported wrongly (`scripts/vm-lock.sh`, `src/integration/vm-lock.ts`).
- **Evidence integrity.** Any way a verdict can be decided from something other than persisted
  application state, a `verified` result can be recorded without being checked, or a committed
  scorecard number can stop matching the artifacts it cites (`scripts/scorecard-check.py`).
- **CI.** Any way a fork pull request can obtain a write token or a repository secret (see
  [docs/ci.md](docs/ci.md)).

## Out of scope

- Problems that need an attacker who already controls the maintainer's machine or the Windows
  guest.
- The third-party software Myco drives (Windows, LibreOffice). Report those upstream.
