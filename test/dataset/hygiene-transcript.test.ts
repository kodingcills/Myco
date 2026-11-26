/**
 * Track U leak scan (src/dataset/hygiene.ts) and the interim step protocol
 * (src/desktops/transcript.ts). One test per bypass the round-1 verifier found (D1) and per
 * encoding the shared root cause named; identity is injected so the username and hostname
 * scans run on every machine (D2). Markers are built at runtime (`j(...)`) so this file
 * never matches the repo's own home-path and secret scanners.
 */
import { describe, expect, it } from "vitest";
import { decodedForms, leaksIn, scanForLeaks } from "../../src/dataset/hygiene.ts";
import { parseTranscript } from "../../src/desktops/transcript.ts";

const j = (...parts: string[]) => parts.join("");
const NO_ID = { hostIdentity: false } as const;
const ID = { identity: { user: "zelda", host: "mallow-box.lan" } } as const;
const S = "/";
const BS = "\\";

describe("leak scan: what stays clean", () => {
  it.each([
    "docs/var/x",
    "<home>/doc.csv",
    "<desktop>/tmp",
    "<home>/tmp/x",
    "Set record EMP-0003, column qty, to 500",
    "ratio 3/4 and a/b",
    "open file: doc.csv",
    "sk-short",
    "approx ~5 rows",
    "http://example.com/a/b",
  ])("%s", (text) => {
    expect(leaksIn(text, NO_ID)).toEqual([]);
    expect(leaksIn(text, ID)).toEqual([]);
  });
});

describe("leak scan: host paths, one test per bypass", () => {
  const home = j(S, "home", S, "alice", S, "x");
  const cases: Array<[string, string]> = [
    // D1: the leading-character-class bypass.
    ["after <", `cat <${home}`],
    ["after >", `2>${home}`],
    ["after -", `-f${home}`],
    ["after .", `a.b${home}`],
    ["shell redirect in an action", `sort fixture.csv >${j(S, "home", S, "alice", S, "out.csv")}`],
    ["after a placeholder", `<home>${home}`],
    ["after a letter (home root mid-token)", `x${j(S, "Users", S, "bob")}`],
    // D1: missing roots.
    ["/scratch", j(S, "scratch", S, "u1", S, "x")],
    ["/Library", j(S, "Library", S, "Caches")],
    ["/dev", `2>${j(S, "dev", S, "null")}`],
    ["/sys", j(S, "sys", S, "class")],
    ["lowercase /users (case-insensitive file systems)", j(S, "users", S, "bob")],
    // Shared root cause: encodings.
    ["JSON-escaped slashes", j(BS, S, "Users", BS, S, "x", BS, S, "doc")],
    ["JSON unicode-escaped slashes", j(BS, "u002F", "home", BS, "u002F", "alice")],
    ["percent-encoded", j("%2F", "home", "%2F", "alice")],
    ["double percent-encoded", j("%252F", "home", "%252F", "alice")],
    ["HTML-entity encoded", j("&#47;", "home", "&#47;", "alice")],
    ["Windows backslash drive path", j("C:", BS, "Users", BS, "erin")],
    ["Windows JSON-escaped drive path", j("C:", BS, BS, "Users", BS, BS, "erin")],
    ["Windows forward-slash drive path", j("C:", S, "Users", S, "erin")],
    ["Windows home without a drive", j(BS, "Users", BS, "erin", BS, "x")],
    ["UNC path", j(BS, BS, "fileserver", BS, "share")],
    ["file URL", j("file:", S, S, "srv/share")],
    ["percent-encoded file URL", j("file:", "%2F%2F", "srv")],
    ["home-relative ~/", j("see ", "~", S, ".config")],
    ["home-relative ~user/", j("~", "alice", S, "notes")],
    ["home-relative ~\\", j("~", BS, "AppData")],
    ["$HOME", j("$", "HOME", S, "x")],
    ["braced HOME", j("$", "{HOME}", S, "x")],
    ["%USERPROFILE%", j("%", "USERPROFILE", "%", BS, "x")],
  ];
  it.each(cases)("%s is a host path", (_name, text) => {
    expect(leaksIn(text, NO_ID)).toContain("host-path");
  });

  it("decodes up to three rounds and never throws on malformed escapes", () => {
    expect(decodedForms("%E0%A4%A")).toContain("%E0%A4%A");
    expect(decodedForms(j("%25252F", "home")).at(-1)).toBe(j(S, "home"));
  });
});

describe("leak scan: username and hostname (injected identity, D2)", () => {
  it.each([
    ["plain", "written by zelda today", "username"],
    ["any case", "written by Zelda today", "username"],
    ["percent-encoded", "by %7Aelda today", "username"],
    ["JSON-escaped", j("by ", BS, "u007Aelda today"), "username"],
    ["hostname", "ran on mallow-box today", "hostname"],
    ["hostname in a URL", "http://mallow-box:8080/", "hostname"],
  ])("finds the %s form", (_name, text, kind) => {
    expect(leaksIn(text, ID)).toContain(kind);
    expect(leaksIn(text, NO_ID)).not.toContain(kind);
  });

  it("does not match inside a longer word, nor generic or too-short names", () => {
    expect(leaksIn("zeldas and mallow-boxes", ID)).toEqual([]);
    expect(leaksIn("runner on vm", { identity: { user: "runner", host: "vm" } })).toEqual([]);
    expect(leaksIn("localhost", { identity: { user: "ab", host: "localhost" } })).toEqual([]);
  });

  it("defaults to this machine's identity when none is injected", () => {
    // Whatever this machine is called, a generic text stays clean under the default.
    expect(leaksIn("Set record EMP-0003, column qty, to 500")).toEqual([]);
  });
});

describe("leak scan: secrets and operator strings in any encoding", () => {
  it("finds a percent-encoded secret shape and an encoded operator marker", () => {
    const key = j("sk", "%2D", "ant", "%2D", "api03", "%2D", "Z".repeat(20));
    expect(leaksIn(key, NO_ID)).toContain("secret-shaped");
    const opts = { ...NO_ID, forbiddenStrings: ["zz-op-marker"] };
    expect(leaksIn("note zz%2Dop%2Dmarker", opts)).toContain("forbidden-string");
  });

  it("reports a leaking key without echoing it in the path, at any depth below it", () => {
    const key = j(S, "home", S, "gina");
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

describe("transcript protocol (interim stand-in for the episode recorder)", () => {
  it("parses episode actions, status observations and the claim, ignoring other lines", () => {
    const t = parseTranscript(
      [
        "noise",
        'MYCO-STEP {"action":{"kind":"launch","app":"localc a.csv"},"observation":"ok"}',
        'MYCO-STEP {"action":{"kind":"key","keys":"ctrl+s"},"observation":null}',
        'MYCO-CLAIM {"done":true,"text":"Done."}',
        "",
      ].join("\n"),
    );
    expect(t).toEqual({
      ok: true,
      actions: [
        { kind: "launch", app: "localc a.csv" },
        { kind: "key", keys: "ctrl+s" },
      ],
      observations: [{ afterAction: 0, text: "ok" }],
      withheld: 0,
      agentClaim: "done",
      claimText: "Done.",
    });
  });

  it("no claim line means no-claim; done:false means not-done", () => {
    expect(parseTranscript("")).toMatchObject({ ok: true, agentClaim: "no-claim", claimText: "" });
    expect(parseTranscript('MYCO-CLAIM {"done":false,"text":"x"}')).toMatchObject({
      agentClaim: "not-done",
    });
  });

  it("withholds (counts, never truncates) status text longer than an episode allows", () => {
    const long = "y".repeat(201);
    const t = parseTranscript(
      `MYCO-STEP ${JSON.stringify({ action: { kind: "observe" }, observation: long })}`,
    );
    expect(t).toMatchObject({ ok: true, observations: [], withheld: 1 });
  });

  it.each([
    ["bad JSON", "MYCO-STEP {nope"],
    ["array body", "MYCO-STEP []"],
    ["unknown action kind", 'MYCO-STEP {"action":{"kind":"open_file"},"observation":null}'],
    ["extra action field", 'MYCO-STEP {"action":{"kind":"observe","path":"x"},"observation":null}'],
    [
      "action sets its own seq",
      'MYCO-STEP {"action":{"kind":"observe","seq":3},"observation":null}',
    ],
    ["extra step field", 'MYCO-STEP {"action":{"kind":"observe"},"observation":null,"env":{}}'],
    ["action not an object", 'MYCO-STEP {"action":[],"observation":null}'],
    ["observation not text", 'MYCO-STEP {"action":{"kind":"observe"},"observation":3}'],
    ["claim done not boolean", 'MYCO-CLAIM {"done":"yes","text":"x"}'],
    ["two claims", 'MYCO-CLAIM {"done":true,"text":"a"}\nMYCO-CLAIM {"done":true,"text":"b"}'],
  ])("is malformed on %s (fail closed)", (_name, text) => {
    expect(parseTranscript(text).ok).toBe(false);
  });
});
