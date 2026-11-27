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
mutants=0
run_mutant() {
  # Optional 6th argument: a vitest -t name filter, so a mutant in a pinned fleet file is
  # killed by the behavioural test that names it, not by the file's SHA-256 pin.
  local id="$1" file="$2" from="$3" to="$4" test="$5" name="${6:-}"
  mutants=$((mutants + 1))
  if ! grep -qF -- "$from" "$file"; then
    echo "$id: PATTERN NOT FOUND in $file"
    survived=1
    return
  fi
  cp "$file" "$file.mutation-backup"
  FROM="$from" TO="$to" npx tsx scripts/replace-once.ts "$file"
  local start=$SECONDS
  local filter=()
  [ -n "$name" ] && filter=(-t "$name")
  timeout 120 pnpm exec vitest run "$test" "${filter[@]}" >/dev/null 2>&1
  local status=$?
  if [ "$status" -eq 0 ]; then
    echo "$id: SURVIVED ($file)"
    survived=1
  elif [ "$status" -eq 124 ]; then
    echo "$id: SURVIVED: TIMED OUT, a kill by hang does not count ($file)"
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
run_mutant M16-prereg-n "$P" 'reasons.push(`N_MISMATCH:${arm}`);' '' "$TP"
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
run_mutant K1d-grader-accepts-unpatched-runner "$R" 'const digest = OSWORLD_HARNESS.patchedFiles[rel] ?? upstreamDigest;' 'const digest = upstreamDigest;' "$TR"
run_mutant K1e-analysis-counts-mock-runner-rows "$P" 'if (rows.some((r) => r.graderVersion !== OSWORLD_EVALUATE_GRADER))' 'if (false)' "$TP"
run_mutant K1f-prereg-grader-not-upstream "$J" '"version": "osworld-desktopenv-evaluate@0ad41bee56565efe7bb3c3a5ebc67590a1b8276f"' '"version": "upstream-metric-mock/1"' "$TP"
# K2 an arm with a different action layer passes the identical-layer tests.
run_mutant K2a-self-check-arm-alters-actions "$H" '                codes = self._self_check(instruction)' '                codes = self._self_check(instruction)
                out.append({"action_type": "WAIT"})' "$TH"
run_mutant K2b-gate-arm-rewrites-non-done-action "$H" '                out.append(action)
                continue' '                out.append(dict(action, command="pyautogui.sleep(0)"))
                continue' "$TH"
run_mutant K2c-prereg-arm-layer-unchecked "$P" 'if (a.actionLayer !== "shared")' 'if (false)' "$TP"
run_mutant K2d-prereg-identical-unchecked "$P" 'if (layer.identicalAcrossArms !== true || layer.summary !== ACTION_LAYER_SUMMARY)' 'if (layer.summary !== ACTION_LAYER_SUMMARY)' "$TP"
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
run_mutant K5b-shown-with-shape-problem "$P" '    reasons.push(`PREREG_INVALID:${p}`);' '    void p;' "$TP"
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
run_mutant G10-selection-adds-multi-apps "$I" 'domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress"],' 'domains: ["libreoffice_calc", "libreoffice_writer", "libreoffice_impress", "multi_apps"],' "$TI"

# Round 2 (#741): the retarget to the Myco fleet (14:05Z), its scope (14:37Z), the UTM parity
# reference (15:21Z), and the round-1 verdict's B2, B3, N1, N2, N6 and shared rules.
A=src/benchmark/upstream/parity.ts
F=src/benchmark/upstream/fleet/myco_fleet_provider.py
Q=src/benchmark/upstream/fleet/osworld_parity.py
DF=src/benchmark/upstream/fleet/Dockerfile
SS=src/benchmark/upstream/fleet/start.sh
RQ=src/benchmark/upstream/fleet/requirements-fleet.txt
MS=src/benchmark/upstream/fleet/measure.sh
TF=test/benchmark/osworld-fleet.test.ts
IMG="fleet image definition"
# Each name filter must select passing tests on the unmutated tree (a filter that matched
# nothing would make vitest fail and fake a kill).
for name in "fleet image definition" "measure.sh" "a desktop is ready only when" \
  "the readiness probe is a pyautogui command" "refuses an image not pinned by digest" \
  "starts one digest-pinned container" "refuses and removes a desktop" \
  "refuses the reference run without an approval link" "records a run that raises as ungradable" \
  "refuses a changed task file"; do
  out=$(timeout 300 pnpm exec vitest run "$TF" -t "$name" 2>&1)
  if [ $? -ne 0 ] || ! sed "s/\x1b\[[0-9;]*m//g" <<<"$out" | grep -qE "Tests +[1-9][0-9]* passed"; then
    echo "BASELINE FAILED for filter: $name"
    survived=1
  fi
done
MEAS="measure.sh"
# B2: "shown" with no parity section or a VM provider.
run_mutant B2a-provider-not-fleet-unchecked "$P" 'out.push("HARNESS_PROVIDER_NOT_FLEET");' '' "$TP"
run_mutant B2b-parity-section-unchecked "$P" 'out.push("PARITY_MISSING");' '' "$TP"
run_mutant B2c-parity-sample-hash-unchecked "$P" 'if (parity.sampleSha256 !== paritySampleSha256)' 'if (false)' "$TP"
run_mutant B2d-reference-deviation-unchecked "$P" 'out.push("PARITY_REFERENCE_NOT_RULED");' '' "$TP"
run_mutant B2e-parity-not-required "$P" 'reasons.push("PARITY_NOT_PASSED");' '' "$TP"
run_mutant B2f-parity-forged-passed "$P" 'context.parity.reasons.length > 0 ||' '' "$TP"
run_mutant B2g-image-digest-unchecked "$P" 'reasons.push("IMAGE_DIGEST_NOT_PINNED");' '' "$TP"
run_mutant B2h-prereg-parity-rule-weakened "$J" '"rule": "Parity must pass before any live run. A pre-declared' '"rule": "Parity is advisory. A pre-declared' "$TP"
run_mutant B2i-rulings-uncited "$P" 'out.push("RULINGS_NOT_CITED");' '' "$TP"
run_mutant B2j-action-layer-summary-unchecked "$P" ' || layer.summary !== ACTION_LAYER_SUMMARY' '' "$TP"
# B3: one arm on another provider.
run_mutant B3a-arm-provider-unchecked "$P" 'if (a.provider !== "shared")' 'if (false)' "$TP"
run_mutant B3b-prereg-arm-on-vmware "$J" '"provider": "shared",' '"provider": "vmware",' "$TP"
run_mutant B3c-stamp-provider-unchecked "$R" 'if (stamp.provider !== provider) out.push("HARNESS_PROVIDER_MISMATCH");' '' "$TR"
run_mutant B3d-stamp-image-unchecked "$R" 'out.push("HARNESS_IMAGE_NOT_PINNED");' '' "$TR"
run_mutant B3e-stamp-fleet-files-unchecked "$R" 'else if (got !== digest) out.push(`FLEET_FILE_MODIFIED:${rel}`);' '' "$TR"
# N6 and the shared rules: per-arm coverage, simulated rows, committed pre-registration.
run_mutant N6-coverage-gated-arm-only "$P" 'for (const arm of R1_ARMS) {' 'for (const arm of [GATED_ARM]) {' "$TP"
run_mutant SR1-simulated-only-if-true "$P" 'if (rows.some((r) => r.simulated !== undefined && r.simulated !== false))' 'if (rows.some((r) => r.simulated === true))' "$TP"
run_mutant SR2-uncommitted-prereg-accepted "$P" 'reasons.push("PREREG_NOT_COMMITTED");' '' "$TP"
# N1, N2: the stdio transport fails closed; the runId reaches the gate through wrap_agent.
run_mutant V3-stdio-no-reply-accepts "$H" '        raise GateError("GATE_NO_REPLY")' '        return {"apiVersion": GATE_API_VERSION, "verdict": "verified", "accepted": True, "reasonCodes": ["ORACLE_PASS"]}' "$TH"
run_mutant V4-stdio-non-object-accepts "$H" '                    raise GateError("GATE_REPLY_MALFORMED")' '                    return {"apiVersion": GATE_API_VERSION, "verdict": "verified", "accepted": True, "reasonCodes": ["ORACLE_PASS"]}' "$TH"
run_mutant V5-wrap-agent-run-id-is-task-id "$H" '    return DoneGate(agent, arm, gate=gate, task_id=task_id, run_id=run_id, controller=controller)' '    return DoneGate(agent, arm, gate=gate, task_id=task_id, run_id=task_id, controller=controller)' "$TH"
# B1(a): the image without the a11y stack or pyautogui/python-xlib (behavioural tests only).
run_mutant FA1-image-without-gtk3-plugin "$DF" ' libreoffice-gtk3 python3-uno' ' python3-uno' "$TF" "$IMG"
run_mutant FA2-image-x11-plugin "$DF" '    SAL_USE_VCLPLUGIN=gtk3 \' '    SAL_USE_VCLPLUGIN=x11 \' "$TF" "$IMG"
run_mutant FA3-image-without-pyatspi "$DF" ' python3-pyatspi gir1.2-atspi-2.0' ' gir1.2-atspi-2.0' "$TF" "$IMG"
run_mutant FA4-image-without-pyautogui "$RQ" 'PyAutoGUI==0.9.54 \
    --hash=sha256:dd1d29e8fd118941cb193f74df57e5c6ff8e9253b99c7b04f39cfc69f3ae04b2
' '' "$TF" "$IMG"
run_mutant FA5-image-without-xlib "$RQ" 'python3-xlib==0.15 \
    --hash=sha256:dc4245f3ae4aa5949c1d112ee4723901ade37a96721ba9645f2bfa56e5b383f8
' '' "$TF" "$IMG"
run_mutant FA6-no-at-spi-bus-before-server "$SS" '/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/at-spi-bus.log 2>&1 &' '' "$TF" "$IMG"
run_mutant FA7-server-unverified "$DF" 'RUN cd /osworld && sha256sum -c /server.sha256' 'RUN true' "$TF" "$IMG"
# B1(b): the provider uses a desktop without the a11y tree or pyautogui/xlib, or an unpinned image.
run_mutant FB1-provider-ignores-a11y "$F" '        out.append("A11Y_TREE_UNAVAILABLE")' '        pass' "$TF" "a desktop is ready only when"
run_mutant FB2-provider-ignores-pyautogui "$F" '        out.append("PYAUTOGUI_UNAVAILABLE")' '        pass' "$TF" "a desktop is ready only when"
run_mutant FB3-probe-without-xlib "$F" '"import pyautogui, Xlib.display; Xlib.display.Display(); "' '"import pyautogui; "' "$TF" "the readiness probe is a pyautogui command"
run_mutant FB4-image-tag-accepted "$F" '    if not isinstance(ref, str) or not IMAGE_REF.match(ref):' '    if not isinstance(ref, str):' "$TF" "refuses an image not pinned by digest"
run_mutant FB5-ports-published-publicly "$F" '            args += ["-p", "127.0.0.1::%d" % port]' '            args += ["-p", "%d" % port]' "$TF" "starts one digest-pinned container"
run_mutant FB6-failed-desktop-kept "$F" '            self.stop_emulator(path_to_vm)
            raise' '            raise' "$TF" "refuses and removes a desktop"
# B1(c): the parity harness and assessment.
run_mutant FC1-reference-run-unapproved "$Q" 'if args.env == "reference" and not APPROVAL.match(args.reference_approved or ""):' 'if False:' "$TF" "refuses the reference run without an approval link"
run_mutant FC2-raised-run-scored "$Q" '        return None, "RUN_RAISED"' '        return 0.0, None' "$TF" "records a run that raises as ungradable"
run_mutant FC3-task-file-unchecked "$Q" '    if sha256_file(path) != task["taskFileSha256"]:' '    if False:' "$TF" "refuses a changed task file"
run_mutant FC4-parity-match-on-good-only "$A" 'else if (fleet["known-good"] === "pass" && fleet["known-bad"] === "fail") verdict = "MATCH";' 'else if (fleet["known-good"] === "pass") verdict = "MATCH";' "$TF"
run_mutant FC5-reference-bad-sequence-unchecked "$A" 'else if (reference["known-good"] !== "pass" || reference["known-bad"] !== "fail")' 'else if (reference["known-good"] !== "pass")' "$TF"
run_mutant FC6-parity-counts-mock-records "$A" 'if (r.label !== "LIVE-SCRIPTED")' 'if (false)' "$TF"
run_mutant FC7-parity-simulated-only-if-true "$A" 'if (r.simulated !== undefined && r.simulated !== false)' 'if (r.simulated === true)' "$TF"
run_mutant FC8-parity-stamp-unchecked "$A" 'else if (harnessStampProblems(r.stamp, PARITY_ENVS[env]).length > 0)' 'else if (false)' "$TF"
run_mutant FC9-parity-other-sample "$A" 'if (r.sampleSha256 !== sampleSha256)' 'if (false)' "$TF"
# B1(d): the measurement's host memory guard and host label.
run_mutant FD1-guard-swap-floor "$MS" 'HOST_SWAP_FREE_MIN_MIB=300' 'HOST_SWAP_FREE_MIN_MIB=200' "$TF" "$MEAS"
run_mutant FD2-guard-free-pct-ignored "$MS" 'if [ "$pct" -lt "$HOST_FREE_PCT_MIN" ]' 'if false' "$TF" "$MEAS"
run_mutant FD3-guard-step-2gib "$MS" 'MAX_STEP_ADD_MIB=1024 ' 'MAX_STEP_ADD_MIB=2048 ' "$TF" "$MEAS"
run_mutant FD4-unlabelled-host-measured "$MS" 'if [ -z "${HOST_LABEL:-}" ]; then' 'if false; then' "$TF" "$MEAS"

# Round 2 addendum, N3 (lead ruling 15:26Z): the self-check arm is a structural re-check of the
# end state through the controller. It must never read gold or evaluator output, never get a
# larger budget, and a found problem must turn DONE into a continue.
RULES="the probe's pre-registered rules"
HOME_ONLY="the probe reads only the guest home directory"
if [ "$(uname -s)" = "Linux" ]; then
  for name in "$RULES" "$HOME_ONLY"; do
    out=$(timeout 300 pnpm exec vitest run "$TH" -t "$name" 2>&1)
    if [ $? -ne 0 ] || ! sed "s/\x1b\[[0-9;]*m//g" <<<"$out" | grep -qE "Tests +[1-9][0-9]* passed"; then
      echo "BASELINE FAILED for filter: $name"
      survived=1
    fi
  done
  run_mutant SC1-self-check-reads-gold "$H" '            elapsed = int(self.clock() - self.started) + 1' '            open("cache/%s/%s" % (self.task_id, "report_go" + "ld.xlsx"), "rb").close()
            elapsed = int(self.clock() - self.started) + 1' "$TH"
  run_mutant SC2a-self-check-asks-evaluator "$H" '            elapsed = int(self.clock() - self.started) + 1' '            if getattr(self.agent.env, "evalu" + "ate")() < 1.0:
                return ["NOTHING_SAVED"]
            elapsed = int(self.clock() - self.started) + 1' "$TH"
  run_mutant SC2b-self-check-reads-evaluator-output "$H" '            elapsed = int(self.clock() - self.started) + 1' '            open(self.run_id + "/" + "result" + ".txt").close()
            elapsed = int(self.clock() - self.started) + 1' "$TH"
  run_mutant SC3a-self-check-free-model-turn "$H" '                pending = self_check_feedback_text(codes)' '                pending = self_check_feedback_text(codes)
                if codes:
                    self.feedback(self.agent, pending)
                    return self.agent.predict(instruction, obs, *args, **kwargs)' "$TH"
  run_mutant SC3b-self-check-longer-time-allowance "$H" 'PROBE_SCRIPT_TIMEOUT_S = CHECK_TIMEOUT_S - CONTROLLER_HTTP_MARGIN_S' 'PROBE_SCRIPT_TIMEOUT_S = CHECK_TIMEOUT_S' "$TH"
  run_mutant SC4-problem-does-not-continue "$H" '                accepted = not codes' '                accepted = True' "$TH"
  run_mutant SC5-self-check-fails-open "$H" '            return ["RECHECK_UNAVAILABLE"]
        return assess_probe(result)' '            return []
        return assess_probe(result)' "$TH"
  run_mutant SC6-probe-reads-outside-home "$H" "printf 'SAVED\\t%d\\n' \"\$saved\"" "cat /tmp/osworld/cache/* >/dev/null 2>&1
printf 'SAVED\\t%d\\n' \"\$saved\"" "$TH" "$HOME_ONLY"
  run_mutant SC7-probe-reads-hidden-dirs "$H" "-iname '*.pdf' \\) -not -path '*/.*' -newermt" "-iname '*.pdf' \\) -newermt" "$TH" "$RULES"
  run_mutant SC8-probe-format-rule-off "$H" '*.pdf) [ "$(head -c 5 "$1" 2>/dev/null)" = "%PDF-" ] ;;' '*.pdf) true ;;' "$TH" "$RULES"
  run_mutant SC9-nothing-saved-ignored "$H" '    if int(saved[0]) == 0:' '    if False:' "$TH"
  run_mutant SC10-self-check-other-controller-call "$H" '            result = self.controller().run_bash_script(script, timeout=PROBE_SCRIPT_TIMEOUT_S)' '            self.controller().get_file("/home/user/Desktop/report.xlsx")
            result = self.controller().run_bash_script(script, timeout=PROBE_SCRIPT_TIMEOUT_S)' "$TH"
fi
run_mutant SC11-patch-hands-hook-task-config src/gate-hooks/osworld/run_multienv_claude.gate.patch '+                            controller=lambda: env.controller),' '+                            controller=lambda: (env.controller, example)),' "$TH"
run_mutant SC12-prereg-self-check-unchecked "$P" 'out.push("SELF_CHECK_NOT_RULED");' '' "$TP"
run_mutant SC13-prereg-may-not-read-unchecked "$P" '    !SELF_CHECK_MAY_NOT_READ.every((k) => mayNotRead.some((m) => m.includes(k)))' '    false' "$TP"
run_mutant SC14-prereg-suffix-arm-kept "$J" '"promptSuffix": null,
      "selfCheck"' '"promptSuffix": "Verify first.",
      "selfCheck"' "$TP"
run_mutant SC15-prereg-stale-pending-unchecked "$P" 'out.push("STALE_SELF_CHECK_PENDING");' '' "$TP"
run_mutant SC16-prereg-1526-ruling-not-required "$P" '  "2026-11-27T15:26Z",
] as const;' '] as const;' "$TP"
run_mutant SC17-prereg-prompt-unchecked "$P" 'if (a.promptSuffix !== null)' 'if (false)' "$TP"
run_mutant SC18-static-guard-allows-other-calls "$TX" 'if (m[1] !== "run_bash_script")' 'if (false)' "$TX"
if ! git diff --quiet -- src/benchmark/upstream benchmark/upstream src/gate-hooks src/gate docs/benchmark/upstream test/benchmark; then
  echo "FILES LEFT MODIFIED"
  survived=1
fi
echo "$mutants mutants run"
[ "$survived" -eq 0 ] && echo "ALL MUTANTS KILLED" || { echo "SOME MUTANTS SURVIVED"; exit 1; }
