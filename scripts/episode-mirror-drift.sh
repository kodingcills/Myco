#!/usr/bin/env bash
# Reports whether the data-capture PR #542 has moved past the copy of its episode contract
# vendored in test/fixtures/episode-542/ (and mirrored in src/dataset/episode.ts). Read-only:
# fetches #542's branch, compares the four vendored files (import lines and blank lines ignored) and prints
# DRIFT or IN STEP. Exit 0 in step, 1 on drift, 2 if the branch cannot be fetched.
# Usage: scripts/episode-mirror-drift.sh [ref]   (default: #542's branch on origin)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BRANCH="claude/data-capture-episode-schema-8fqvjs"
REF="${1:-origin/$BRANCH}"
if [ "$#" -eq 0 ]; then
  git fetch --quiet origin "$BRANCH" 2>/dev/null || { echo "cannot fetch $BRANCH (merged or offline?)" >&2; exit 2; }
fi
PINNED="$(sed -n 's/^export const EPISODE_MIRROR_PINNED_AT = "\([0-9a-f]\{40\}\)";$/\1/p' src/dataset/episode.ts)"
HEAD_SHA="$(git rev-parse "$REF")"
echo "pinned:  $PINNED"
echo "#542 at: $HEAD_SHA"
status=0
for f in schemas/episode.ts src/episode/validate.ts src/episode/clean.ts src/episode/types.ts; do
  if ! diff -q <(git show "$REF:$f" | grep -v '^import\|^} from \|^$') \
               <(grep -v '^import\|^} from \|^$' "test/fixtures/episode-542/$f") >/dev/null; then
    echo "DRIFT: $f differs from $REF"
    status=1
  fi
done
if [ "$status" -eq 0 ]; then echo "IN STEP: the vendored contract equals $REF"; fi
exit "$status"
