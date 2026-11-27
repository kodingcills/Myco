#!/usr/bin/env bash
# Mutation proof for the public-benchmark import, R1 grader path, pre-registration and DONE
# gate hook (#682; lead harness ruling 2026-11-27 ~13:55Z). Applies each mutant to one guard,
# runs the test file that pins it (with a time limit, so no kill by hang), expects a FAILURE,
# and restores the file. Exits 1 if any mutant survives or any file is left modified.
#
#   bash scripts/upstream-mutation-proof.sh
#
# Runs on the synthetic upstream tree, the committed manifests and scripted fakes only (no
# network, no upstream checkout, no VM, standard-library Python).
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
R=src/benchmark/upstream/r1-grade.ts
H=src/gate-hooks/osworld/myco_done_gate.py
J=docs/benchmark/upstream/r1-public-prereg.json
TR=test/benchmark/upstream-r1-grade.test.ts
TH=test/benchmark/osworld-gate-hook.test.ts
TX=test/benchmark/independence.test.ts

run_mutant M1-task-hash "$E" 'if (sha256Hex(raw) !== task.taskFileSha256)' 'if (false)' "$TI"
run_mutant M2-evaluator-hash "$D" 'if actual != digest:' 'if False:' "$TI"
run_mutant M3-pass-threshold "$E" 'out.score === UPSTREAM_PASS_SCORE' 'out.score > 0' "$TI"
run_mutant M4-infeasible-rule "$E" 'return failed' 'return !failed' "$TI"
run_mutant M5-fail-action "$E" 'if (failed) return verdict("fail", 0, ["AGENT_FAIL_ACTION"]);' '' "$TI"
run_mutant M6-conj-and-early-zero "$D" 'if conj == "and" and score == 0.0:' 'if False:' "$TI"
run_mutant M7-unsupported-getter "$E" 'if (!FILE_GETTERS.has(rType))' 'if (false)' "$TI"
run_mutant M8-host-env-leak "$E" 'env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" },' 'env: { ...process.env, HOME: dir },' "$TI"
run_mutant M9-raise-is-ungradable "$D" 'fail("EVALUATOR_RAISED")' 'score = 1.0' "$TI"
run_mutant M10-exclusion-unlisted "$I" 'throw new ImportError(`EXCLUSION_NOT_LISTED ${id}`);' 'void 0;' "$TI"
run_mutant M11-license-pin "$I" 'throw new ImportError("LICENSE_CHANGED");' 'void 0;' "$TI"
run_mutant M12-asset-license "$I" 'out.push({ role: "config", url: f.url, license: "unclear" });' 'out.push({ role: "config", url: f.url, license: "unclear", fetched: true } as UpstreamAsset);' "$TI"
run_mutant M13-proxy-not-desktop "$I" 'if (task.proxy === true) needs.add("NETWORK_PROXY");' '' "$TI"
run_mutant M14-prereg-pending "$P" 'reasons.push("LEAD_RULING_PENDING");' '' "$TP"
run_mutant M15-prereg-non-live "$P" 'reasons.push("NON_LIVE_ROW");' '' "$TP"
run_mutant M16-prereg-n "$P" 'reasons.push("N_MISMATCH");' '' "$TP"
run_mutant M17-prereg-ungradable-accept "$P" 'r.agentClaimedDone && r.upstreamStatus !== "pass"' 'r.agentClaimedDone && r.upstreamStatus === "fail"' "$TP"
run_mutant M18-prereg-field-pending "$P" 'if (typeof v === "string" && /^PENDING\b/.test(v)) out.push(path);' '' "$TP"
run_mutant M19-requirements-report src/benchmark/upstream/requirements-report.ts '${cell(r.needs.join(", "))}' '' "$TM"
run_mutant M20-instruction-drift benchmark/upstream/osworld-office-v1/tasks.jsonl 'I have calculated the total work hours' 'I have calculated the total work hour' "$TM"

# Lead harness ruling (13:55Z): key claims.
# K1 the R1 grader path bypasses the upstream evaluate path (pass without upstream's score,
#    grade through the MOCK metric runner, accept an unpinned harness, or count MOCK-runner rows).
run_mutant K1a-grader-ignores-upstream-score "$R" 'return score === R1_PASS_SCORE' 'return true' "$TR"
run_mutant K1b-grader-uses-mock-metric-runner "$R" 'import { sha256Hex } from "./import.ts";' 'import { sha256Hex } from "./import.ts";
import { gradeUpstreamTask } from "./evaluate.ts";
void gradeUpstreamTask;' "$TR"
run_mutant K1c-grader-accepts-unpinned-harness "$R" 'if (harness.length > 0)' 'if (false)' "$TR"
run_mutant K1d-grader-accepts-unpatched-runner "$R" '        ? OSWORLD_HARNESS.patchedAgentRunnerSha256' '        ? upstreamDigest' "$TR"
run_mutant K1e-analysis-counts-mock-runner-rows "$P" 'if (rows.some((r) => r.graderVersion !== OSWORLD_EVALUATE_GRADER))' 'if (false)' "$TP"
run_mutant K1f-prereg-grader-not-upstream "$J" '"version": "osworld-desktopenv-evaluate@0ad41bee56565efe7bb3c3a5ebc67590a1b8276f"' '"version": "upstream-metric-mock/1"' "$TP"
# K2 an arm with a different action layer passes the identical-layer tests.
run_mutant K2a-self-check-arm-alters-actions "$H" '            return response, actions' '            return response, (actions + [{"action_type": "WAIT"}]) if self.arm == "self-check" else actions' "$TH"
run_mutant K2b-gate-arm-rewrites-non-done-action "$H" '                out.append(action)
                continue' '                out.append(dict(action, command="pyautogui.sleep(0)"))
                continue' "$TH"
run_mutant K2c-prereg-arm-layer-unchecked "$P" 'if (a.actionLayer !== "shared")' 'if (false)' "$TP"
run_mutant K2d-prereg-identical-unchecked "$P" 'if (layer.identicalAcrossArms !== true)' 'if (false)' "$TP"
run_mutant K2e-prereg-arm-layer-differs "$J" '"actionLayer": "shared"' '"actionLayer": "hcu+shell"' "$TP"
# K3 the gate side imports the upstream evaluator (or the reverse).
run_mutant K3a-hook-imports-evaluator "$H" 'import json
' 'import json
from desktop_env.evaluators import metrics
' "$TX"
run_mutant K3b-gate-reads-result-txt src/gate/api.ts 'export const GATE_API_VERSION = "myco.gate/v1";' 'export const GATE_API_VERSION = "myco.gate/v1";
export const SCORE_FILE = "result.txt";' "$TX"
run_mutant K3c-upstream-names-hook "$R" 'export const R1_PASS_SCORE = 1.0;' 'export const R1_PASS_SCORE = 1.0;
export const HOOK = "myco_done_gate";' "$TX"
# K4 the WAA phase-2 entry removed.
run_mutant K4a-waa-phase2-removed-json "$J" '"WAA office subset (64 tasks @ eb220c4dcf64) via WAA'"'"'s own Windows 11 image, in-VM server, evaluators and runner: deferred, not dropped."' '' "$TP"
run_mutant K4b-waa-phase2-unchecked "$P" 'if (!phase2.includes(WAA_PHASE2_ENTRY))' 'if (false)' "$TP"
# K5 "shown" while anything is pending.
run_mutant K5a-shown-on-draft "$P" 'if (prereg.status !== "frozen") reasons.push("PREREG_NOT_FROZEN");' '' "$TP"
run_mutant K5b-shown-with-shape-problem "$P" 'for (const p of preregProblems(prereg, subsetTaskIds.size)) reasons.push(`PREREG_INVALID:${p}`);' '' "$TP"
# Gate hook guarantees: taskId/runId/claim only, codes-only replies, fail closed, bypass by config.
run_mutant G1-request-extra-field "$H" 'return {"taskId": task_id, "runId": run_id, "claim": text[:CLAIM_LIMIT]}' 'return {"taskId": task_id, "runId": run_id, "claim": text[:CLAIM_LIMIT], "apiVersion": GATE_API_VERSION}' "$TH"
run_mutant G2-feedback-leaks-prose "$H" '    return accepted, verdict, list(codes)' '    return accepted, verdict, list(codes) + [str(r) for r in reply.get("reasons", [])]' "$TH"
run_mutant G3-fail-open-on-gate-error "$H" '            return False, "uncertain", ["GATE_UNAVAILABLE"]' '            return True, "verified", ["GATE_UNAVAILABLE"]' "$TH"
run_mutant G4-accept-without-accepted-flag "$H" 'accepted = verdict == "verified" and reply.get("accepted") is True' 'accepted = verdict == "verified"' "$TH"
run_mutant G5-accept-ignores-api-version "$H" '    if reply.get("apiVersion") != GATE_API_VERSION:' '    if False:' "$TH"
run_mutant G6-no-gate-arm-accepts-gate "$H" '        elif gate is not None:' '        elif False:' "$TH"
run_mutant G7-refused-done-dropped-not-wait "$H" '                out.append({"action_type": "WAIT"} if isinstance(action, dict) else "WAIT")' '                pass' "$TH"
run_mutant G8-batch-continues-after-refusal "$H" '            break
        return response, out' '        return response, out' "$TH"
run_mutant G9-self-check-suffix-missing "$H" '                agent.system_prompt_suffix = (existing + " " + SELF_CHECK_SUFFIX).strip()' '                pass' "$TH"
run_mutant G10-selection-adds-multi-apps "$I" 'domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress"],' 'domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress", "multi_apps"],' "$TI"

if ! git diff --quiet -- src/benchmark/upstream benchmark/upstream src/gate-hooks src/gate docs/benchmark/upstream; then
  echo "FILES LEFT MODIFIED"
  survived=1
fi
[ "$survived" -eq 0 ] && echo "ALL MUTANTS KILLED" || { echo "SOME MUTANTS SURVIVED"; exit 1; }
