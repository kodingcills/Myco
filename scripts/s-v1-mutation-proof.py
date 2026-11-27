#!/usr/bin/env python3
"""Mutation proofs for track S's s-v1 pre-registration and analysis. Not run in CI.

  python3 scripts/s-v1-mutation-proof.py [label-substring ...]

Run from the repo root. Each mutant breaks one guard in place, then RE-FREEZES
(`npx tsx scripts/s-v1-freeze.ts`), so the freeze test (committed prereg.json == the build) cannot
be what kills it: the behaviour tests must. It then runs `npx vitest run test/schedule/conformance`,
records killed (suite failed) or SURVIVED (suite passed), and restores the file and the three
frozen files (also on Ctrl-C). Exit 0 only when every mutant is killed and every anchor matched
exactly once.

This is separate from scripts/schedule-mutation-proof.py, the 56-mutant proof of src/schedule that
the s-v1 bar's item 6 pre-registers.
"""
import subprocess
import sys

C = "src/schedule/conformance/"
A = C + "analysis.ts"
P = C + "prereg.ts"
K = C + "canonical.ts"
T = C + "trg-v1.ts"
S = "scripts/s-v1-analysis.ts"
FROZEN = [
    "benchmark/schedule/trg-v1/cases.jsonl",
    "benchmark/schedule/trg-v1/manifest.json",
    "docs/product/capability-prereg/s-v1/prereg.json",
]
M = [
    ("bar: one in-scope counterexample fails", A, '  if (inS.some((v) => !v.pass)) reasons.add("IN_SCOPE_CASE_FAILED");\n', ""),
    ("bar: out-of-scope mismatch fails", A, '  if (outS.some((v) => !v.pass)) reasons.add("OUT_OF_SCOPE_MISMATCH");\n', ""),
    ("bypass: policy allow required", A, "    !run.policiesAllowedBeforeStart ||\n", ""),
    ("bypass: gate bound to exactly one trial", A, "run.gateTrialBindings !== 1", "run.gateTrialBindings < 1"),
    ("bypass: budget admitted required", A, "    !run.budgetAdmitted ||\n", ""),
    ("bypass: exactly one ledger row", A, "run.ledgerRowsForRun !== 1", "run.ledgerRowsForRun < 1"),
    ("bypass: out-of-scope exemption only", A, '  if (!c.inScope) f.delete("BYPASS");', '  f.delete("BYPASS");'),
    ("invariant: double runs counted", A, "counts.doubleRuns = o.runs.length - new Set(o.runs.map((x) => x.runId)).size;", "counts.doubleRuns = 0;"),
    ("invariant: runs while paused counted", A, "o.runs.filter((x) => x.startedWhilePaused).length", "0"),
    ("invariant: accepted needs ORACLE_PASS", A, ' && x.reasonCodes.includes("ORACLE_PASS")', ""),
    ("invariant: evidence rows counted", A, "(x) => x.evidence !== false", "() => false"),
    ("invariant: concurrency overrun counted", A, "o.maxConcurrent > o.concurrencyBudget ? 1 : 0", "0"),
    ("invariant: chain failure counted", A, "o.ledgerChainVerifies ? 0 : 1", "0"),
    ("invariant: marker leaks counted", A, "counts.markerLeaks = o.markerLeaks;", "counts.markerLeaks = 0;"),
    ("case: ledger rows compared with codes", A, "`${x.status}|${x.codes.join(\",\")}|${x.accepted}`", "`${x.status}|${x.accepted}`"),
    ("case: responses compared", A, 'if (!sameResponses(o.responses, e.responses)) f.add("RESPONSES");', ""),
    ("case: notifications compared", A, 'if (o.notifications !== e.notifications) f.add("NOTIFICATIONS");', ""),
    ("case: executor calls compared", A, 'if (o.executorCalls !== e.executorCalls) f.add("EXECUTOR_CALLS");', ""),
    ("case: runs consistent with calls", A, 'if (o.runs.length !== o.executorCalls) f.add("RUNS_INCONSISTENT");', ""),
    ("mutation: count must match", A, "mut.rows.length !== frozen.mutantCount", "false"),
    ("mutation: labels unique", A, '  if (new Set(labels).size !== labels.length) reasons.add("MUTANT_LABEL_DUPLICATE");\n', ""),
    ("mutation: only 'killed' is a kill", A, '(x) => x.status !== "killed"', '(x) => x.status === "SURVIVED"'),
    ("mutation: script bound", A, "mut.scriptSha256 === frozen.mutationScriptSha256", "true"),
    ("refuse: evidence claim", A, "res.evidence === false", "true"),
    ("refuse: not simulated", A, "res.simulated === true", "true"),
    ("refuse: other prereg", A, "res.preregSha256 === frozen.preregSha256", "true"),
    ("refuse: other manifest", A, "res.manifestSha256 === frozen.manifestSha256", "true"),
    ("refuse: missing case", A, '  for (const id of ids) refuseUnless(byId.has(id), "MISSING_CASE");\n', ""),
    ("refuse: unknown case", A, '  for (const id of byId.keys()) refuseUnless(ids.has(id), "UNKNOWN_CASE");\n', ""),
    ("refuse: duplicate case", A, '    refuseUnless(!byId.has(cr.caseId), "DUPLICATE_CASE");\n', ""),
    ("prereg: body hash checked", P, '  if (preregSha256(p) !== file.preregSha256) refuse("PREREG_HASH_MISMATCH");\n', ""),
    ("prereg: file SHA-256s checked", P, "if (!ref || actual !== ref.sha256) refuse(code);", "if (!ref) refuse(code);"),
    ("prereg: spec bar checked", P, "if (bar !== p.bar?.text || sha256Hex(bar) !== p.bar.sha256)", "if (false)"),
    ("canonical: keys sorted", K, "const keys = Object.keys(obj).sort();", "const keys = Object.keys(obj);"),
    ("canonical: non-finite refused", K, '      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");\n', ""),
    ("canonical: unsupported refused", K, "      throw new Error(`canonicalJson: unsupported ${typeof value}`);", '      return "null";'),
    ("corpus: denied policy never runs", T, '    expect: (k) => single(k, row("denied", ["POLICY_DENIED", "CONFORMANCE_DENY"]), 0, 1),', '    expect: (k) => single(k, row("denied", ["POLICY_DENIED", "CONFORMANCE_DENY"]), 1, 1),'),
    ("corpus: only verified expected accepted", T, 'expect: (k) => single(k, row("refuted"), 1, 1),', 'expect: (k) => single(k, row("refuted", [], true), 1, 1),'),
    ("corpus: S-live case stated as deferred", T, '    scenario: "vm-lock-held",', '    scenario: "vm-lock-held-later",'),
    ("corpus: out-of-scope cases marked", T, "inScope: s.outOfScopeReason === undefined,", "inScope: true,"),
    ("mutation log: status parsed", P, "rows.push({ label, file, status: status.trim() });", 'rows.push({ label, file, status: "killed" });'),
    # Round 2 (verdict B1, B2, N1, N2, N4 and the surviving V6/V10).
    ("B1: a pending lead ruling keeps 'not shown'", A, '  if (frozen.leadRulingPending.length > 0) reasons.add("LEAD_RULING_PENDING");\n', ""),
    ("B1: analysis requires the frozen pending list", A, 'refuseUnless(isStrArr(frozen.leadRulingPending), "PREREG_SCHEMA");', "void 0;"),
    ("B1: loader requires the pending list", P, '  if (!Array.isArray(pending) || !pending.every((x) => typeof x === "string"))\n    refuse("PREREG_SCHEMA");\n', ""),
    ("B1: loader requires the lead-rulings list", P, '  if (!Array.isArray(p.leadRulings)) refuse("PREREG_SCHEMA");\n', ""),
    ("B2: unknown mutation rows fail", A, '  if (unknown.length > 0) reasons.add("MUTANT_UNKNOWN");\n', ""),
    ("B2: missing frozen mutants fail", A, '  if (missing.length > 0) reasons.add("MUTANT_MISSING");\n', ""),
    ("B2: the file is part of a mutant's identity", A, "`${m.label} | ${m.file}`", "`${m.label}`"),
    ("B2: a mutation row needs its file", A, '          typeof x.file === "string" &&\n', ""),
    ("B2: analysis requires a non-empty frozen mutant set", A, "    Array.isArray(frozen.mutants) &&\n      frozen.mutants.length > 0 &&\n", "    true &&\n"),
    ("B2: loader checks the mutant count against the script", P, '  if (mutants.length !== p.mutationProof.mutants) refuse("MUTANT_COUNT_MISMATCH");\n', ""),
    ("B2: script parse: every tuple line parses", P, "out.length === 0 || out.length !== tuples", "out.length === 0"),
    ("B2: script parse: no tuples refused", P, "out.length === 0 || out.length !== tuples", "out.length !== tuples && false"),
    ("B2: script parse: labels unique", P, '  if (new Set(out.map((x) => x.label)).size !== out.length) refuse("MUTATION_SCRIPT_UNPARSEABLE");\n', ""),
    ("B2: script parse: S prefix required", P, '  if (prefix === undefined) return refuse("MUTATION_SCRIPT_UNPARSEABLE");\n', ""),
    ("B2: script parse: S prefix applied", P, "file: prefix + (m[2] as string)", "file: m[2] as string"),
    ("B2: mutation log: file parsed", P, "rows.push({ label, file, status: status.trim() });", 'rows.push({ label, file: "x", status: status.trim() });'),
    ("N1: startup refusal compared", A, 'if (o.startupRefusal !== e.startupRefusal) f.add("STARTUP_REFUSAL");', ""),
    ("N2: markerLeaks shape checked", A, "    isNat(v.concurrencyBudget) &&\n    isNat(v.markerLeaks);", "    isNat(v.concurrencyBudget);"),
    ("N4: run ids unique across cases", A, "      if (seenRunIds.has(id)) tot.doubleRuns += 1;\n", ""),
    ("V6: manifest hash re-checked", P, 'if (manifestSha256(manifest) !== p.corpus.manifestSha256) refuse("CORPUS_CHANGED");', ""),
    ("V10: cases re-checked against the manifest", P, 'if (sha256Hex(casesText) !== manifest.files["cases.jsonl"]) refuse("CORPUS_CHANGED");', ""),
    ("cli: 'not shown' exits 1", S, 'process.exitCode = report.verdict === "property holds" ? 0 : 1;', "process.exitCode = 0;"),
    ("cli: refusal exits 2", S, "  process.exitCode = 2;", "  process.exitCode = 0;"),
]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


only = sys.argv[1:]
saved = {f: open(f).read() for f in FROZEN}
rows = []
for label, f, old, new in M:
    if only and not any(o in label for o in only):
        continue
    src = open(f).read()
    n = src.count(old)
    if n != 1:
        rows.append((label, f, "BAD-ANCHOR(%d)" % n))
        continue
    open(f, "w").write(src.replace(old, new))
    try:
        fz = run(["npx", "tsx", "scripts/s-v1-freeze.ts"])
        if fz.returncode != 0:
            # A mutant that breaks the freeze itself proves nothing about the tests.
            rows.append((label, f, "FREEZE-FAILED"))
            continue
        r = run(["npx", "vitest", "run", "test/schedule/conformance"])
        rows.append((label, f, "killed" if r.returncode != 0 else "SURVIVED"))
    finally:
        open(f, "w").write(src)
        for p, text in saved.items():
            open(p, "w").write(text)
for r in rows:
    print(" | ".join(r))
bad = [r for r in rows if r[2] != "killed"]
print(f"{len(rows) - len(bad)}/{len(rows)} mutants killed")
sys.exit(1 if bad or not rows else 0)
