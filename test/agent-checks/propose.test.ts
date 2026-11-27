/**
 * Track C, acceptance: an agent-written check is accepted only after R5's mutation self-test
 * passes for every class it claims, over HOST-OWNED cases; a hostile check (always-pass,
 * always-refute, over-claiming, crashing, hanging, self-serving cases, reader, no value claim)
 * is refused; an accepted check runs only in track T's sandbox, only over its own task, and
 * only yields a labelled advisory signal.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_CHECK_FAMILIES,
  type AgentCheck,
  proposeAgentCheck,
  runAgentCheck,
  VALUE_CLASSES,
} from "../../src/agent-checks/check.ts";
import {
  AGENT_CHECK_EVIDENCE_CLASS,
  AGENT_CHECK_SIGNAL_KIND,
  AGENT_CHECK_SOURCE,
} from "../../src/agent-checks/label.ts";
import { registerPlugin } from "../../src/plugins/host/registry.ts";
import {
  BINDING,
  CHECK_MANIFEST,
  cleanupPlugins,
  collateralCsv,
  csvDoc,
  exactCsv,
  HONEST_CLAIMS,
  honestSource,
  makeCheck,
  SPEC,
} from "./helpers.ts";

afterAll(cleanupPlugins);

const T = 120_000;

function accept(source = honestSource(), manifest: Record<string, unknown> = {}): AgentCheck {
  const r = proposeAgentCheck(makeCheck(source, manifest), BINDING);
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.reasons.join("; ")}`);
  return r.check;
}

describe("track C: an honest check passes R5 over host cases and yields an advisory signal", () => {
  it(
    "accepts the check, binds it to its task, and labels every signal with provenance",
    () => {
      const check = accept();
      expect(check.binding).toEqual(BINDING);
      expect(check.provenance).toMatchObject({
        source: AGENT_CHECK_SOURCE,
        taskId: BINDING.taskId,
        runId: BINDING.runId,
        family: "calc-record-edit",
        check: CHECK_MANIFEST.name,
        selftest: { pass: true, claims: HONEST_CLAIMS, cases: 3 },
      });
      expect(check.provenance.selftest.caughtClaimed).toBe(check.provenance.selftest.runsClaimed);
      expect(check.provenance.selftest.runsClaimed).toBeGreaterThanOrEqual(12);

      const ok = runAgentCheck(check, BINDING, csvDoc(exactCsv), SPEC);
      expect(ok).toEqual({
        kind: AGENT_CHECK_SIGNAL_KIND,
        advisory: true,
        r1Evidence: false,
        evidenceClass: AGENT_CHECK_EVIDENCE_CLASS,
        status: "verified",
        code: "TARGET_OK",
        codeSource: "check",
        provenance: check.provenance,
      });
      expect(Object.isFrozen(ok)).toBe(true);
      expect(Object.isFrozen(ok.provenance)).toBe(true);
      expect(() => {
        (ok as { status: string }).status = "refuted";
      }).toThrow(TypeError);

      const bad = runAgentCheck(check, BINDING, csvDoc(exactCsv.replace("4242", "4243")), SPEC);
      expect([bad.status, bad.code, bad.codeSource]).toEqual(["refuted", "TARGET_WRONG", "check"]);
      expect(runAgentCheck(check, BINDING, csvDoc(null), SPEC).status).toBe("uncertain");
    },
    T,
  );

  it("supports exactly the families with host-owned cases, and every value class is refuted", () => {
    expect(AGENT_CHECK_FAMILIES).toEqual(["calc-record-edit"]);
    expect(VALUE_CLASSES).toEqual(["edit-missing", "wrong-value", "wrong-target", "collateral"]);
  });
});

describe("track C: R5 refuses every check that has not earned its claims", () => {
  it(
    "always-pass: corruptions verify",
    () => {
      const r = proposeAgentCheck(
        makeCheck('export default { oracle() { return { status: "verified", code: "OK" }; } };'),
        BINDING,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
      expect(r.selftest?.pass).toBe(false);
    },
    T,
  );

  it(
    "always-refute: the correct documents do not verify",
    () => {
      const r = proposeAgentCheck(
        makeCheck('export default { oracle() { return { status: "refuted", code: "NO" }; } };'),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/correct documents did not verify/);
    },
    T,
  );

  it(
    "over-claim: a target-only check that claims collateral (or truncated) is refused",
    () => {
      for (const extra of ["collateral", "truncated"]) {
        const r = proposeAgentCheck(
          makeCheck(honestSource(), { claims: [...HONEST_CLAIMS, extra] }),
          BINDING,
        );
        expect(r.ok ? "accepted" : r.code, extra).toBe("AGENT_CHECK_SELFTEST_FAILED");
        if (!r.ok) expect(r.reasons.join(" "), extra).toMatch(new RegExp(`${extra}: \\d+ of`));
      }
    },
    T,
  );

  it(
    "crash: a check that throws on every document is refused",
    () => {
      const r = proposeAgentCheck(
        makeCheck('export default { oracle() { throw new Error("boom"); } };'),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
    },
    T,
  );

  it(
    "crash as a catch: throwing instead of refuting is a harness fault, not a catch",
    () => {
      const r = proposeAgentCheck(
        makeCheck(honestSource({ onRefuted: 'throw new Error("refute by crash");' })),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_HARNESS_FAULT");
      if (!r.ok) expect(r.reasons).toContain("PLUGIN_THREW");
    },
    T,
  );

  it(
    "hang as a catch: a timeout is a harness fault, not a catch",
    () => {
      const started = Date.now();
      const r = proposeAgentCheck(
        makeCheck(honestSource({ onRefuted: "for (;;) {}" }), {
          caps: { ...CHECK_MANIFEST.caps, timeoutMs: 300 },
        }),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_HARNESS_FAULT");
      if (!r.ok) expect(r.reasons).toContain("PLUGIN_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    T,
  );

  it(
    "self-serving cases: the check's own selftestCases are never used",
    () => {
      // Verifies everything except the one corruption its own cases contain. Track T's
      // default registration (plugin-supplied cases) would accept it; track C must not.
      const source = `
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
export default {
  oracle(doc) {
    if (doc.bytes === null) return { status: "uncertain", code: "FILE_MISSING" };
    return dec(doc.bytes).includes("BROKEN") ? { status: "refuted", code: "NO" } : { status: "verified", code: "OK" };
  },
  selftestCases() {
    const c = (s) => ({ fileName: "a.csv", bytes: enc(s) });
    return [{ id: "easy", intent: {}, correct: c("id,v\\nx,1\\n"), corruptions: [
      { cls: "edit-missing", doc: c("BROKEN") }, { cls: "wrong-value", doc: c("BROKEN1") },
      { cls: "wrong-target", doc: c("BROKEN2") }, { cls: "missing-file", doc: { fileName: "a.csv", bytes: null } },
    ] }];
  },
};`;
      const dir = makeCheck(source);
      expect(registerPlugin(dir).ok).toBe(true);
      const r = proposeAgentCheck(dir, BINDING);
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
    },
    T,
  );

  it(
    "no value claim: a check that only notices a missing file is not a check of the task",
    () => {
      const r = proposeAgentCheck(
        makeCheck(
          'export default { oracle(d) { return d.bytes === null ? { status: "uncertain", code: "GONE" } : { status: "verified", code: "OK" }; } };',
          { claims: ["missing-file"] },
        ),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_NO_VALUE_CLAIM");
      // It did pass R5 for what it claimed: the refusal is the value-claim rule, not R5.
      if (!r.ok) expect(r.selftest?.pass).toBe(true);
    },
    T,
  );

  it(
    "reader: an agent-written check is an oracle only",
    () => {
      const r = proposeAgentCheck(
        makeCheck(
          honestSource({ extra: 'reader() { return { status: "uncertain", code: "NO" }; },' }),
          { kinds: ["oracle", "reader"] },
        ),
        BINDING,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_NOT_ORACLE_ONLY");
    },
    T,
  );

  it("a check that does not declare the family's format is refused before anything runs", () => {
    const r = proposeAgentCheck(
      makeCheck(honestSource(), { formats: [{ ext: ".txt", mediaType: "text/plain" }] }),
      BINDING,
    );
    expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_CASES_INVALID");
  });

  it("an invalid binding or an unsupported family is refused", () => {
    const dir = makeCheck(honestSource());
    for (const b of [
      { ...BINDING, taskId: "../x" },
      { ...BINDING, runId: "" },
      { ...BINDING, extra: "x" },
      null,
    ])
      expect((proposeAgentCheck(dir, b as never) as { code?: string }).code).toBe(
        "AGENT_CHECK_BINDING_INVALID",
      );
    for (const family of ["todo-items", "writer-doc-edit", "toString", "__proto__"])
      expect(
        (proposeAgentCheck(dir, { ...BINDING, family } as never) as { code?: string }).code,
      ).toBe("AGENT_CHECK_FAMILY_UNSUPPORTED");
  });
});

describe("track C: an accepted check runs only as itself, only for its own task, only sandboxed", () => {
  it(
    "another task or run, a forged copy, or an edited check is uncertain with a host code",
    () => {
      const dir = makeCheck(honestSource());
      const r = proposeAgentCheck(dir, BINDING);
      if (!r.ok) throw new Error(r.code);
      const check = r.check;
      const doc = csvDoc(exactCsv);
      for (const b of [
        { ...BINDING, taskId: "other-task" },
        { ...BINDING, runId: "run-2" },
        { ...BINDING, family: "writer-doc-edit" },
        { ...BINDING, extra: "x" },
      ] as never[]) {
        const s = runAgentCheck(check, b, doc, SPEC);
        expect([s.status, s.code, s.codeSource]).toEqual([
          "uncertain",
          "AGENT_CHECK_TASK_MISMATCH",
          "host",
        ]);
        expect(s.r1Evidence).toBe(false);
      }
      const forged = { ...check } as AgentCheck;
      const f = runAgentCheck(forged, BINDING, doc, SPEC);
      expect([f.status, f.code, f.provenance]).toEqual([
        "uncertain",
        "AGENT_CHECK_NOT_ACCEPTED",
        null,
      ]);
      appendFileSync(join(dir, "check.mjs"), "\n// edited after acceptance\n");
      const e = runAgentCheck(check, BINDING, doc, SPEC);
      expect([e.status, e.code, e.codeSource]).toEqual(["uncertain", "PLUGIN_CHANGED", "host"]);
    },
    T,
  );

  it(
    "inside the check there is no network and no filesystem write",
    () => {
      const probe = `
let fsOpen = false, netOpen = false, fetchOpen = typeof globalThis.fetch === "function";
try { const fs = await import("node:fs"); fs.writeFileSync("/tmp/agent-check-wrote", "x"); fsOpen = true; } catch {}
try { await import("node:net"); netOpen = true; } catch {}
try { await import("node:http"); netOpen = true; } catch {}
try { await import("node:child_process"); fsOpen = true; } catch {}
if (fsOpen || netOpen || fetchOpen) return { status: "verified", code: "SANDBOX_OPEN" };`;
      const check = accept(honestSource({ prelude: probe }));
      const s = runAgentCheck(check, BINDING, csvDoc(exactCsv), SPEC);
      expect([s.status, s.code]).toEqual(["verified", "TARGET_OK"]);
      expect(runAgentCheck(check, BINDING, csvDoc(collateralCsv), SPEC).code).toBe("TARGET_OK");
    },
    T,
  );

  it(
    "a signal from a check that is wrong about collateral damage is still only advisory",
    () => {
      const check = accept();
      const s = runAgentCheck(check, BINDING, csvDoc(collateralCsv), SPEC);
      // Target-only, as it claimed: it verifies a document the gate and the grader reject
      // (test/agent-checks/no-influence.test.ts). That is why it is never the grader.
      expect([s.status, s.advisory, s.r1Evidence]).toEqual(["verified", true, false]);
    },
    T,
  );
});

describe("track C: the manifest file is the check's", () => {
  it("a check directory without a manifest is refused", () => {
    const dir = makeCheck(honestSource());
    writeFileSync(join(dir, "myco-plugin.json"), "{");
    expect((proposeAgentCheck(dir, BINDING) as { code?: string }).code).toBe(
      "AGENT_CHECK_MANIFEST_INVALID",
    );
  });
});
