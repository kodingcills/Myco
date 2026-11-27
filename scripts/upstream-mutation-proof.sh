#!/usr/bin/env bash
# Mutation proof for the public-benchmark grader (#682). Applies each mutant to one guard,
# runs the test file that pins it (with a time limit, so no kill by hang), expects a FAILURE,
# and restores the file. Exits 1 if any mutant survives or any file is left modified.
#
#   bash scripts/upstream-mutation-proof.sh
#
# Runs on the synthetic upstream tree and the committed manifests only (no network, no
# upstream checkout, standard-library Python).
set -uo pipefail
cd "$(dirname "$0")/.."

survived=0
run_mutant() {
  local id="$1" file="$2" from="$3" to="$4" test="$5"
  if ! grep -qF -- "$from" "$file"; then
    echo "$id: PATTERN NOT FOUND in $file"
    survived=1
    return
  fi
  cp "$file" "$file.mutation-backup"
  FROM="$from" TO="$to" npx tsx scripts/replace-once.ts "$file"
  local start=$SECONDS
  if timeout 300 pnpm exec vitest run "$test" >/dev/null 2>&1; then
    echo "$id: SURVIVED ($file)"
    survived=1
  else
    echo "$id: killed in $((SECONDS - start))s by $test"
  fi
  mv "$file.mutation-backup" "$file"
}

E=src/benchmark/upstream/evaluate.ts
D=src/benchmark/upstream/run_upstream_metric.py
I=src/benchmark/upstream/import.ts
P=src/benchmark/upstream/prereg.ts
TI=test/benchmark/upstream-import.test.ts
TM=test/benchmark/upstream-manifest.test.ts
TP=test/benchmark/upstream-prereg.test.ts

run_mutant M1-task-hash "$E" 'if (sha256Hex(raw) !== task.taskFileSha256)' 'if (false)' "$TI"
run_mutant M2-evaluator-hash "$D" 'if actual != digest:' 'if False:' "$TI"
run_mutant M3-pass-threshold "$E" 'out.score === UPSTREAM_PASS_SCORE' 'out.score > 0' "$TI"
run_mutant M4-infeasible-rule "$E" 'return failed' 'return !failed' "$TI"
run_mutant M5-fail-action "$E" 'if (failed) return verdict("fail", 0, ["AGENT_FAIL_ACTION"]);' '' "$TI"
run_mutant M6-conj-and-early-zero "$D" 'if conj == "and" and score == 0.0:' 'if False:' "$TI"
run_mutant M7-unsupported-getter "$E" 'if (!FILE_GETTERS.has(rType))' 'if (false)' "$TI"
run_mutant M8-host-env-leak "$E" 'env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" },' 'env: { ...process.env, HOME: dir },' "$TI"
run_mutant M9-raise-is-ungradable "$D" 'fail("EVALUATOR_RAISED")' 'score = 1.0' "$TI"
run_mutant M10-office-filter "$I" 'if (filtered && !apps.some(isOfficeApp)) continue;' '' "$TI"
run_mutant M11-license-pin "$I" 'throw new ImportError("LICENSE_CHANGED");' 'void 0;' "$TI"
run_mutant M12-asset-license "$I" 'out.push({ role: "config", url: f.url, license: "unclear" });' 'out.push({ role: "config", url: f.url, license: "unclear", fetched: true } as UpstreamAsset);' "$TI"
run_mutant M13-proxy-not-desktop "$I" 'if (task.proxy === true) needs.add("NETWORK_PROXY");' '' "$TI"
run_mutant M14-prereg-pending "$P" 'reasons.push("LEAD_RULING_PENDING");' '' "$TP"
run_mutant M15-prereg-non-live "$P" 'reasons.push("NON_LIVE_ROW");' '' "$TP"
run_mutant M16-prereg-n "$P" 'reasons.push("N_MISMATCH");' '' "$TP"
run_mutant M17-prereg-ungradable-accept "$P" 'r.agentClaimedDone && r.upstreamStatus !== "pass"' 'r.agentClaimedDone && r.upstreamStatus === "fail"' "$TP"
run_mutant M18-prereg-field-pending "$P" 'if (typeof v === "string" && /^PENDING\b/.test(v)) out.push(path);' '' "$TP"
run_mutant M19-placement-report src/benchmark/upstream/placement-report.ts '${cell(t.placement.reasons.join(", "))}' '' "$TM"
run_mutant M20-instruction-drift benchmark/upstream/osworld-office-v1/tasks.jsonl 'I have calculated the total work hours' 'I have calculated the total work hour' "$TM"

if ! git diff --quiet -- src/benchmark/upstream benchmark/upstream; then
  echo "FILES LEFT MODIFIED"
  survived=1
fi
[ "$survived" -eq 0 ] && echo "ALL MUTANTS KILLED" || { echo "SOME MUTANTS SURVIVED"; exit 1; }
