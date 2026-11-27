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
import { describe, expect, it } from "vitest";

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

const buildRows = rows(section("## 5. Build PRs")).filter((r) => /^[BVL]\d$/.test(r[0] ?? ""));

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
        const ref = /^([BVL]\d)$/.exec(dep)?.[1] ?? /^(#\d+)/.exec(dep)?.[1];
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

const PENDING = ["#560", "#563", "#564", "#576", "#584"];
/** Merged PRs (state checked 2026-11-27T00:34Z): never listed as open, never waited on. */
const MERGED = ["#551", "#561", "#562", "#565", "#566"];

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

  it("pre-registers P1-P5, with P5 after the trial run only", () => {
    const table = rows(section("### 3.6 Pre-registered proofs"));
    expect(table.map((r) => r[0])).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(table[4]?.[1]).toContain("after the trial run (VM)");
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
    "On lines that carry `ASSIGNMENT_MISMATCH`, rewriting `request.runId` to any other listed run changes no pin.",
    "On a line without `ASSIGNMENT_MISMATCH`, the same rewrite breaks the binding check and the join is invalid with `TL_LOG_BINDING`",
    "The key file is written **after** that trial's agent has stopped and its post-capture check has returned",
    "`open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`",
    "Until it is ratified, V1 does not merge.",
    "There is no `--episode` flag: the clip's claim comes only from the sealed claim record",
    "The static import allowlist in `test/watch/server-security.test.ts` is **extended, never relaxed**",
  ])("keeps: %s", (line) => {
    expect(DOC).toContain(flat(line));
  });
});
