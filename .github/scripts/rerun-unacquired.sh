#!/usr/bin/env bash
# TIF-256: re-run CI jobs that GitHub cancelled because no hosted runner ever
# picked them up ("The job was not acquired by Runner of type hosted even after
# multiple attempts"). It happens to macos-latest (arm64) jobs when GitHub is
# short of capacity. Such a job ran no step, so a re-run cannot repeat a side
# effect, and it says nothing about the code.
#
# The script re-runs only when ALL of these hold:
#   - every failed or cancelled job in the attempt is a no-runner job: cancelled,
#     runner_id 0, zero steps, and the check run carries the "not acquired"
#     annotation. If any job really failed, nothing is re-run. A real failure
#     needs a new push, and a re-run would hide nothing useful.
#   - for a PR run, no newer CI run exists for the same branch. Re-running a
#     superseded PR run would rejoin the PR's concurrency group and cancel
#     the newer run.
# The caller (ci-runner-retry.yml) caps attempts. The script then calls
# rerun-failed-jobs, which re-runs only the failed and cancelled jobs.
#
# Env: REPO (owner/name), RUN_ID, ATTEMPT. DRY_RUN=1 prints the decision and
# re-runs nothing (use it locally against a past run id). Needs gh with
# actions:write (checks:read for the annotations).
set -euo pipefail

: "${REPO:?}" "${RUN_ID:?}" "${ATTEMPT:?}"
NOT_ACQUIRED='was not acquired by Runner'

run=$(gh api "repos/$REPO/actions/runs/$RUN_ID")
event=$(jq -r .event <<<"$run")
branch=$(jq -r .head_branch <<<"$run")
head_repo=$(jq -r .head_repository.full_name <<<"$run")
workflow_id=$(jq -r .workflow_id <<<"$run")

jobs=$(gh api --paginate "repos/$REPO/actions/runs/$RUN_ID/attempts/$ATTEMPT/jobs?per_page=100" --jq '.jobs[]' | jq -s .)
bad=$(jq -c '[.[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")]' <<<"$jobs")
n_bad=$(jq length <<<"$bad")
if [ "$n_bad" -eq 0 ]; then
  echo "run $RUN_ID attempt $ATTEMPT: no failed or cancelled job; nothing to do"
  exit 0
fi

unacquired=0
while IFS=$'\t' read -r id name conclusion runner steps; do
  if [ "$conclusion" = cancelled ] && [ "$runner" = 0 ] && [ "$steps" = 0 ] &&
    gh api "repos/$REPO/check-runs/$id/annotations" --jq '.[].message' | grep -qF "$NOT_ACQUIRED"; then
    echo "no runner acquired: $name (job $id)"
    unacquired=$((unacquired + 1))
  else
    echo "real $conclusion (runner $runner, $steps steps): $name (job $id); not re-running this run"
    exit 0
  fi
done < <(jq -r '.[] | [.id, .name, .conclusion, .runner_id, (.steps | length)] | @tsv' <<<"$bad")

# Only PR runs share a cancellable concurrency group; each main push has its own
# group, and every main commit's run should finish green, so main skips this check.
newest=null
if [ "$event" = pull_request ]; then
  newest=$(gh api "repos/$REPO/actions/workflows/$workflow_id/runs?branch=$(jq -rn --arg b "$branch" '$b|@uri')&event=$event&per_page=20" \
    --jq "[.workflow_runs[] | select(.head_repository.full_name == \"$head_repo\") | .id] | max")
fi
if [ -n "$newest" ] && [ "$newest" != null ] && [ "$newest" -gt "$RUN_ID" ]; then
  echo "run $RUN_ID is superseded by run $newest on $branch; not re-running"
  exit 0
fi

echo "re-running $unacquired no-runner job(s) of run $RUN_ID (attempt $ATTEMPT -> $((ATTEMPT + 1)))"
if [ "${DRY_RUN:-}" = 1 ]; then
  echo "DRY_RUN=1: skipped POST rerun-failed-jobs"
else
  gh api -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs" --silent
fi
