/**
 * Track T (#617): the independent grader entry `ledger-csv/1`. It passes only the pristine
 * ledger with the one target field changed, fails every other document (collateral edits and
 * flipped bytes in other rows included, which the example plugin's oracle does not check),
 * never passes an invalid-target intent, and says `ungradable` only when it could not look.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  selftestCases as pluginCases,
  verifyLedger,
} from "../../examples/plugins/csv-ledger/plugin.ts";
import {
  gradeLedger,
  LEDGER_GRADER_VERSION,
  type LedgerIntent,
} from "../../src/benchmark/grade/ledger.ts";
import { gradeRow } from "../../src/benchmark/grade/row.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// Written here by hand, not with the plugin's renderer: the grader's tests share no fixture
// code with the plugin either.
const PRISTINE =
  "id,payee,amount,category\n" +
  "1,Rent,900,home\n" +
  "2,Grocer,455,food\n" +
  "3,Utility,120,bills\n" +
  "4,Transit,35,travel\n" +
  "#rows,4\n";
const INTENT: LedgerIntent = { id: "2", column: "amount", value: "460" };
const EDITED = PRISTINE.replace("2,Grocer,455,food", "2,Grocer,460,food");

function grade(
  persisted: string | Uint8Array | null,
  intent: LedgerIntent = INTENT,
  fixture = PRISTINE,
) {
  const f = enc(fixture);
  return gradeLedger({
    fixture: f,
    fixtureSha256: sha(f),
    persisted: typeof persisted === "string" ? enc(persisted) : persisted,
    intent,
  });
}

describe("ledger-csv/1: pass", () => {
  it("passes the pristine ledger with exactly the target field changed", () => {
    const r = grade(EDITED);
    expect(r).toMatchObject({
      graderVersion: LEDGER_GRADER_VERSION,
      status: "pass",
      reasons: [],
      target: "C3",
      targetSatisfied: true,
      mismatchCount: 0,
      persistedSha256: sha(enc(EDITED)),
    });
    expect(LEDGER_GRADER_VERSION).toBe("ledger-csv/1");
  });

  it("its result is a grade row like the false-completion grader's", () => {
    expect(gradeRow("trial-1", "byoa-ledger-v1/t01", grade(EDITED))).toMatchObject({
      schema: "myco.benchmark.grade-row/1",
      graderVersion: "ledger-csv/1",
      status: "pass",
      target: "C3",
    });
  });

  it("tolerates a byte order mark and uniform CRLF, and records both", () => {
    const r = grade(`﻿${EDITED.replace(/\n/g, "\r\n")}`);
    expect(r.status).toBe("pass");
    expect(r.reasons).toEqual(["tolerated: byte order mark", "tolerated: CRLF line endings"]);
  });

  it("an empty target value is a value like any other", () => {
    const r = grade(PRISTINE.replace("2,Grocer,455,food", "2,Grocer,,food"), {
      ...INTENT,
      value: "",
    });
    expect(r.status).toBe("pass");
  });
});

describe("ledger-csv/1: fail (the document is not the expected one)", () => {
  const cases: [string, string, Partial<{ targetSatisfied: boolean; mismatchCount: number }>][] = [
    ["edit missing (unchanged)", PRISTINE, { targetSatisfied: false, mismatchCount: 1 }],
    ["wrong value", EDITED.replace("460", "4600"), { targetSatisfied: false }],
    [
      "numerically equal but not the text",
      EDITED.replace("460", "460.0"),
      { targetSatisfied: false },
    ],
    [
      "wrong target (the neighbour row)",
      PRISTINE.replace("3,Utility,120,bills", "3,Utility,460,bills"),
      { targetSatisfied: false, mismatchCount: 2 },
    ],
    [
      "collateral: the target right, another field changed",
      EDITED.replace("4,Transit,35,travel", "4,Transit,36,travel"),
      { targetSatisfied: true, mismatchCount: 1 },
    ],
    [
      "corrupt byte in another row",
      EDITED.replace("Utility", "Utilitz"),
      { targetSatisfied: true, mismatchCount: 1 },
    ],
    [
      "an extra row, trailer updated",
      EDITED.replace("#rows,4", "5,Bakery,10,food\n#rows,5"),
      { targetSatisfied: true },
    ],
    [
      "a deleted row, trailer updated",
      EDITED.replace("4,Transit,35,travel\n", "").replace("#rows,4", "#rows,3"),
      { targetSatisfied: true },
    ],
    [
      "rows reordered",
      EDITED.replace("1,Rent,900,home\n2,Grocer,460,food", "2,Grocer,460,food\n1,Rent,900,home"),
      { targetSatisfied: true },
    ],
    ["trailing space on the target line", EDITED.replace("460,food", "460,food "), {}],
  ];
  it.each(cases)("%s", (_name, doc, extra) => {
    const r = grade(doc);
    expect(r.status).toBe("fail");
    expect(r).toMatchObject(extra);
  });

  it("collateral is reported apart from the target", () => {
    const r = grade(EDITED.replace("4,Transit,35,travel", "4,Transit,36,travel"));
    expect(r.mismatches).toEqual([{ cell: "C5", expected: '"35"', actual: '"36"', target: false }]);
    expect(r.reasons).toEqual([
      "1 field(s) or line(s) other than the target differ from the fixture",
    ]);
  });

  const broken: [string, string | Uint8Array][] = [
    ["truncated before the trailer", EDITED.slice(0, EDITED.indexOf("#rows"))],
    ["no final newline", EDITED.slice(0, -1)],
    ["trailer count wrong", EDITED.replace("#rows,4", "#rows,5")],
    ["a ragged row", EDITED.replace("3,Utility,120,bills", "3,Utility,120")],
    ["mixed line endings", EDITED.replace("1,Rent,900,home\n", "1,Rent,900,home\r\n")],
    ["a bare CR", EDITED.replace("Rent", "Re\rnt")],
    ["a quoted field", EDITED.replace("Rent", '"Rent"')],
    ["not UTF-8", new Uint8Array([...enc(EDITED.slice(0, 10)), 0xff, ...enc(EDITED.slice(10))])],
    ["empty", ""],
  ];
  it.each(broken)("a broken document is a fail, not ungradable: %s", (_name, doc) => {
    const r = grade(doc);
    expect(r.status).toBe("fail");
    expect(r.targetSatisfied).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/not a well-formed ledger/);
  });
});

describe("ledger-csv/1: invalid-target intents never pass", () => {
  const invalid: [string, LedgerIntent][] = [
    ["an id the fixture does not have", { id: "9", column: "amount", value: "460" }],
    ["a column the fixture does not have", { id: "2", column: "memo", value: "x" }],
    ["the id column itself", { id: "2", column: "id", value: "7" }],
  ];
  it.each(invalid)("%s: fail, untouched or not", (_name, intent) => {
    for (const doc of [PRISTINE, EDITED]) {
      const r = grade(doc, intent);
      expect(r.status).toBe("fail");
      expect(r.target).toBeNull();
      expect(r.targetSatisfied).toBeNull();
      expect(r.reasons[0]).toMatch(/^intent unsatisfiable: /);
    }
  });
});

describe("ledger-csv/1: ungradable only when it could not look", () => {
  it("the document was not captured", () => {
    expect(grade(null)).toMatchObject({
      status: "ungradable",
      reasons: ["persisted document was not captured"],
      persistedSha256: null,
    });
  });

  it("the fixture is not the pinned one", () => {
    const f = enc(PRISTINE);
    const r = gradeLedger({
      fixture: f,
      fixtureSha256: sha(enc(EDITED)),
      persisted: enc(EDITED),
      intent: INTENT,
    });
    expect(r).toMatchObject({
      status: "ungradable",
      reasons: ["fixture bytes do not match the declared SHA-256"],
    });
  });

  it.each([
    ["not a ledger", "hello\n"],
    ["CRLF (the fixture is canonical)", PRISTINE.replace(/\n/g, "\r\n")],
    ["a byte order mark", `﻿${PRISTINE}`],
  ])("the fixture is %s", (_name, fixture) => {
    const r = grade(EDITED, INTENT, fixture);
    expect(r.status).toBe("ungradable");
    expect(r.reasons[0]).toMatch(/^pristine fixture is not a ledger: /);
  });

  it("the fixture is ambiguous for the intent (duplicate id)", () => {
    const dup = PRISTINE.replace("3,Utility", "2,Utility");
    expect(grade(dup, INTENT, dup).status).toBe("ungradable");
  });

  it("the intent value cannot be written in the format", () => {
    for (const value of ["4,60", 'say "hi"', "a\nb"])
      expect(grade(EDITED, { ...INTENT, value }).status).toBe("ungradable");
  });

  it("an internal error costs one trial, never the batch (fail closed)", () => {
    const hostile = {
      id: "2",
      column: "amount",
      get value(): string {
        throw new Error("boom");
      },
    };
    expect(grade(EDITED, hostile)).toMatchObject({
      status: "ungradable",
      reasons: ["grader error (Error): boom"],
    });
  });
});

/**
 * The grader against the example plugin's own R5 cases (read here as data; the grader never
 * imports them). Every correct save passes, every corruption the plugin claims fails, and a
 * missing file is ungradable. Then the trials T-oracle exists for: a collateral edit and a
 * flipped byte in another row, which the plugin's target-only oracle verifies and this grader
 * fails.
 */
describe("ledger-csv/1 against the csv-ledger plugin's cases", () => {
  for (const c of pluginCases()) {
    const fixtureBytes = c.corruptions.find((x) => x.cls === "edit-missing")?.doc
      .bytes as Uint8Array;
    const g = (persisted: Uint8Array | null) =>
      gradeLedger({
        fixture: fixtureBytes,
        fixtureSha256: sha(fixtureBytes),
        persisted,
        intent: c.intent,
      });

    it(`${c.id}: the correct save passes and each claimed corruption does not`, () => {
      expect(g(c.correct.bytes).status).toBe("pass");
      for (const x of c.corruptions)
        expect(g(x.doc.bytes).status, x.cls).toBe(x.doc.bytes === null ? "ungradable" : "fail");
    });

    it(`${c.id}: collateral and a flipped byte elsewhere: the plugin verifies, the grader fails`, () => {
      const text = new TextDecoder().decode(c.correct.bytes as Uint8Array);
      const lines = text.split("\n");
      const other = Number(c.intent.id) === 1 ? 2 : 1; // a data line that is not the target row
      const collateral = lines
        .map((l, i) => (i === other ? l.replace(/,([^,]*)$/, ",zzz") : l))
        .join("\n");
      const flipped = lines
        .map((l, i) => (i === other ? l.replace(/^(\d+,)./, "$1~") : l))
        .join("\n");
      for (const doc of [collateral, flipped]) {
        const doc_ = { fileName: c.correct.fileName, bytes: enc(doc) };
        expect(verifyLedger(doc_, c.intent).status).toBe("verified");
        const r = g(doc_.bytes);
        expect(r.status).toBe("fail");
        expect(r.targetSatisfied).toBe(true);
      }
    });
  }
});
