/**
 * #580 O1 on track U's container (lead ruling 02:55Z): a SINGLE WORD of a configured full name
 * (`<first>_trial`, `<Last>2`, `xx<first>`, `<first>Trial`, camelCase joins, accented and case
 * variants) is caught exactly as on the episode export and in Q bundles, through the one shared
 * rule (`src/export-guard/identity-words.ts`): digested in every id and token field (the
 * record's desktop facts included), refused (LEAK) in every other closed field, and refused by
 * `validateContainer`. Words of 1 or 2 characters are not looked for alone. O4 (unconfigured
 * names) is a documented residual; a test pins it so the docs stay true.
 *
 * Every planted value is a fake word built at run time; no value is printed (booleans compared).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeEpisode,
  closeRecordFields,
  hashed,
  joinedIdentity,
  manifestIdentity,
  openEpisodeStrings,
} from "../../src/dataset/closed.ts";
import type { Episode } from "../../src/dataset/episode.ts";
import {
  type ExportCandidate,
  exportDataset,
  validateContainer,
} from "../../src/dataset/export.ts";
import { identityStrings } from "../../src/dataset/hygiene.ts";
import { canonicalJson } from "../../src/episode/validate.ts";
import { IDENTITY_WORD_MIN_CHARS } from "../../src/export-guard/identity-words.ts";
import { attempt, candidate } from "./identity-fixture.ts";
import { makePathFuzzer, mulberry32 } from "./path-fuzz.ts";

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `myco-u-iw-${p}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The machine's own identity is switched off here; only the identity file is configured. */
const NO_HOST = { hostIdentity: false, identity: { user: "zz", host: "zz" } } as const;
const FIRST = ["Qzu", "first"].join("");
const LAST = ["Qzu", "last"].join("");
const FULL = `${FIRST} ${LAST}`;
const THREE = ["Zq", "u"].join("");
const TWO = ["Z", "x"].join("");
const ACCENTED = ["Qzujosé", "Qzureña"].join(" ");
const ASCII_NAME = ["Qzujose", "Qzurena"].join(" ");

const WORD_FORMS: readonly string[] = [
  `${FIRST.toLowerCase()}_trial`,
  `${LAST}2`,
  `xx${FIRST.toLowerCase()}`,
  `${FIRST.toLowerCase()}Trial`,
  `run${FIRST}`,
  `agent${LAST}Run`,
  FIRST.toUpperCase(),
  LAST.toLowerCase(),
  `${[...FIRST].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("")}-7`,
];

function identityFile(...lines: string[]): string {
  const p = join(tmp("id"), "identity.txt");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}
const hygieneFor = (file: string) => ({ ...NO_HOST, identityFile: file });

/** A candidate carrying `v` in every id, token and text field of its episode and record. */
function everywhere(v: string): ExportCandidate {
  const c = candidate(
    {
      task: { ...candidate().episode.task, id: v, instruction: v },
      actions: [
        { kind: "type", text: v },
        { kind: "shell", command: v },
        { kind: "key", keys: v },
        { kind: "launch", app: v },
      ],
      observations: [{ afterAction: 0, text: v }],
      plannerModelId: v,
      trialKey: v,
      simulated: true,
    },
    { taskId: v, runId: v },
  );
  return { ...c, desktop: { ...c.desktop, backend: v, image: v } };
}

function idTokenFields(ep: Episode): Array<readonly [string, unknown]> {
  const a = ep.actions.items as unknown as Array<Record<string, string>>;
  return [
    ["$.task.id", ep.task.id],
    ["$.harness.plannerModelId", ep.harness.plannerModelId],
    ["$.provenance.runId", ep.provenance.runId],
    ["$.provenance.trialKey", ep.provenance.trialKey],
    ["$.actions.items[2].keys", a[2]?.keys],
    ["$.actions.items[3].app", a[3]?.app],
  ];
}

const recordOf = (v: string) => ({
  episode: { id: "e".repeat(64) },
  desktop: { backend: v, image: v },
  capture: { path: v },
});

/** Every non-exempt closed pattern field of the mirrored episode, shaped to its grammar. */
const CLOSED_FIELDS: ReadonlyArray<readonly [string, (ep: Episode, v: string) => Episode]> = [
  ["$.task.family", (ep, v) => ({ ...ep, task: { ...ep.task, family: v.toLowerCase() } })],
  ["$.task.taskSetVersion", (ep, v) => ({ ...ep, task: { ...ep.task, taskSetVersion: v } })],
  ["$.task.faultClass", (ep, v) => ({ ...ep, task: { ...ep.task, faultClass: v.toLowerCase() } })],
  [
    "$.gate.reasonCodes[]",
    (ep, v) => ({ ...ep, gate: { ...ep.gate, reasonCodes: [`X${v.toUpperCase()}`] } }) as Episode,
  ],
  [
    "$.gate.oracle.family",
    (ep, v) =>
      ({
        ...ep,
        gate: {
          ...ep.gate,
          oracle: { family: v.toLowerCase(), version: "1", specSha256: "c".repeat(64) },
        },
      }) as Episode,
  ],
  [
    "$.gate.oracle.version",
    (ep, v) =>
      ({
        ...ep,
        gate: { ...ep.gate, oracle: { family: "calc", version: v, specSha256: "c".repeat(64) } },
      }) as Episode,
  ],
  [
    "$.groundTruth.graderVersion",
    (ep, v) =>
      ({
        ...ep,
        groundTruth: { ...ep.groundTruth, graderVersion: `${v.toLowerCase()}/1` },
      }) as Episode,
  ],
  [
    "$.harness.arm",
    (ep, v) => ({ ...ep, harness: { ...ep.harness, arm: `myco-gate:${v.toLowerCase()}` } }),
  ],
  [
    "$.harness.fault.code",
    (ep, v) =>
      ({
        ...ep,
        harness: { ...ep.harness, fault: { class: "timeout", code: v.toUpperCase() } },
      }) as Episode,
  ],
];
const closedForm = (v: string) => v.replace(/[^A-Za-z0-9]/g, "");
const anyWordIn = (text: string, words: readonly string[]) =>
  words.some((w) => text.toLowerCase().includes(w.toLowerCase()));

describe("#580 O1: a single word of a configured full name, in every id and token field", () => {
  it("the minimum word length is pinned at 3 (as Q)", () => {
    expect(IDENTITY_WORD_MIN_CHARS).toBe(3);
  });

  it("each word form is digested in every id, token and text field, and in the record", () => {
    const joined = identityStrings(hygieneFor(identityFile(FULL)));
    for (const [i, v] of WORD_FORMS.entries()) {
      const closed = closeEpisode(everywhere(v).episode, joined);
      for (const [path, out] of idTokenFields(closed))
        expect(out === hashed(v), `form ${i} ${path}`).toBe(true);
      expect(anyWordIn(canonicalJson(closed), [FIRST, LAST]), `form ${i}`).toBe(false);
      expect(joinedIdentity(closed, joined), `form ${i}`).toEqual([]);
      expect(openEpisodeStrings(closed), `form ${i}`).toEqual([]);
      const rec = closeRecordFields(recordOf(v), joined);
      expect(
        [rec.desktop.backend, rec.desktop.image, rec.capture.path].every((x) => x === hashed(v)),
        `form ${i} record`,
      ).toBe(true);
    }
  });

  it("a word of exactly 3 characters is matched; one of 2 is not looked for alone", () => {
    const joined = identityStrings(hygieneFor(identityFile(`${THREE} ${LAST}`, `${TWO} ${LAST}`)));
    for (const v of [`${THREE.toLowerCase()}_trial`, `xx${THREE}2`, `run${THREE.toUpperCase()}`])
      expect(closeEpisode(everywhere(v).episode, joined).task.id === hashed(v), "3-char").toBe(
        true,
      );
    const two = `${TWO.toLowerCase()}_trial`;
    expect(closeEpisode(everywhere(two).episode, joined).task.id === two, "2-char kept").toBe(true);
  });

  it("accented and ASCII variants of a word match both ways (accent folding applies to words)", () => {
    for (const [configured, written] of [
      [ACCENTED, "qzujose_trial"],
      [ACCENTED, "QZURENA2"],
      [ASCII_NAME, "xxQzuJosé"],
      [ASCII_NAME, "qzureñaTrial"],
    ] as const) {
      const joined = identityStrings(hygieneFor(identityFile(configured)));
      for (const [path, out] of idTokenFields(closeEpisode(everywhere(written).episode, joined)))
        expect(out === hashed(written), path).toBe(true);
    }
  });

  it("through the real export: written, digested, no word in any byte, and the container validates", () => {
    const hygiene = hygieneFor(identityFile(FULL));
    for (const [i, v] of WORD_FORMS.entries()) {
      const r = attempt(candidate({}, { taskId: v, runId: `${v}-r` }), hygiene);
      expect(r.refused === null, `form ${i} exported`).toBe(true);
      expect(anyWordIn(r.written, [FIRST, LAST]), `form ${i}`).toBe(false);
      expect(r.valid, `form ${i}`).toEqual([]);
    }
  });
});

describe("#580 O1: a single word in a closed pattern field, or a hand-edited container, refuses", () => {
  it("every non-exempt closed field refuses each word form (joinedIdentity)", () => {
    const joined = identityStrings(hygieneFor(identityFile(FULL)));
    const base = candidate().episode;
    for (const [path, put] of CLOSED_FIELDS)
      for (const [i, v] of WORD_FORMS.entries()) {
        const hits = joinedIdentity(closeEpisode(put(base, closedForm(v)), joined), joined);
        expect(
          hits.some((h) => h.path.replace(/\[\d+\]/g, "[]") === path && h.kind === "identity"),
          `${path} form ${i}`,
        ).toBe(true);
      }
  });

  it("the export refuses a word in taskSetVersion with LEAK, naming no value", () => {
    const hygiene = hygieneFor(identityFile(FULL));
    const r = attempt(
      candidate({ task: { ...candidate().episode.task, taskSetVersion: `${LAST}2` } }),
      hygiene,
    );
    expect(r.refused?.code).toBe("LEAK");
    expect(anyWordIn(r.refused?.message ?? "", [FIRST, LAST])).toBe(false);
  });

  it("validateContainer refuses a hand-edited manifest string holding one word", () => {
    const joined = identityStrings(hygieneFor(identityFile(FULL)));
    expect(
      manifestIdentity({ datasetVersion: `${FIRST.toLowerCase()}_trial` }, joined).length,
    ).toBe(1);
    const hygiene = hygieneFor(identityFile(FULL));
    const b = tmp("vc");
    const dir = join(b, "ds");
    exportDataset([candidate()], { outDir: dir, hygiene });
    expect(validateContainer(dir, hygiene)).toEqual([]);
    const p = join(dir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.exporter = `xx${LAST}`;
    writeFileSync(p, JSON.stringify(m));
    const problems = validateContainer(dir, hygiene);
    expect(problems.length > 0).toBe(true);
    expect(anyWordIn(problems.join("\n"), [FIRST, LAST])).toBe(false);
  });
});

describe("O4 residual (accepted, documented): unconfigured names are not caught", () => {
  const OTHER_HOST = ["Qzother", "MacBook", "Pro"].join("-");
  const PATH_ID = [["Us", "ers"].join(""), "qzjsmith", "Documents"].join(".");

  it("another machine's host name and a dotted path-like id with unconfigured names are kept verbatim", () => {
    const joined = identityStrings(hygieneFor(identityFile(FULL)));
    const base = candidate().episode;
    for (const v of [OTHER_HOST, PATH_ID]) {
      const closed = closeEpisode(
        { ...base, task: { ...base.task, id: v, taskSetVersion: v } },
        joined,
      );
      expect(closed.task.id === v, "kept in task.id").toBe(true);
      expect(closed.task.taskSetVersion === v, "kept in taskSetVersion").toBe(true);
      expect(joinedIdentity(closed, joined)).toEqual([]);
    }
    const configured = identityStrings(hygieneFor(identityFile("Qzother", "qzjsmith")));
    for (const v of [OTHER_HOST, PATH_ID])
      expect(
        closeEpisode({ ...base, task: { ...base.task, id: v } }, configured).task.id === hashed(v),
      ).toBe(true);
  });
});

describe("fuzz: 1,000 generated full names and paths (allowlist alone, and the full export)", () => {
  const CASES = 1000;
  function cases() {
    const next = makePathFuzzer(0x580);
    const rnd = mulberry32(0x5802);
    const out: Array<{ name: string; words: string[]; form: string; path: string }> = [];
    for (let i = 0; i < CASES; i++) {
      const f = next();
      const g = next();
      const words = [f.words[0] as string, g.words[0] as string];
      const w = words[Math.floor(rnd() * 2)] as string;
      const forms = [
        `${w.toLowerCase()}_trial`,
        `${w}2`,
        `xx${w}`,
        `${w.toLowerCase()}Trial`,
        w.toUpperCase(),
      ];
      out.push({
        name: words.join(" "),
        words,
        form: forms[i % forms.length] as string,
        path: f.value,
      });
    }
    return out;
  }

  it("OFF (closing alone): every word form digested in every id and the record; no word anywhere", () => {
    for (const [i, c] of cases().entries()) {
      const joined: Array<readonly [string, string]> = [["identity", c.name]];
      const cand = everywhere(c.form);
      const ep = { ...cand.episode, task: { ...cand.episode.task, instruction: c.path } };
      const closed = closeEpisode(ep, joined as never);
      for (const [path, out] of idTokenFields(closed))
        if (out !== hashed(c.form)) expect.fail(`case ${i}: ${path} not digested`);
      const rec = closeRecordFields(recordOf(c.form), joined as never);
      if (rec.desktop.backend !== hashed(c.form)) expect.fail(`case ${i}: record not digested`);
      if (anyWordIn(canonicalJson(closed) + canonicalJson(rec), c.words))
        expect.fail(`case ${i}: a word survived`);
    }
  });

  it("ON (the full export with its leak scan, then validateContainer): 1,000 candidates", () => {
    const all = cases();
    const hygiene = hygieneFor(identityFile(...all.map((c) => c.name)));
    const cands = all.map((c, i) => candidate({}, { taskId: c.form, runId: `${c.form}-${i}` }));
    const dir = join(tmp("fz"), "ds");
    exportDataset(cands, { outDir: dir, hygiene });
    const files = readdirSync(join(dir, "episodes"));
    expect(files.length).toBe(CASES);
    let text =
      readFileSync(join(dir, "manifest.json"), "utf8") +
      readFileSync(join(dir, "records.jsonl"), "utf8");
    for (const f of files) text += readFileSync(join(dir, "episodes", f), "utf8");
    for (const [i, c] of all.entries())
      if (anyWordIn(text, c.words)) expect.fail(`case ${i}: a word survived`);
    expect(validateContainer(dir, hygiene)).toEqual([]);
  }, 120_000);
});
