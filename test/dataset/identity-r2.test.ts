/**
 * Identity strings in track U's export, the #556 round-3 failure classes (B1-B3, S1-S3) applied
 * to #559: spaced full names match their joined forms; every non-exempt closed field refuses one
 * in any case; a CRLF identity file; the 3-character floor; content-addressed names and digests
 * are exempt; hashed values are idempotent; Unicode case folding; the manifest is checked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  closeEpisode,
  fold,
  type JoinedIdentity,
  joinedIdentity,
} from "../../src/dataset/closed.ts";
import { exportDataset, validateContainer } from "../../src/dataset/export.ts";
import { identityStrings } from "../../src/dataset/hygiene.ts";
import { attempt, candidate } from "./identity-fixture.ts";

const PLANTED = ["qzplant", "user"].join("");
const planted = { identity: { user: PLANTED, host: "nohost-u" } };
const NOBODY = { identity: { user: "nobody-u", host: "nohost-u" } };
const tmp = () => mkdtempSync(join(tmpdir(), "myco-u-r2-"));

describe("B2: a spaced full name matches every joined form of it, in any case", () => {
  const full = ["Qzvfirst", " ", "Plantlast"].join("");
  const forms = [
    "QzvfirstPlantlast",
    "qzvfirst.plantlast",
    "qzvfirst_plantlast",
    "Qzvfirst-Plantlast",
    "QZVFIRSTPLANTLAST",
    "xxqzvfirstplantlast9",
  ];

  it("digested in an id, refused in a closed field, refused by validateContainer", () => {
    const b = tmp();
    try {
      const file = join(b, "identity.txt");
      writeFileSync(file, `${full}\n`);
      const hygiene = { ...NOBODY, identityFile: file };
      for (const v of forms) {
        const id = attempt(candidate({}, { taskId: v }), hygiene);
        if (id.refused === null) {
          expect(id.written.toLowerCase().includes(v.toLowerCase()), v).toBe(false);
        } else expect(id.refused.code === "LEAK", v).toBe(true);
        const closedField = attempt(
          candidate({
            task: {
              ...candidate().episode.task,
              taskSetVersion: v.replace(/[^A-Za-z0-9._-]/g, ""),
            },
          }),
          hygiene,
        );
        expect(
          closedField.refused?.code === "LEAK" && closedField.refused?.detail === "identity",
          v,
        ).toBe(true);
      }
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("B3: every non-exempt closed field refuses an identity, in upper and mixed case where its grammar allows", () => {
  const joined: JoinedIdentity[] = [["username", PLANTED]];
  const base = candidate().episode;
  // field path, how to place a value, the case variants the field's grammar admits.
  const fields: [string, (v: string) => unknown, string[]][] = [
    ["$.task.family", (v) => ({ ...base, task: { ...base.task, family: v } }), [PLANTED]],
    [
      "$.task.taskSetVersion",
      (v) => ({ ...base, task: { ...base.task, taskSetVersion: v } }),
      [PLANTED, PLANTED.toUpperCase(), "QzPlantUser"],
    ],
    ["$.task.faultClass", (v) => ({ ...base, task: { ...base.task, faultClass: v } }), [PLANTED]],
    [
      "$.gate.oracle.family",
      (v) => ({
        ...base,
        gate: { ...base.gate, oracle: { family: v, version: "1", specSha256: "c".repeat(64) } },
      }),
      [PLANTED],
    ],
    [
      "$.gate.oracle.version",
      (v) => ({
        ...base,
        gate: { ...base.gate, oracle: { family: "calc", version: v, specSha256: "c".repeat(64) } },
      }),
      [PLANTED, PLANTED.toUpperCase(), "QzPlantUser"],
    ],
    [
      "$.groundTruth.graderVersion",
      (v) => ({ ...base, groundTruth: { ...base.groundTruth, graderVersion: `${v}/1` } }),
      [PLANTED],
    ],
    [
      "$.harness.arm",
      (v) => ({ ...base, harness: { ...base.harness, arm: v } }),
      [PLANTED, `myco-gate:${PLANTED}`],
    ],
    [
      "$.harness.fault.code",
      (v) => ({
        ...base,
        outcome: "harness-fault",
        harness: { ...base.harness, fault: { class: "timeout", code: v } },
      }),
      [PLANTED.toUpperCase()],
    ],
  ];
  for (const [path, put, values] of fields)
    it(`${path}`, () => {
      for (const v of values) {
        const closed = closeEpisode(put(v) as never, joined);
        expect(
          joinedIdentity(closed, joined).some((x) => x.path === path && x.kind === "username"),
          v,
        ).toBe(true);
      }
    });

  it("at the export: a closed field refuses (LEAK, kind and path, never the value)", () => {
    for (const v of [PLANTED, PLANTED.toUpperCase(), "QzPlantUser"]) {
      const r = attempt(candidate({ task: { ...base.task, taskSetVersion: v } }), planted);
      expect(r.refused?.code === "LEAK" && r.refused?.detail === "username").toBe(true);
      expect((r.refused?.message ?? "").toLowerCase().includes(PLANTED)).toBe(false);
    }
  });
});

describe("the identity file and the floor", () => {
  it("a CRLF identity file is read line by line (no carriage return kept)", () => {
    const b = tmp();
    try {
      const file = join(b, "identity.txt");
      writeFileSync(file, "# crlf\r\nqzcrlfalias\r\nqzsecond\r\n");
      const ids = identityStrings({ ...NOBODY, identityFile: file })
        .filter(([k]) => k === "identity")
        .map(([, v]) => v);
      expect(ids).toEqual(["qzcrlfalias", "qzsecond"]);
      const r = attempt(candidate({}, { taskId: "qzcrlfalias" }), {
        ...NOBODY,
        identityFile: file,
      });
      expect(r.refused !== null || !r.written.includes("qzcrlfalias")).toBe(true);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("the floor is 3 characters: a 3-character identity is matched, a 2-character one is not", () => {
    const three: JoinedIdentity[] = [["username", "zqx"]];
    const ep = candidate({}, { taskId: "zqx-1" }).episode;
    expect(closeEpisode(ep, three).task.id).toMatch(/^h-[0-9a-f]{60}$/);
    const two: JoinedIdentity[] = [["username", "zq"]];
    expect(closeEpisode(candidate({}, { taskId: "zq-1" }).episode, two).task.id).toBe("zq-1");
  });
});

describe("S1-S3: exemptions, idempotence, case folding", () => {
  it("S1: a hex-letter identity inside a blob file name or a digest is not a false refusal", () => {
    const joined: JoinedIdentity[] = [["username", "abc"]];
    const ep = closeEpisode(candidate().episode, joined);
    const withName = {
      ...ep,
      observations: {
        ...ep.observations,
        items: ep.observations.items.map((o) =>
          "file" in o
            ? { ...o, file: `blobs/abc${"0".repeat(61)}.csv`, sha256: `abc${"0".repeat(61)}` }
            : o,
        ),
      },
    };
    expect(joinedIdentity(withName, joined)).toEqual([]);
  });

  it("S2: an already-hashed id stays as it is, even when an identity's letters occur in the hash", () => {
    const hashedId = `h-${"abcd".repeat(15)}`;
    const ep = candidate({}, { taskId: "task-1" }).episode;
    const closed = closeEpisode({ ...ep, task: { ...ep.task, id: hashedId } }, [
      ["username", "abcd"],
    ]);
    expect(closed.task.id).toBe(hashedId);
  });

  it("S3: Unicode full case folding (ß matches ss, NFKC forms match)", () => {
    expect(fold("Straße")).toBe("strasse");
    const joined: JoinedIdentity[] = [["identity", "Straße"]];
    expect(closeEpisode(candidate({}, { taskId: "STRASSE-1" }).episode, joined).task.id).toMatch(
      /^h-/,
    );
    expect(closeEpisode(candidate({}, { taskId: "strasse.x" }).episode, joined).task.id).toMatch(
      /^h-/,
    );
  });

  it("full Unicode case folding (#553): ß, ẞ and ı names match their ASCII spellings, both ways", () => {
    expect(fold("Groß")).toBe("gross");
    expect(fold("GROẞ")).toBe("gross");
    expect(fold("Yıldız")).toBe("yildiz");
    expect(fold("YILDIZ")).toBe("yildiz");
    expect(fold("İpek")).toBe("ipek");
    for (const [configured, written] of [
      ["Groß", "GROSS"],
      ["GROẞ", "gross-1"],
      ["Yıldız", "YILDIZ2"],
      ["yildiz", "xxYıldız"],
      ["Gross", "groß.x"],
      // NFKC compatibility forms in the configured identity: fullwidth letters and a ligature.
      ["Ｇｒｏß", "GROSS"],
      ["ﬁlip", "FILIP-1"],
    ] as const) {
      const joined: JoinedIdentity[] = [["identity", configured]];
      const id = closeEpisode(candidate({}, { taskId: "task-1" }).episode, joined);
      expect(id.task.id).toBe("task-1");
      const closed = closeEpisode(
        candidate({}, { taskId: written.normalize("NFKC") }).episode,
        joined,
      );
      expect(/^h-[0-9a-f]{60}$/.test(closed.task.id), `${configured} / ${written}`).toBe(true);
    }
  });
});

describe("B1 for #559: validateContainer checks the manifest's strings for an identity", () => {
  it("a hand-edited manifest exporter carrying an identity is refused, by path and kind", () => {
    const b = tmp();
    try {
      const dir = join(b, "ds");
      exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      // A joined form the word-bounded scan cannot see: only the manifest identity check finds it.
      m.exporter = `xx${PLANTED}/3`;
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      const ps = validateContainer(dir, planted);
      expect(ps).toContain("LEAK manifest.json:$.exporter username");
      expect(ps.some((p) => p.includes(PLANTED))).toBe(false);
      expect(validateContainer(dir, NOBODY)).toEqual([]);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});
