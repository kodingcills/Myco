/**
 * docs/product/demo-replay-and-verify-any-agent.md pre-registers the acceptance criteria for
 * replay/share in `myco watch` (TIF-265) and verify-any-agent (TIF-270). These tests pin the
 * parts that must not drift silently:
 *  - every criterion id is unique, numbered without gaps, and has exactly one Probe and one
 *    Refuted-by line;
 *  - every criterion is covered by a build PR, every id a build PR names exists, and every
 *    build PR is Tier 2 with a revert check;
 *  - every path the grounding table and the suite-extension table cite exists on main;
 *  - the code tables agree with the tamper tables and probes that use them;
 *  - every code the page uses is a member of exactly one closed enum in §1.1;
 *  - §2.8 accounts for every row of docs/gate/watch.md's security model table;
 *  - follow-ups use the GitHub Issues fallback, never a "TO FILE" note;
 *  - the pending-PR list, the pre-registered proofs and the binding lines stay as written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const RAW = readFileSync(join(ROOT, "docs/product/demo-replay-and-verify-any-agent.md"), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const DOC = flat(RAW);

/** Text from a heading line to the next heading of the same or a higher level. */
function section(heading: string): string {
  const start = RAW.indexOf(`\n${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = RAW.slice(start + 1 + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Table rows of a section (lines starting with `|`), header and separator removed. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .slice(2)
    .map((l) =>
      l
        .slice(1, -1)
        .split(" | ")
        .map((c) => c.trim()),
    );
}

const CRITERION = /^#### ((RS|VA)-(\d{2}))\. /gm;
const criteria = [...RAW.matchAll(CRITERION)].map((m) => ({
  id: m[1] ?? "",
  family: m[2] ?? "",
  n: Number(m[3]),
}));
const ids = criteria.map((c) => c.id);

function criterionText(id: string): string {
  const start = RAW.indexOf(`\n#### ${id}. `);
  const rest = RAW.slice(start + 1);
  const next = rest.slice(5).search(/\n#{2,4} /);
  return next < 0 ? rest : rest.slice(0, next + 5);
}

const buildRows = rows(section("## 5. Build PRs")).filter((r) => /^[BCVL]\d$/.test(r[0] ?? ""));

describe("demo replay + verify-any-agent spec: criteria", () => {
  it("has both families, with ids unique and numbered from 01 without gaps", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of ["RS", "VA"]) {
      const ns = criteria.filter((c) => c.family === family).map((c) => c.n);
      expect(ns.length, family).toBeGreaterThanOrEqual(10);
      expect(ns).toEqual(ns.map((_, i) => i + 1));
    }
  });

  it.each(ids)("%s has exactly one Probe and one Refuted-by line", (id) => {
    const text = criterionText(id);
    expect(text.split("- **Probe:**").length - 1, `${id} Probe`).toBe(1);
    expect(text.split("- **Refuted by:**").length - 1, `${id} Refuted by`).toBe(1);
    expect(text.indexOf("- **Probe:**")).toBeLessThan(text.indexOf("- **Refuted by:**"));
  });

  it("every probe names a test file or a committed report", () => {
    for (const id of ids) {
      const probe = flat(criterionText(id).split("- **Probe:**")[1] ?? "");
      expect(probe, id).toMatch(/`test\/[^`]+`|§3\.5|§3\.6/);
    }
  });
});

describe("demo replay + verify-any-agent spec: build PRs", () => {
  it("lists the build PRs as rows of seven columns", () => {
    expect(buildRows.length).toBeGreaterThanOrEqual(8);
    for (const r of buildRows) expect(r.length, r[0]).toBe(7);
  });

  it("every build PR is Tier 2, says whether it needs a VM, and has a revert check", () => {
    for (const [pr, , , tier, vm, , revert] of buildRows) {
      expect(tier, `${pr} tier`).toBe("2");
      expect(["No VM", "VM"], `${pr} VM`).toContain(vm);
      expect(revert ?? "", `${pr} revert check`).toMatch(/fail|re-runs/);
    }
  });

  it("every criterion is covered by a build PR, and every covered id exists", () => {
    const covered = new Set<string>();
    for (const r of buildRows)
      for (const m of (r[2] ?? "").matchAll(/(RS|VA)-\d{2}/g)) {
        expect(ids, `${r[0]} covers ${m[0]}`).toContain(m[0]);
        covered.add(m[0]);
      }
    for (const id of ids) expect(covered.has(id), `${id} uncovered`).toBe(true);
  });

  it("every build PR dependency is another build PR, a pending PR or a named non-code step", () => {
    const names = new Set(buildRows.map((r) => r[0]));
    for (const r of buildRows)
      for (const dep of (r[5] ?? "").split(",").map((d) => d.trim())) {
        const ref = /^([BCVL]\d)$/.exec(dep)?.[1] ?? /^(#\d+)/.exec(dep)?.[1];
        if (ref?.startsWith("#")) expect(PENDING, `${r[0]} → ${dep}`).toContain(ref);
        else if (ref !== undefined) expect(names.has(ref), `${r[0]} → ${dep}`).toBe(true);
        else
          expect(dep, r[0]).toMatch(
            /^(none|the trial run|the TIF-98 PNG redactor follow-up issue)$/,
          );
      }
  });

  it("states the revert check every verifier must run", () => {
    expect(DOC).toContain(
      "Revert only the PR's non-test code (`git checkout origin/main -- <the PR's src/ and scripts/ paths>`), keep its tests, and run the PR's acceptance tests. **Every listed criterion's probe must fail.**",
    );
  });
});

const PENDING = ["#560"];
/** Merged PRs (state checked 2026-11-27T05:19Z, v5): never listed as open, never waited on. */
const MERGED = ["#551", "#561", "#562", "#563", "#564", "#565", "#566", "#576", "#584", "#592"];

describe("demo replay + verify-any-agent spec: grounding and dependencies", () => {
  it("every path in the grounding table exists on main", () => {
    const text = section("## Grounding: what exists on `main` today")
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .join("\n");
    const paths = [...text.matchAll(/`((?:src|test|docs|examples)\/[^`*]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(paths.length).toBeGreaterThanOrEqual(25);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it("every existing suite the new entry point must join exists on main", () => {
    const text = section("### 3.5 Test suites the new entry point must join");
    const paths = [...text.matchAll(/`(test\/[^`*]+\.test\.ts)`/g)].map((m) => m[1] ?? "");
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it("lists every unmerged PR it depends on", () => {
    const deps = rows(section("## 6. Dependencies on unmerged PRs")).map(
      (r) => /^#\d+/.exec(r[0] ?? "")?.[0],
    );
    expect(deps.sort()).toEqual([...PENDING].sort());
  });

  it("no merged PR is a build dependency or a waiting criterion", () => {
    for (const r of buildRows)
      for (const pr of MERGED) expect(r[5] ?? "", `${r[0]} → ${pr}`).not.toContain(pr);
    const merged = section("## 6. Dependencies on unmerged PRs");
    for (const pr of MERGED) expect(merged, pr).toContain(`**${pr}**`);
    expect(DOC).not.toMatch(/If #561 merges|closed PR #551|RS-09 uses a hand-built/);
  });

  it("RS-09 uses the real linux-plain constant and refuses strict-linux-ns", () => {
    const text = flat(criterionText("RS-09"));
    expect(text).toContain("`PLAIN_ISOLATION.backend` in `src/parallel/linux-backend.ts`");
    expect(text).toContain("`STRICT_BACKEND_ID`");
    expect(readFileSync(join(ROOT, "src/parallel/linux-backend.ts"), "utf8")).toContain(
      'backend: "linux-plain"',
    );
    expect(readFileSync(join(ROOT, "src/isolation/strict-linux-ns.ts"), "utf8")).toContain(
      'STRICT_BACKEND_ID = "strict-linux-ns"',
    );
  });
});

describe("demo replay + verify-any-agent spec: codes and tables agree", () => {
  it("RS-02 names every timeline failure code except TL_NO_TIMELINE", () => {
    const table = rows(section("### 2.2 The frame ⋈ decision join"))
      .map((r) => /^`(TL_[A-Z_]+)`$/.exec(r[0] ?? "")?.[1])
      .filter((c): c is string => c !== undefined);
    expect(table).toContain("TL_NO_TIMELINE");
    const probe = criterionText("RS-02");
    for (const code of table.filter((c) => c !== "TL_NO_TIMELINE"))
      expect(probe, code).toContain(`\`${code}\``);
  });

  it("every clip tamper row names a check in both modes, and none exits 0", () => {
    const text = section("### 2.5 The clip digest and `myco clip verify`");
    const tables = text.split("\n\n").filter((b) => b.trim().startsWith("|"));
    const checkRows = rows(tables[0] ?? "");
    const checks = new Set(
      checkRows
        .map((r) => /^`(CLIP_[A-Z_]+)`$/.exec(r[0] ?? "")?.[1])
        .filter((c): c is string => c !== undefined),
    );
    expect(checks.size).toBeGreaterThanOrEqual(15);
    const sealedOnly = new Set(
      checkRows
        .filter((r) => r[1] === "sealed")
        .map((r) => /`(CLIP_[A-Z_]+)`/.exec(r[0] ?? "")?.[1]),
    );
    const tamper = rows(tables[1] ?? "");
    expect(tamper.length).toBeGreaterThanOrEqual(20);
    for (const r of tamper) {
      expect(r.length, r[0]).toBe(3);
      const logOnly = /`(CLIP_[A-Z_]+)`/.exec(r[1] ?? "")?.[1];
      const sealed = /`(CLIP_[A-Z_]+)`/.exec(r[2] ?? "")?.[1];
      expect(logOnly !== undefined && checks.has(logOnly), `${r[0]} log-only`).toBe(true);
      expect(sealed !== undefined && checks.has(sealed), `${r[0]} sealed`).toBe(true);
      // Log-only mode never runs a sealed check; sealed mode always refuses.
      expect(sealedOnly.has(logOnly), `${r[0]} log-only`).toBe(false);
      expect(sealed, `${r[0]} sealed`).not.toBe("CLIP_LOG_ONLY");
      expect(`${r[1]} ${r[2]}`, r[0]).not.toMatch(/exit 0/);
    }
    // The D2 rows: reorder with ascending labels, a moved pin and a forged MOCK clip.
    for (const sealed of [
      "CLIP_CLAIM",
      "CLIP_TIMELINE",
      "CLIP_SOURCE",
      "CLIP_SEAL",
      "CLIP_MOCK",
      "CLIP_RECOMPUTE",
    ])
      expect(
        tamper.some((r) => (r[2] ?? "").startsWith(`\`${sealed}\``)),
        sealed,
      ).toBe(true);
  });

  it("pins the single-pixel frame tamper and the claim-banner tampers (N1, round-2 D2)", () => {
    const text = section("### 2.5 The clip digest and `myco clip verify`");
    const tamper = rows(text.split("\n\n").filter((b) => b.trim().startsWith("|"))[1] ?? "");
    const pixel = tamper.find((r) => (r[0] ?? "").startsWith("the same single-pixel content edit"));
    expect(pixel?.[1]).toMatch(/^`CLIP_LOG_ONLY`/);
    expect(pixel?.[2]).toBe("`CLIP_SOURCE`");
    const claim = tamper.filter((r) => (r[0] ?? "").includes("claim"));
    expect(claim.filter((r) => r[2] === "`CLIP_CLAIM`").length).toBe(3);
    const rs17 = flat(criterionText("RS-17"));
    expect(rs17).toContain("the single-pixel content edit");
    expect(rs17).toContain("claim-banner rows");
  });

  it("the recording tamper table has the 11 cases VA-08 names", () => {
    const table = rows(section("### 3.4 A recording cannot smuggle evidence"));
    expect(table.map((r) => r[0])).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
    expect(criterionText("VA-08")).toContain("all 11 cases");
    for (const r of table) expect(r[2] ?? "", `case ${r[0]}`).not.toMatch(/^`?verified/);
  });

  it("pre-registers P1-P6, with P5 after the trial run only and P6 with no VM", () => {
    const table = rows(section("### 3.6 Pre-registered proofs"));
    expect(table.map((r) => r[0])).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
    expect(table[4]?.[1]).toContain("after the trial run (VM)");
    expect(table[5]?.[1]).toContain("no VM");
    expect(table[5]?.[1]).toContain("mock transport");
    expect(DOC).toContain("The table is not edited to match a result.");
  });
});

describe("demo replay + verify-any-agent spec: code enums, watch rows, trackers", () => {
  const enums = rows(section("### 1.1 The closed code enums"));
  const members = enums.map((r) =>
    [...(r[1] ?? "").matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1] ?? ""),
  );

  it("lists the three enums, each member once", () => {
    expect(enums.map((r) => /`([A-Z_]+)`/.exec(r[0] ?? "")?.[1])).toEqual([
      "TIMELINE_CODES",
      "CLIP_CODES",
      "VERIFY_CODES",
    ]);
    const all = members.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("every code the page uses is in an enum, and every enum member is used", () => {
    const listed = new Set(members.flat());
    const used = new Set(
      [...RAW.matchAll(/`((?:TL|CLIP|VERIFY|PAIR)_[A-Z_]+)`/g)]
        .map((m) => m[1] ?? "")
        .filter((code) => !code.endsWith("_CODES")),
    );
    for (const code of used) expect(listed.has(code), code).toBe(true);
    const outsideEnums = RAW.replace(section("### 1.1 The closed code enums"), "");
    for (const code of listed) expect(outsideEnums, code).toContain(`\`${code}\``);
  });

  it("§2.8 accounts for every row of docs/gate/watch.md's security model table", () => {
    const watch = readFileSync(join(ROOT, "docs/gate/watch.md"), "utf8");
    const model = watch.slice(watch.indexOf("## Security model"));
    const watchRows = rows(model.slice(0, model.indexOf("\n\n", model.indexOf("|")))).map(
      (r) => r[0],
    );
    expect(watchRows.length).toBe(11);
    const specRows = rows(section("### 2.8 Security model: what holds and what changes"));
    expect(specRows.map((r) => r[0])).toEqual(watchRows);
    for (const r of specRows)
      expect(r[1] ?? "", r[0]).toMatch(/^(holds unchanged|text amended \(B\d(, B\d)?\))$/);
    expect(DOC).not.toContain("Every row of the table in `docs/gate/watch.md` keeps holding");
  });

  it("uses the GitHub Issues fallback, never a TO FILE note", () => {
    expect(RAW).not.toMatch(/TO\s+FILE/);
    expect(DOC).toContain("labelled `from-linear-overflow` plus `tier-1` or `tier-2`");
  });
});

describe("demo replay + verify-any-agent spec: the binding check follows the gate's code (v4)", () => {
  const PRE_EVIDENCE = [
    "INVALID_REQUEST",
    "UNKNOWN_FIELD",
    "ORACLE_INPUT_REJECTED",
    "UNSUPPORTED_API_VERSION",
    "ASSIGNMENT_MISMATCH",
  ];
  const binding = flat(
    section("### 1.2 Attribution: a decision belongs to the trial its gate is bound to"),
  );

  it("rule (b) names exactly the gate's pre-evidence rejection codes", () => {
    const rule = binding.slice(binding.indexOf("**(b) A foreign id only on a pre-evidence"));
    const codes = [...rule.slice(0, rule.indexOf("A line that breaks")).matchAll(/`([A-Z_]+)`/g)]
      .map((m) => m[1] ?? "")
      .filter((c) => c !== "CLAIM_RECORDED");
    expect(codes.sort()).toEqual([...PRE_EVIDENCE].sort());
    // The same set the MCP server flags as a rejected request.
    const mcp = readFileSync(join(ROOT, "src/gate/mcp-server.ts"), "utf8");
    const list = mcp.slice(mcp.indexOf("const rejected"), mcp.indexOf("].includes(code)"));
    expect([...list.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort()).toEqual(
      [...PRE_EVIDENCE].sort(),
    );
  });

  it("the gate still logs a parse rejection with partialOf(raw), before the assignment check", () => {
    const api = readFileSync(join(ROOT, "src/gate/api.ts"), "utf8");
    expect(api).toContain("function partialOf(raw: Record<string, unknown>)");
    const gate = readFileSync(join(ROOT, "src/gate/gate.ts"), "utf8");
    const decide = gate.slice(gate.indexOf("async function decide("));
    expect(decide.indexOf("request: parsed.partial")).toBeGreaterThan(0);
    expect(decide.indexOf("request: parsed.partial")).toBeLessThan(
      decide.indexOf('"ASSIGNMENT_MISMATCH"'),
    );
  });

  it("RS-01, VA-03 and VA-13 carry the pre-evidence rejection lines as binding-holds cases", () => {
    for (const id of ["RS-01", "VA-03", "VA-13"]) {
      const text = flat(criterionText(id));
      expect(text, id).toContain("**Binding holds, attribution unchanged:**");
      for (const code of ["UNKNOWN_FIELD", "INVALID_REQUEST", "ORACLE_INPUT_REJECTED"])
        expect(text, `${id} ${code}`).toContain(`\`${code}\``);
    }
  });

  it("pins the clip regression rows: a foreign-id agent rejection never blocks export or verify", () => {
    const text = section("### 2.5 The clip digest and `myco clip verify`");
    const regression = rows(text.split("\n\n").filter((b) => b.trim().startsWith("|"))[2] ?? "");
    expect(regression.length).toBeGreaterThanOrEqual(3);
    for (const r of regression) {
      expect(r[1], r[0]).toBe("exit 2 `CLIP_LOG_ONLY`");
      expect(r[2], r[0]).toBe("exit 0");
    }
    expect(regression.some((r) => (r[0] ?? "").includes("`UNKNOWN_FIELD`"))).toBe(true);
    expect(flat(criterionText("RS-17"))).toContain("required regression cases");
  });

  it("the shared demo log still fails by design, and the key is stated per batch", () => {
    expect(binding).toContain("therefore still fails by design");
    expect(flat(criterionText("VA-13"))).toContain("`VERIFY_LOG_BINDING`, by design");
    const runner = readFileSync(join(ROOT, "src/pilot/runner.ts"), "utf8");
    expect(runner.split("newVaultKey()").length - 1).toBe(1);
    expect(DOC).toContain("**The key is per batch, not per trial.**");
    expect(flat(criterionText("VA-14"))).toContain(
      "the two trials' key files hold identical bytes",
    );
  });
});

describe("demo replay + verify-any-agent spec: checkpointed capture, #596 nits, export guard (v5)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  // Computed per test run, not at collection, so an older spec fails these tests one by one.
  let cp = "";
  let step4 = "";
  beforeEach(() => {
    const at = RAW.indexOf("\n### 1.4 Checkpointed mid-run capture");
    cp = at < 0 ? "" : flat(section("### 1.4 Checkpointed mid-run capture"));
    step4 = flat(
      RAW.slice(
        RAW.indexOf("4. **Compare, never adopt.**"),
        RAW.indexOf("5. **What the agent told"),
      ),
    );
  });

  it("is version 5 and cites the issues it closes", () => {
    expect(DOC).toContain("**Status: spec, pre-registered, nothing built. Version 5**");
    for (const ref of ["#588", "#596"]) expect(DOC.slice(0, 1200), ref).toContain(ref);
  });

  it("C1 waits for the trial run and names the held gate files; C1, V5 and B7 need no VM", () => {
    const row = (id: string) => buildRows.find((r) => r[0] === id);
    const c1 = row("C1");
    expect(c1?.[5]).toBe("V1, B1, the trial run");
    expect(DOC).toContain(
      "C1 also waits for B1, because a checkpoint manifest's `logBefore` is computed by B1's shared line-count and prefix function.",
    );
    expect(cp).toContain("computed by B1's shared function");
    for (const p of ["src/gate/sealed.ts", "src/gate/gated-trial.ts", "src/integrity/vault.ts"]) {
      expect(c1?.[6], p).toContain(`\`${p}\``);
      expect(existsSync(join(ROOT, p)), p).toBe(true);
    }
    expect(row("V5")?.[5]).toBe("C1");
    expect(row("B7")?.[5]).toBe("B2, C1");
    for (const id of ["C1", "V5", "B7"]) expect(row(id)?.[4], id).toBe("No VM");
    expect(cp).toContain("`src/gate/*` is held for the R1 pilot and PR #607");
  });

  it("describes main as it is: one capture after the stop, and nothing of §1.4 built yet", () => {
    const trial = read("src/gate/gated-trial.ts");
    expect(trial).toContain("opts.vault.markAgentStopped(opts.runId);");
    expect(trial.indexOf("markAgentStopped(opts.runId)")).toBeLessThan(
      trial.indexOf("await opts.transport.captureAfterStop()"),
    );
    expect(trial).not.toMatch(/captureCheckpoint|captureCheckpoints/);
    expect(read("src/gate/sealed.ts")).toContain('"integrity:agent-not-stopped"');
    expect(read("src/integrity/vault.ts")).not.toMatch(/checkpoint\(|openCheckpointForTrial/);
  });

  it("the option name does not collide with the oracle's per-step checkpoints result field", () => {
    expect(read("src/gate/api.ts")).toMatch(/readonly checkpoints\b/);
    expect(RAW).not.toMatch(/`checkpoints: (\{|"on")/);
    expect(cp).toContain("`captureCheckpoints: { max: <n> }`");
  });

  it("adds no gate reason code: every reason code §1.4 names is already in REASON_CODES", () => {
    const api = read("src/gate/api.ts");
    const list = api.slice(
      api.indexOf("REASON_CODES"),
      api.indexOf("] as const", api.indexOf("REASON_CODES")),
    );
    // Constants §1.4 names that are not reason codes (a vault symbol and a size limit).
    const notReasonCodes = new Set(["AUDIT_WITHOUT_RECEIPT", "STATE_FILE_LIMIT"]);
    const codes = [...cp.matchAll(/`([A-Z][A-Z_]{3,})`/g)]
      .map((m) => m[1] ?? "")
      .filter((c) => !notReasonCodes.has(c));
    expect(codes).toEqual(
      expect.arrayContaining(["STATE_UNREADABLE", "ORACLE_FAIL", "ORACLE_PASS"]),
    );
    for (const code of codes) expect(list, code).toContain(`"${code}"`);
    expect(cp).toContain("No new reason code");
  });

  it("only an S3 call can trigger a checkpoint, the trial's verdict never moves, and on is never evidence", () => {
    expect(cp).toContain(
      "A parse rejection (S1) or an assignment rejection (S2) reads nothing and triggers nothing",
    );
    expect(cp).toContain("A checkpoint decision is never the trial's verdict");
    expect(cp).toContain("every R1 and A/B evidence path refuses a trial recorded `on`");
    expect(cp).toContain("never with `AUDIT_WITHOUT_RECEIPT`");
    expect(cp).toContain("A checkpoint is refused after `markAgentStopped`");
  });

  it("N1: step 4 compares only lines that read the recompute's bytes", () => {
    expect(step4).not.toContain("that is every S2 and S3 line");
    expect(step4).toContain("every S3 line whose `evidenceRefs` equal the recompute's refs");
    expect(step4).toContain("A disagreement on **any compared line**");
    expect(step4).toContain("`VERIFY_CHECKPOINT_MISMATCH`");
    const va03 = flat(criterionText("VA-03"));
    for (const s of [
      "`STATE_MISSING`",
      "`ms-slip-then-repair-retry`",
      "`loggedVerdictAgrees: null`",
    ])
      expect(va03, s).toContain(s);
  });

  it("N2: §6 no longer says #567 is open", () => {
    const deps = flat(section("## 6. Dependencies on unmerged PRs"));
    expect(deps).not.toMatch(/#567[^.]*is open/);
    expect(deps).toContain(
      "#567, this spec's versions 1 to 3, closed unmerged; version 4 merged as #589.",
    );
  });

  it("exports reuse src/export-guard and its provenance rule, never a local copy", () => {
    const privacy = flat(section("### 2.7 Export privacy"));
    const exportsOf: Record<string, string[]> = {
      "src/export-guard/identity-words.ts": [
        "identityFold",
        "identityNeedles",
        "IDENTITY_WORD_MIN_CHARS",
      ],
      "src/export-guard/provenance.ts": ["HashLedger", "HASHED_FORM"],
      "src/export-guard/fold.ts": ["stripAccents"],
    };
    for (const [path, names] of Object.entries(exportsOf)) {
      expect(privacy, path).toContain(`\`${path}\``);
      const src = read(path);
      for (const name of names) {
        expect(src, `${path} ${name}`).toMatch(
          new RegExp(`export (const|function|class) ${name}\\b`),
        );
        if (name !== "stripAccents") expect(privacy, name).toContain(`\`${name}\``);
      }
    }
    expect(privacy).toContain(
      "define no fold, needle rule, hashed-form pattern or ledger of their own",
    );
    expect(privacy).not.toContain("Issue #579 proposes");
    const rs10 = flat(criterionText("RS-10"));
    expect(rs10).toContain("an agent-supplied `h-<60hex>` in any id field");
    expect(rs10).not.toContain("an existing `h-<60hex>` value is kept, while");
  });

  // Round 2 (verdict D1, D2, N1, N3, N4 on #634): each sentence below is a claim the PR body
  // makes; each was a surviving mutant (V01-V12) before it was pinned here.
  it("D1: the three refusals give byte-identical agent-facing results; the case goes to the operator only", () => {
    expect(cp).not.toContain("operator-only detail");
    expect(cp).toContain(
      "the budget-spent, in-flight and copy-failed cases give byte-identical agent-facing results: the same codes, the same single reason `could not look: no checkpoint taken`, and no `evidenceRefs`.",
    );
    expect(cp).toContain(
      "The reader's `detail` reaches the agent (`could not look: <detail>`, `src/gate/gate.ts`), so it never names the case.",
    );
    expect(cp).toContain(
      "Which case it was goes to the operator only, through a new operator-only callback `onCheckpoint` on the sealed reader's options, beside `onIntegrity` (`src/gate/sealed.ts`)",
    );
    expect(cp).toContain("`onCheckpoint` never feeds a result, a reason or the decision log.");
    // The grounding: main's reader detail is agent-facing, and onIntegrity is operator-only.
    const gate = read("src/gate/gate.ts");
    expect(gate).toContain(
      '`detail` of a failed outcome reaches the agent (as "could not look: <detail>")',
    );
    expect(gate).toMatch(/reasons: \[`could not look: \$\{read\.detail\}`\],/);
    const sealed = read("src/gate/sealed.ts");
    expect(sealed).toContain("The full violations go to the operator through `onIntegrity`.");
    expect(sealed).not.toContain("onCheckpoint");
    const va16 = flat(criterionText("VA-16"));
    expect(va16).toContain(
      "the budget-spent, in-flight and copy-failed cases give byte-identical agent-facing results (codes, reasons and refs) while `onCheckpoint` tells the operator which case each was",
    );
    expect(va16).toContain(
      "an agent-facing result that differs between the budget-spent, in-flight and copy-failed cases or names which one it was",
    );
  });

  it("N3: an absent state file on an opted-in trial gets STATE_MISSING, after the budget checks", () => {
    expect(cp).toContain(
      "the call is answered as the gate answers a missing file today, `uncertain` `STATE_MISSING` with the gate's missing-state corrections (`src/gate/gate.ts`). No checkpoint is sealed and the budget is not spent.",
    );
    expect(cp).toContain(
      "Before it asks for a copy, the reader checks the budget, then whether another checkpoint is being taken.",
    );
    expect(cp).toContain(
      "a call past the budget or during a checkpoint gets the fixed `STATE_UNREADABLE` answer whether or not the file exists.",
    );
    expect(read("src/gate/gate.ts")).toContain(
      'codes: [read.cause === "missing" ? "STATE_MISSING" : "STATE_UNREADABLE"],',
    );
    expect(flat(criterionText("VA-16"))).toContain(
      "on an opted-in trial a state file that does not exist yet gives `uncertain` `STATE_MISSING`, seals no checkpoint and spends no budget",
    );
  });

  it("N1: off by default changes only the outcome's captureCheckpoints field, as VA-16 states", () => {
    expect(cp).not.toContain("byte for byte as on `main`");
    expect(cp).toContain(
      "Without it the trial's decision log and vault tree are byte-identical to `main`'s, with no checkpoint and every mid-run call `uncertain`; the only difference is that its outcome records `captureCheckpoints: \"off\"` (VA-16).",
    );
    expect(flat(criterionText("VA-16"))).toContain(
      'its outcome differs from `main`\'s only by `captureCheckpoints: "off"`',
    );
  });

  it("sealing: the vault assigns k, the manifest is receipt-bound, and a torn copy fails closed (V07, V08, V11)", () => {
    expect(cp).toContain("(`k` = 1, 2, … assigned by the vault, never by a caller)");
    expect(cp).toContain(
      "The manifest is MAC'd with the trial's seal key and bound to the receipt's `sealDigest`, as the final capture is.",
    );
    expect(cp).not.toMatch(/not bound to the receipt|assigned by the caller/);
    expect(cp).toContain(
      "The oracle then reads what was copied and answers `uncertain` or `refuted`; it is never repaired or retried silently.",
    );
  });

  it("isolation: linux-plain refuses captureCheckpoint (V02)", () => {
    expect(cp).toContain(
      "on `linux-plain` (where the agent could rewrite the copy) `captureCheckpoint()` is refused and every mid-run call stays `uncertain`.",
    );
    expect(cp).not.toContain("`captureCheckpoint()` is allowed");
  });

  it("the budget and C1 timing stay lead ruling pending in both §1.4 and §8 question 5 (V05, V10)", () => {
    expect(cp).toContain(
      "At most `max` checkpoints per trial (proposed 4, lead ruling pending, [§8](#8-open-questions-for-the-lead) question 5).",
    );
    expect(cp).not.toMatch(/fixed at 4|[Rr]atified/);
    const open = flat(section("## 8. Open questions for the lead"));
    const q5 = open.slice(open.indexOf("5. **Checkpointed capture"));
    expect(q5).toContain(
      "5. **Checkpointed capture (version 5, issue #588).** Proposals, all lead ruling pending:",
    );
    expect(q5).not.toMatch(/[Rr]atified/);
  });

  it("verify matches checkpoints by order and digest, never by a clock (V03, V04)", () => {
    expect(step4).toContain(
      "its `persisted-state` ref has checkpoint `k`'s `sha256` and `bytes`; and matched ordinals strictly increase with `k`.",
    );
    expect(step4).toContain(
      "Identical bytes at two checkpoints are resolved by the order rule, never by a clock.",
    );
    expect(step4).not.toMatch(/may be in any order|resolved by a clock/);
  });

  it("RS-18: the watch page never opens the vault (V06)", () => {
    const s23 = flat(section("### 2.3 What real runs show today"));
    expect(s23).toContain(
      "The page takes the label from the log line alone (an S3 line with a `persisted-state` ref, before the run's last line) and never opens the vault",
    );
    expect(s23).not.toMatch(/\band opens the vault/);
  });

  it("checkpoint-on is never evidence: P6 and VA-16 say so (V01, V09)", () => {
    const p6 = rows(section("### 3.6 Pre-registered proofs")).find((r) => r[0] === "P6");
    const p6Row = p6 ? flat(p6.join(" | ")) : "";
    expect(p6Row).toContain(
      'The outcome records `captureCheckpoints: "on"`, and the R1 evidence check refuses it',
    );
    expect(p6Row).not.toContain("the R1 evidence check accepts it");
    const va16 = flat(criterionText("VA-16"));
    expect(va16).toContain("or a checkpoint-on trial accepted as R1 or A/B evidence.");
    expect(va16).toContain(
      "every R1 and A/B evidence check refuses such a trial, as it refuses corrections `on`.",
    );
  });

  it("N4: P6 reuses slip-then-repair's edits, not its harness restore", () => {
    const p6 = rows(section("### 3.6 Pre-registered proofs")).find((r) => r[0] === "P6");
    const p6Row = p6 ? flat(p6.join(" | ")) : "";
    expect(p6Row).toContain(
      "P6 reuses the scenario's edits (which step slips and how it is repaired), not its harness restore of oracle checkpoint 1: here the scripted agent repairs step 2 itself, and every checkpoint in P6 is a §1.4 capture, not one of the oracle's per-step checkpoints.",
    );
    // The grounding: on main, slip-then-repair's retry is a harness restore of checkpoint 1.
    expect(flat(read("src/gate/multistep-demo.ts"))).toContain(
      "retry restores checkpoint 1 and the agent redoes steps 2-3",
    );
  });

  it("P6 cites the demo's real task and scenario", () => {
    const demo = read("src/gate/multistep-demo.ts");
    expect(demo).toContain('MS_TASK_ID = "calc-ms-demo"');
    expect(demo).toContain('name: "slip-then-repair"');
    expect(read("docs/product/demo-storyboard.md")).toContain("ms-slip-then-repair-retry");
  });
});

describe("demo replay + verify-any-agent spec: binding lines", () => {
  it.each([
    "`myco.gate/v1` still takes only `taskId`, `runId` and `claim`.",
    "**Mock is never evidence.** This is decided by where a run came from (its provenance), never by a flag the caller passes",
    "**No write endpoint.** Every method other than GET still gets 405 before routing.",
    "**The server writes no file.**",
    "**No new listening interface.**",
    "**No remote fetch.**",
    "The agent-supplied surface is exactly `myco.gate/v1`'s `taskId`, `runId` and `claim`, as recorded in the decision log, or a recording's closed fields.",
    "It comes **after** the trial run and the integrity fixes, and it never delays them.",
    "`checkedAt`, frame mtimes, file names and the host clock are never join keys.",
    "**Stated limit: tamper-evident, not tamper-proof.**",
    "**Exit 0 (verified) only in sealed mode.**",
    "`request.runId` and `request.taskId` are never used to attribute a line.",
    "**The watch server never loads a key, never opens the vault's sealed files and never serves an evidence clip**",
    "`--vault` requires both `--seal-receipt` and `--vault-key-file`; without either it is a usage error (exit 3), never an offline audit.",
    "On pre-evidence rejection lines, rewriting `request.runId` to any other listed run changes no pin.",
    "On a line that is not a pre-evidence rejection (a verdict line past the assignment check), the same rewrite breaks the binding check and the join is invalid with `TL_LOG_BINDING`",
    "**(a) Evidence binding.** Every `evidenceRefs[].runId` equals `r`.",
    "So no call the agent makes, malformed or not, can make its own honest per-trial log fail the binding check",
    "**This timing rule bounds only the per-trial path, not the key:**",
    "An S1 line is not re-parsed",
    "The key file is written **after** that trial's agent has stopped and its post-capture check has returned",
    "`open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`",
    "Until it is ratified, V1 does not merge.",
    "There is no `--episode` flag: the clip's claim comes only from the sealed claim record",
    "The static import allowlist in `test/watch/server-security.test.ts` is **extended, never relaxed**",
  ])("keeps: %s", (line) => {
    expect(DOC).toContain(flat(line));
  });
});
