/**
 * Track C, round 3 of #590 (D1 of the round-2 verdict): the bound task's self-test documents
 * cannot be computed in advance by the check's author.
 *
 * Round 2 built the bound task's case from its own intent, but every corruption of it was a
 * fixed function of that intent (wrong value = newValue + "9", wrong target = the next column,
 * collateral = "Collateral Edit" on the first other row, truncation at 0.5, host truncations
 * and flips at fixed offsets). The author knows the intent, so a check could recognise every
 * self-test document by content and lie on anything else. The verifier's two checks:
 *  - A1: on the task's own seed, honest only on the clean copy and its 13 precomputed corruptions;
 *    `verified` on any other document;
 *  - A2: on the task's own seed, `verified` whenever the target holds a value no self-test
 *    document holds (only `4242`, `255` and `42429` appear).
 * Both were accepted and then said `verified` to a real wrong document. The corruptions are now
 * drawn per proposal from host-side randomness (`node:crypto`), three bound-task cases each
 * drawn afresh, and the host read corruptions use random offsets.
 *
 * What remains (docs §5): a check can still lie on a document unlike anything the self-test
 * draws. The signal stays advisory and is refused as evidence.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  agentCheckRegisterOptions,
  agentCheckSelfTestCases,
  proposeAgentCheck,
} from "../../src/agent-checks/check.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { calcCasesFor } from "../../src/oracle-selftest/subjects.ts";
import type {
  CorruptionClass,
  SavedDocument,
  SelfTestCase,
} from "../../src/oracle-selftest/types.ts";
import {
  hostCorruptions,
  registerPlugin,
  runPluginOracle,
} from "../../src/plugins/host/registry.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  BINDING,
  cleanupPlugins,
  csvDoc,
  honestSource,
  INTENT,
  makeCheck,
  SEED,
  SPEC,
  TASK,
} from "./helpers.ts";

afterAll(cleanupPlugins);

const T = 180_000;
const LGTM = 'return { status: "verified", code: "LGTM" };';
const OWN = 3;

/** The round-2 self-test of the bound task: every document computable from the intent. */
const fixed = calcCasesFor([SPEC], TASK.fileName)[0] as SelfTestCase<unknown>;
const fixedDocs: SavedDocument[] = [
  fixed.correct,
  ...fixed.corruptions.map((x) => x.doc),
  ...hostCorruptions(fixed.correct).map((x) => x.doc),
];

const FNV = `const fnv = (b) => { let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; } return h; };`;
function fnv(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const x of b) {
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A1: the precomputed documents embedded (as hashes); `verified` on anything else. */
const A1 = honestSource({
  prelude: `${FNV}
    const KNOWN = ${JSON.stringify(fixedDocs.flatMap((d) => (d.bytes === null ? [] : [fnv(d.bytes)])))};
    if (intent.fixtureSeed === ${JSON.stringify(SEED)} && doc.bytes !== null && !KNOWN.includes(fnv(doc.bytes))) ${LGTM}`,
});

/** A2: no embedded documents; `verified` whenever the target holds a value no self-test held. */
const fixture = generateFixture(SEED);
const original = fixture.rows.find((r) => r[0] === SPEC.rowKey)?.[
  fixture.header.indexOf(SPEC.column)
] as string;
const HELD = [SPEC.newValue, original, `${SPEC.newValue}9`];
const A2 = honestSource({
  prelude: `if (intent.fixtureSeed === ${JSON.stringify(SEED)} && doc.bytes !== null) {
      const rs = dec(doc.bytes).trimEnd().split("\\n").map((l) => l.split(","));
      const c = rs[0].indexOf(intent.column);
      const r = rs.find((x, i) => i > 0 && x[0] === intent.rowKey);
      if (r !== undefined && c >= 1 && !${JSON.stringify(HELD)}.includes(r[c])) ${LGTM}
    }`,
});

/** A real wrong document of the bound task: the target set to 1 instead of 4242. */
const wrongDoc = csvDoc(documentCsv(SEED, [{ ...INTENT, newValue: "1" }]));

describe("D1 round 3: a check that computes the bound task's self-test in advance is refused", () => {
  it("the checks' premise: the round-2 values are what A2 expects", () => {
    expect(original).toBe("255");
    expect(HELD).toEqual(["4242", "255", "42429"]);
    // The clean copy and its 13 corruptions (6 family, 7 host).
    expect(fixedDocs.length).toBe(14);
  });

  for (const [name, source] of Object.entries({ A1, A2 })) {
    it(
      `${name}: accepted by the round-2 (fixed) self-test and lies on a real wrong document; refused now`,
      () => {
        // Control: the round-2 self-test (the fixed bound case, random other cases, fixed host
        // offsets) accepts it, and it then says "verified" to a real wrong document.
        const random = agentCheckSelfTestCases("calc-record-edit", TASK).slice(OWN);
        const old = registerPlugin(makeCheck(source), { hostCases: [fixed, ...random] });
        if (!old.ok) throw new Error(`${old.code} ${old.reasons.join("; ")}`);
        const lie = runPluginOracle(old.registration, wrongDoc, SPEC);
        expect([lie.status, lie.code]).toEqual(["verified", "LGTM"]);
        // Now: R5 over drawn corruptions refuses it before anything relies on it.
        const r = proposeAgentCheck(makeCheck(source), BINDING, TASK);
        expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
      },
      T,
    );
  }
});

const hex = (d: SavedDocument) =>
  d.bytes === null ? "null" : Buffer.from(d.bytes).toString("hex");
const docOf = (c: SelfTestCase<unknown>, cls: CorruptionClass) =>
  c.corruptions.find((x) => x.cls === cls)?.doc as SavedDocument;
const DRAWN: CorruptionClass[] = ["wrong-value", "wrong-target", "collateral", "truncated"];

describe("D1 round 3: every corruption of the bound task is drawn, not fixed", () => {
  const proposals = Array.from({ length: 4 }, () =>
    agentCheckSelfTestCases("calc-record-edit", TASK).slice(0, OWN),
  );
  const own = proposals.flat();

  it("three bound-task cases per proposal, each with its own draw", () => {
    for (const p of proposals) {
      expect(p.length).toBe(OWN);
      for (const c of p) expect([c.intent, c.correct.fileName]).toEqual([SPEC, TASK.fileName]);
      // Drawn afresh per case: the three cases of one proposal are not one draw reused.
      const keys = p.map((c) => DRAWN.map((cls) => hex(docOf(c, cls))).join("|"));
      expect(new Set(keys).size).toBeGreaterThan(1);
    }
  });

  it("V1 (#610 item 2): EACH bound-task case is drawn, none left on the fixed path", () => {
    // A case on the fixed path holds the round-2 document in every drawn class at once, and
    // none of the wider corruptions (those exist only with a draw).
    for (const c of own) {
      const allFixed = DRAWN.every((cls) => hex(docOf(c, cls)) === hex(docOf(fixed, cls)));
      expect(allFixed, c.id).toBe(false);
      expect(c.corruptions.length, c.id).toBeGreaterThan(fixed.corruptions.length);
    }
  });

  it("V5 (#610 item 2): the drawn wrong values spread over value kinds, not one numeric shift", () => {
    // With a numeric new value (4242), a draw stuck on "move the number by up to 10,000" gives
    // only numbers in [-5758, 14242]; the honest draw also edits characters, draws words and
    // copies other cells.
    const values = Array.from({ length: 20 }, () =>
      agentCheckSelfTestCases("calc-record-edit", TASK),
    )
      .flatMap((p) => p.slice(0, OWN))
      .map((c) => {
        const rs = Buffer.from(docOf(c, "wrong-value").bytes as Uint8Array)
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((l) => l.split(","));
        return rs.find((r, i) => i > 0 && r[0] === SPEC.rowKey)?.[
          rs[0]?.indexOf(SPEC.column) ?? -1
        ];
      }) as string[];
    const shifted = (v: string) => /^-?\d+$/.test(v) && Math.abs(Number(v) - 4242) <= 10_000;
    expect(values.length).toBe(60);
    expect(values.every(shifted)).toBe(false);
    expect(values.filter((v) => !/^-?\d+$/.test(v)).length).toBeGreaterThan(0);
  });

  for (const cls of DRAWN) {
    it(`${cls}: varies across draws and is not the fixed round-2 document`, () => {
      const docs = own.map((c) => hex(docOf(c, cls)));
      expect(new Set(docs).size).toBeGreaterThan(1);
      expect(docs.every((d) => d === hex(docOf(fixed, cls)))).toBe(false);
    });
  }

  it("edit-missing and missing-file stay what they are; the drawn documents stay corrupt", () => {
    const correct = hex(fixed.correct);
    for (const c of own) {
      expect(hex(c.correct)).toBe(correct);
      expect(hex(docOf(c, "edit-missing"))).toBe(hex(docOf(fixed, "edit-missing")));
      expect(docOf(c, "missing-file").bytes).toBeNull();
      for (const cls of DRAWN) expect(hex(docOf(c, cls)), cls).not.toBe(correct);
      // The target holds the wrong value; the right value lands elsewhere; collateral keeps the
      // edit. Read through the same split the honest check uses.
      const cell = (d: SavedDocument) => {
        const rs = Buffer.from(d.bytes as Uint8Array)
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((l) => l.split(","));
        return rs.find((r, i) => i > 0 && r[0] === SPEC.rowKey)?.[
          rs[0]?.indexOf(SPEC.column) ?? -1
        ];
      };
      expect(cell(docOf(c, "wrong-value"))).not.toBe(SPEC.newValue);
      expect(cell(docOf(c, "wrong-value"))).not.toBe(original);
      expect(cell(docOf(c, "wrong-target"))).toBe(original);
      expect(cell(docOf(c, "collateral"))).toBe(SPEC.newValue);
      const cut = docOf(c, "truncated").bytes as Uint8Array;
      expect(cut.length).toBeGreaterThan(0);
      expect(cut.length).toBeLessThan((fixed.correct.bytes as Uint8Array).length);
    }
  });

  it("the host read corruptions of a proposal use random offsets", () => {
    const opts = agentCheckRegisterOptions("calc-record-edit", TASK);
    expect(typeof opts.draw).toBe("function");
    const offsets = (draw?: (n: number) => number) =>
      hostCorruptions(fixed.correct, draw)
        .map((x) => `${x.cls}:${hex(x.doc)}`)
        .join("|");
    const fixedHost = offsets();
    // Without a draw the offsets stay fixed (track T's own plugins, the public R5 report).
    expect(offsets()).toBe(fixedHost);
    const drawn = Array.from({ length: 6 }, () => offsets(opts.draw));
    expect(new Set(drawn).size).toBeGreaterThan(1);
    expect(drawn.includes(fixedHost)).toBe(false);
  });

  it("V2 (#610 item 2): the host byte-flip offsets are drawn too, not only the truncations", () => {
    const opts = agentCheckRegisterOptions("calc-record-edit", TASK);
    const flips = (draw?: (n: number) => number) =>
      hostCorruptions(fixed.correct, draw)
        .filter((x) => x.cls === "corrupt-byte")
        .map((x) => hex(x.doc))
        .sort()
        .join("|");
    const fixedFlips = flips();
    expect(fixedFlips.split("|").length).toBe(3);
    const drawn = Array.from({ length: 6 }, () => flips(opts.draw));
    expect(new Set(drawn).size).toBeGreaterThan(1);
    expect(drawn.includes(fixedFlips)).toBe(false);
  });

  it("a broken random source fails closed, promptly, instead of looping forever", () => {
    const stuck = () => 0;
    const started = Date.now();
    expect(() => calcCasesFor([SPEC], TASK.fileName, stuck)).toThrow(/no usable draw/);
    expect(() => hostCorruptions(fixed.correct, stuck)).toThrow(/no usable draw/);
    const reg = registerPlugin(makeCheck(honestSource()), { hostCases: [fixed], draw: stuck });
    expect(reg.ok ? "accepted" : reg.code).toBe("SELFTEST_CASES_INVALID");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it(
    "the registration applies the proposal's draw: the check sees random host truncations",
    () => {
      // A probe that reports each document's length in its code (verified only when the target
      // holds the new value and the file ends with a newline).
      const probe = `export default { async oracle(doc, intent) {
        if (doc.bytes === null) return { status: "uncertain", code: "FILE_MISSING" };
        const text = new TextDecoder().decode(doc.bytes);
        const rows = text.trimEnd().split("\\n").map((l) => l.split(","));
        const col = rows[0].indexOf(intent.column);
        const row = rows.find((r, i) => i > 0 && r[0] === intent.rowKey);
        const ok = col >= 1 && row !== undefined && row[col] === intent.newValue && text.endsWith("\\n");
        return { status: ok ? "verified" : "uncertain", code: "L" + doc.bytes.length };
      } };`;
      const reg = registerPlugin(
        makeCheck(probe, { claims: ["missing-file"] }),
        agentCheckRegisterOptions("calc-record-edit", TASK),
      );
      if (!reg.ok) throw new Error(`${reg.code} ${reg.reasons.join("; ")}`);
      const n = (fixed.correct.bytes as Uint8Array).length;
      const fixedCuts = [n - 1, Math.floor(n / 2), Math.floor(n / 4)];
      const ownIds = ["case-1", "case-2", "case-3"];
      const perCase = ownIds.map((id) =>
        reg.registration.selftestRows
          .filter((r) => r.caseId === id && r.cls === "truncated")
          .map((r) => Number(r.code.slice(1))),
      );
      for (const cuts of perCase) expect(cuts.length).toBe(4);
      // With fixed host offsets every case would hold all three fixed cuts.
      expect(perCase.every((cuts) => fixedCuts.every((k) => cuts.includes(k)))).toBe(false);
    },
    T,
  );
});
