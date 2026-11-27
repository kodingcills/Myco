/**
 * Track C, round 2 of #590: a check that behaves only while it thinks it is being self-tested
 * is refused (D1), and the host read corruptions track T adds are part of the host-owned cases
 * (D3).
 *
 * D1: the self-test cases used to be `calcCases(3)`, fixed and public: every intent carried
 * `fixtureSeed: "oracle-selftest-0N"` and every document was named `doc.csv`. A check keyed on
 * either passed R5 honestly and then said `verified` to anything on a real run. The cases are
 * now built per proposal from the bound task's own intent and file name plus fresh random
 * seeds and names, so nothing but a document's content tells a self-test call from a real one.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  agentCheckSelfTestCases,
  proposeAgentCheck,
  runAgentCheck,
} from "../../src/agent-checks/check.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  BINDING,
  cleanupPlugins,
  csvDoc,
  exactCsv,
  HONEST_CLAIMS,
  honestSource,
  makeCheck,
  SEED,
  SPEC,
  TASK,
} from "./helpers.ts";

afterAll(cleanupPlugins);

const T = 120_000;
const LGTM = 'return { status: "verified", code: "LGTM" };';

function codeOf(source: string, manifest: Record<string, unknown> = {}): string {
  const r = proposeAgentCheck(makeCheck(source, manifest), BINDING, TASK);
  return r.ok ? "accepted" : r.code;
}

describe("D1: a check that recognises the self-test is refused", () => {
  it(
    "the round-1 repros: keyed on the old fixed seed, or on the old fixed file name",
    () => {
      // Honest on any intent whose seed starts "oracle-selftest-"; "verified" on anything else.
      const seedAware = honestSource({
        prelude: `if (!String(intent?.fixtureSeed ?? "").startsWith("oracle-selftest-")) ${LGTM}`,
      });
      const nameAware = honestSource({ prelude: `if (doc.fileName !== "doc.csv") ${LGTM}` });
      expect(codeOf(seedAware)).toBe("AGENT_CHECK_SELFTEST_FAILED");
      expect(codeOf(nameAware)).toBe("AGENT_CHECK_SELFTEST_FAILED");
    },
    T,
  );

  it(
    "keyed on the bound task either way: lying on the real task, or on anything but it",
    () => {
      // Lies exactly on the real run's intent or name: the bound task's own case catches it.
      const liesOnTask = honestSource({
        prelude: `if (intent.fixtureSeed === ${JSON.stringify(SEED)}) ${LGTM}`,
      });
      const liesOnName = honestSource({ prelude: `if (doc.fileName === "sheet.csv") ${LGTM}` });
      // Honest only on the bound task: the random cases catch it.
      const liesElsewhere = honestSource({
        prelude: `if (intent.fixtureSeed !== ${JSON.stringify(SEED)}) ${LGTM}`,
      });
      for (const [name, src] of Object.entries({ liesOnTask, liesOnName, liesElsewhere }))
        expect(codeOf(src), name).toBe("AGENT_CHECK_SELFTEST_FAILED");
    },
    T,
  );

  it("every proposal gets fresh seeds and names; no fixed harness marker is left", () => {
    const a = agentCheckSelfTestCases("calc-record-edit", TASK);
    const b = agentCheckSelfTestCases("calc-record-edit", TASK);
    const seeds = (cs: typeof a) =>
      cs.map((c) => (c.intent as { fixtureSeed: string }).fixtureSeed);
    const names = (cs: typeof a) => cs.map((c) => c.correct.fileName);
    // The bound task first, exactly as a real run carries it; then the random cases.
    expect(a[0]?.intent).toEqual(SPEC);
    expect(a[0]?.correct.fileName).toBe(TASK.fileName);
    expect(a.length).toBeGreaterThanOrEqual(3);
    const randomA = a.slice(1);
    const randomB = b.slice(1);
    for (const s of [...seeds(randomA), ...seeds(randomB)]) expect(s).toMatch(/^[0-9a-f]{18}$/);
    for (const n of [...names(randomA), ...names(randomB)])
      expect(n).toMatch(/^[0-9a-f]{18}\.csv$/);
    // Nothing repeats, within or across proposals.
    const all = [...seeds(randomA), ...seeds(randomB), ...names(randomA), ...names(randomB)];
    expect(new Set(all).size).toBe(all.length);
    const text = JSON.stringify(
      [...a, ...b].map((c) => ({ i: c.intent, n: c.correct.fileName, ids: c.corruptions.length })),
    );
    expect(text).not.toMatch(/oracle-selftest|doc\.csv/);
  });

  it("a corruption carries its case's intent and file name: only the content differs", () => {
    for (const c of agentCheckSelfTestCases("calc-record-edit", TASK)) {
      expect(c.corruptions.length).toBeGreaterThan(0);
      for (const x of c.corruptions) expect(x.doc.fileName, x.cls).toBe(c.correct.fileName);
      // One intent per case: the sandbox is handed the same intent for every document of it.
      expect(Object.keys(c.intent as object).sort()).toEqual([
        "column",
        "fixtureSeed",
        "newValue",
        "rowKey",
      ]);
    }
  });

  it(
    "an honest check still passes, and a run must carry the bound intent and file name",
    () => {
      const r = proposeAgentCheck(makeCheck(honestSource()), BINDING, TASK);
      if (!r.ok) throw new Error(`${r.code} ${r.reasons.join("; ")}`);
      expect(r.check.task).toEqual(TASK);
      expect(runAgentCheck(r.check, BINDING, csvDoc(exactCsv), SPEC).code).toBe("TARGET_OK");
      const mismatch = [
        [csvDoc(exactCsv), { ...SPEC, newValue: "1" }],
        [csvDoc(exactCsv), { ...SPEC, extra: "x" }],
        [csvDoc(exactCsv), null],
        [{ ...csvDoc(exactCsv), fileName: "other.csv" }, SPEC],
        [{ ...csvDoc(exactCsv), fileName: "doc.csv" }, SPEC],
      ] as const;
      for (const [doc, intent] of mismatch) {
        const s = runAgentCheck(r.check, BINDING, doc as never, intent);
        expect([s.status, s.code, s.codeSource]).toEqual([
          "uncertain",
          "AGENT_CHECK_TASK_MISMATCH",
          "host",
        ]);
      }
      // A path is reduced to its basename, as the plugin host does.
      expect(
        runAgentCheck(r.check, BINDING, { ...csvDoc(exactCsv), fileName: "a/b/sheet.csv" }, SPEC)
          .code,
      ).toBe("TARGET_OK");
    },
    T,
  );

  it("an invalid task is refused before anything runs", () => {
    const dir = makeCheck(honestSource());
    const current = generateFixture(SEED).rows.find((row) => row[0] === SPEC.rowKey)?.[2];
    const bad: unknown[] = [
      null,
      { intent: SPEC },
      { ...TASK, extra: 1 },
      { ...TASK, fileName: "sheet.xlsx" },
      { ...TASK, fileName: "../sheet.csv" },
      { ...TASK, fileName: ".csv" },
      { ...TASK, intent: { ...SPEC, extra: "x" } },
      { ...TASK, intent: { ...SPEC, newValue: "" } },
      { ...TASK, intent: { ...SPEC, newValue: "1,2" } },
      { ...TASK, intent: { ...SPEC, newValue: 7 } },
      { ...TASK, intent: { ...SPEC, rowKey: "EMP-9999" } },
      { ...TASK, intent: { ...SPEC, column: "nope" } },
      // An edit that changes nothing has no clean copy to tell apart from "edit-missing".
      { ...TASK, intent: { ...SPEC, newValue: current } },
    ];
    expect(current).toBeTruthy();
    for (const t of bad) {
      const r = proposeAgentCheck(dir, BINDING, t as never);
      expect(r.ok ? "accepted" : r.code, JSON.stringify(t)).toBe("AGENT_CHECK_TASK_INVALID");
    }
  });
});

describe("track C: the issued check and its signal cannot be re-pointed", () => {
  it(
    "the check object, its binding and its task are deeply frozen",
    () => {
      const r = proposeAgentCheck(makeCheck(honestSource()), BINDING, TASK);
      if (!r.ok) throw new Error(r.code);
      const c = r.check;
      for (const o of [c, c.binding, c.task, c.task.intent, c.provenance, c.provenance.selftest])
        expect(Object.isFrozen(o)).toBe(true);
      expect(() => {
        (c.binding as { taskId: string }).taskId = "other-task";
      }).toThrow(TypeError);
      expect(c.binding.taskId).toBe(BINDING.taskId);
    },
    T,
  );
});

describe("D3: the host read corruptions are part of the host-owned cases", () => {
  it(
    "a check that misses a byte flip is refused, over the host's corrupt-byte runs",
    () => {
      // Target-only: a flipped byte anywhere but the target cell goes unnoticed. The family's
      // own CSV cases carry no corrupt-byte document, so only track T's host corruptions
      // (three flips per case) can catch this over-claim.
      const r = proposeAgentCheck(
        makeCheck(honestSource(), { claims: [...HONEST_CLAIMS, "corrupt-byte"] }),
        BINDING,
        TASK,
      );
      expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
      if (r.ok) return;
      expect(r.reasons.join(" ")).toMatch(/corrupt-byte: \d+ of 9 corruptions verified/);
      const per = r.selftest?.perClass;
      // Per case: 3 host flips; 1 family truncation + 3 host truncations; 1 family missing
      // file + 1 host missing file. Three cases.
      expect(per?.["corrupt-byte"].runs).toBe(9);
      expect(per?.truncated.runs).toBe(12);
      expect(per?.["missing-file"].runs).toBe(6);
    },
    T,
  );
});
