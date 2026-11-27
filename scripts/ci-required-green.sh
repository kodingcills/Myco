#!/usr/bin/env bash
# R1 pilot launch gate (CI speed, #678): exit 0 only when the five REQUIRED checks of
# <sha>'s CI run from a push to main all succeeded; non-required jobs are ignored.
#
#   scripts/ci-required-green.sh <40-hex sha> [--repo owner/name]
#
# Exit codes: 0 green, 1 not green, 2 usage, 3 lookup failed. Needs `gh` logged in (read
# only). Logic and tests: scripts/ci-required-green.ts, test/ci-required-green.test.ts.
# Runbook: docs/benchmark/pilot-runbook.md, "Launch gate".
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
exec node --import tsx scripts/ci-required-green.ts "$@"
