import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { leaksIn, scanForLeaks } from "../../src/dataset/hygiene.ts";
import { parseTranscript } from "../../src/desktops/transcript.ts";

describe("leak scan", () => {
  it("leaves relative paths, placeholders and ordinary text alone", () => {
    for (const text of [
      "docs/var/x",
      "<home>/doc.csv",
      "<desktop>/tmp",
      "Set record EMP-0003, column qty, to 500",
      "ratio 3/4 and a/b",
      "sk-short",
    ]) {
      expect(leaksIn(text, { hostIdentity: false }), text).toEqual([]);
    }
  });

  it("finds host paths at the start of a string and after punctuation", () => {
    const p = ["/", "var", "/", "log"].join("");
    expect(leaksIn(p, { hostIdentity: false })).toEqual(["host-path"]);
    expect(leaksIn(`path="${p}"`, { hostIdentity: false })).toEqual(["host-path"]);
    expect(leaksIn(`(${p})`, { hostIdentity: false })).toEqual(["host-path"]);
  });

  it("finds the machine's own user name when it is not a generic account", () => {
    const user = userInfo().username;
    const found = leaksIn(`written by ${user} today`);
    if (
      user.length >= 3 &&
      !["root", "user", "runner", "admin", "ubuntu", "node", "nobody"].includes(user.toLowerCase())
    ) {
      expect(found).toContain("username");
    } else {
      expect(found).not.toContain("username");
    }
  });

  it("reports a leaking key without echoing it in the path, at any depth below it", () => {
    const key = ["/", "home", "/", "gina"].join("");
    const leaks = scanForLeaks(
      { a: { [key]: { b: "x", c: "zz-nested-marker" } } },
      { hostIdentity: false, forbiddenStrings: ["zz-nested-marker"] },
    );
    expect(leaks).toEqual([
      { path: "$.a.<key>", kind: "host-path" },
      { path: "$.a.<key>.c", kind: "forbidden-string" },
    ]);
    expect(JSON.stringify(leaks)).not.toContain("gina");
  });
});

describe("transcript protocol", () => {
  it("parses steps and the claim, ignoring other lines", () => {
    const t = parseTranscript(
      [
        "noise",
        'MYCO-STEP {"tool":"open_file","input":{"path":"a.csv"},"observation":"ok"}',
        'MYCO-STEP {"tool":"save","input":{},"observation":null}',
        'MYCO-CLAIM {"done":true,"text":"Done."}',
        "",
      ].join("\n"),
    );
    expect(t).toEqual({
      ok: true,
      steps: [
        {
          index: 0,
          action: { tool: "open_file", input: { path: "a.csv" } },
          observation: { kind: "text", text: "ok" },
        },
        { index: 1, action: { tool: "save", input: {} }, observation: null },
      ],
      claim: { done: true, text: "Done." },
    });
  });

  it("no claim line means not claimed done", () => {
    expect(parseTranscript("")).toEqual({ ok: true, steps: [], claim: { done: false, text: "" } });
  });

  it.each([
    ["bad JSON", "MYCO-STEP {nope"],
    ["array body", "MYCO-STEP []"],
    ["bad tool", 'MYCO-STEP {"tool":"1x","input":{},"observation":null}'],
    ["input not an object", 'MYCO-STEP {"tool":"x","input":[],"observation":null}'],
    ["observation not text", 'MYCO-STEP {"tool":"x","input":{},"observation":3}'],
    ["claim done not boolean", 'MYCO-CLAIM {"done":"yes","text":"x"}'],
    ["two claims", 'MYCO-CLAIM {"done":true,"text":"a"}\nMYCO-CLAIM {"done":true,"text":"b"}'],
  ])("is malformed on %s (fail closed)", (_name, text) => {
    expect(parseTranscript(text).ok).toBe(false);
  });
});
