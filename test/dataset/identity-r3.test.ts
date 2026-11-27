/**
 * #559 round 3 (round-2 verdict, comment 7205416504): B1, a refusal never echoes a foreign key;
 * B2, the #560 account floor (X7) and strict `h-` idempotence for key and app names (F1d); the
 * one hashed form `h-<60 hex>` (lead ruling 23:06Z); and the should-pins V22 (unknown exclusion
 * code), V7 (a FIFO is NOT_REGULAR) and V2 (VALIDATOR_ERROR). Every planted value is synthetic.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetManifestSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  closeEpisode,
  closeRecordFields,
  HASHED,
  hashed,
  type JoinedIdentity,
  manifestIdentity,
  openEpisodeStrings,
  openRecordStrings,
} from "../../src/dataset/closed.ts";
import { EXCLUSION_CODES, exportDataset, validateContainer } from "../../src/dataset/export.ts";
import type { HygieneOptions } from "../../src/dataset/hygiene.ts";
import { attempt, candidate } from "./identity-fixture.ts";

const PLANTED = ["qzv", "planted"].join("");
const NOBODY = { identity: { user: "nobody-u", host: "nohost-u" } };
const planted = { identity: { user: PLANTED, host: "nohost-u" } };
const USER_PATH_KEY = ["C:\\Users\\", "Jo Smith", "\\doc"].join("");
const tmp = () => mkdtempSync(join(tmpdir(), "myco-u-r3-"));

/** Export one clean candidate, edit its manifest, and return the container's problems. */
function editedManifest(
  edit: (m: { counts: { excluded: Record<string, unknown> } }) => void,
  hygiene: HygieneOptions = planted,
) {
  const b = tmp();
  try {
    const dir = join(b, "ds");
    exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    edit(m);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    return validateContainer(dir, hygiene);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
}

const echoes = (ps: readonly string[], ...values: string[]) =>
  ps.some((p) => values.some((v) => p.toLowerCase().includes(v.toLowerCase())));

describe("B1: a problem's location never echoes a foreign key", () => {
  it("the verifier's two planted manifests are refused without echoing the key", () => {
    const joinedKey = editedManifest((m) => {
      m.counts.excluded = { [`${PLANTED}2`]: PLANTED };
    });
    expect(joinedKey.length).toBeGreaterThan(0);
    expect(echoes(joinedKey, PLANTED)).toBe(false);
    const pathKey = editedManifest((m) => {
      m.counts.excluded = { [USER_PATH_KEY]: { x: PLANTED } };
    });
    expect(pathKey.length).toBeGreaterThan(0);
    expect(echoes(pathKey, PLANTED, "Jo Smith", "Users")).toBe(false);
  });

  it("counts.excluded is closed in the schema: known codes only, each a non-negative integer", () => {
    const base = editedManifest(() => {}, NOBODY);
    expect(base).toEqual([]);
    const ok = (excluded: unknown) => {
      const b = tmp();
      try {
        const dir = join(b, "ds");
        exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        return validateSchema({ ...m, counts: { ...m.counts, excluded } }, datasetManifestSchema);
      } finally {
        rmSync(b, { recursive: true, force: true });
      }
    };
    expect(ok(Object.fromEntries(EXCLUSION_CODES.map((c) => [c, 0])))).toEqual([]);
    expect(ok({ [`${PLANTED}2`]: 1 }).map((i) => i.keyword)).toContain("additionalProperties");
    expect(ok({ MISSING_GATE: 1.5 }).length).toBeGreaterThan(0);
    expect(ok({ MISSING_GATE: -1 }).length).toBeGreaterThan(0);
    expect(ok({ MISSING_GATE: "1" }).length).toBeGreaterThan(0);
    // The schema's issue path stops at the object; the container prints path and keyword only.
    const ps = editedManifest((m) => {
      m.counts.excluded = { [USER_PATH_KEY]: 1 };
    }, NOBODY);
    expect(ps).toEqual(["MANIFEST_SCHEMA manifest.json:$.counts.excluded additionalProperties"]);
  });

  it("the identity check masks a key that is not a plain identifier, or that holds an identity", () => {
    const joined: JoinedIdentity[] = [["username", PLANTED]];
    const found = manifestIdentity(
      {
        a: { [`${PLANTED}2`]: PLANTED, [USER_PATH_KEY]: { x: PLANTED } },
        [`xx${PLANTED}`]: 1,
      },
      joined,
    );
    // Every identity is found (the two values and the two keys that hold one) ...
    expect(found.length).toBe(4);
    // ... and no path carries a key's text.
    for (const { path } of found) {
      expect(path.toLowerCase().includes(PLANTED), path).toBe(false);
      expect(path.includes("Users") || path.includes("Jo Smith"), path).toBe(false);
    }
    expect(found.map((f) => f.path).sort()).toEqual(
      ["$.<key>", "$.a.<key>", "$.a.<key>", "$.a.<key>.x"].sort(),
    );
    // A plain identifier key holding no identity is reported as is.
    expect(manifestIdentity({ exporter: PLANTED }, joined)).toEqual([
      { kind: "username", path: "$.exporter" },
    ]);
  });
});

describe("B2, X7: the account floor is 3 characters (#560 parity)", () => {
  it("a 3- to 7-character account is matched in its joined forms (digested in an id, refused in a closed field)", () => {
    for (const account of ["qzj", "qzjs", "qzjsm", "qzjsmt", "qzjsmtx"]) {
      const hygiene = { identity: { user: account, host: "nohost-u" } };
      // Joined forms the word-bounded leak scan cannot see: only the identity check finds them.
      for (const v of [`xx${account}7`, `${account.toUpperCase()}2`]) {
        const id = attempt(candidate({}, { taskId: v }), hygiene);
        expect(id.refused, v).toBeNull();
        expect(id.written.toLowerCase().includes(account), v).toBe(false);
        const closed = attempt(
          candidate({ task: { ...candidate().episode.task, taskSetVersion: v } }),
          hygiene,
        );
        expect(closed.refused?.code === "LEAK" && closed.refused?.detail === "username", v).toBe(
          true,
        );
      }
    }
  });

  it("a 2-character account is below the floor and a generic account is never an identity", () => {
    for (const user of ["qz", "runner", "Root"]) {
      const r = attempt(
        candidate({ task: { ...candidate().episode.task, taskSetVersion: `xx${user}7` } }),
        { identity: { user, host: "nohost-u" } },
      );
      expect(r.refused, user).toBeNull();
    }
  });
});

describe("B2, F1d and the one hashed form, h-<60 hex> (lead ruling 23:06Z)", () => {
  const exact = `h-${"a".repeat(60)}`;
  const notExact = [
    ["h-", "Jo Smith"].join(""),
    `h-${"a".repeat(59)}`,
    `h-${"a".repeat(61)}`,
    `h-${"a".repeat(64)}`,
    `h-${"A".repeat(60)}`,
    `h-${"a".repeat(60)}\n`,
    ` ${exact}`,
  ];

  it("an h- prefixed key or app that is not exactly h-<60 hex> is hashed, never written verbatim", () => {
    for (const v of notExact) {
      const ep = closeEpisode(
        candidate({
          actions: [
            { kind: "key", keys: v },
            { kind: "launch", app: v },
          ],
        }).episode,
      );
      const [k, a] = ep.actions.items as unknown as Array<{ keys?: string; app?: string }>;
      expect(k?.keys, JSON.stringify(v)).toBe(hashed(v));
      expect(a?.app, JSON.stringify(v)).toBe(hashed(v));
    }
  });

  it("an exact h-<60 hex> is kept as is on every hashed field (idempotent)", () => {
    const ep = closeEpisode(
      candidate(
        {
          task: { ...candidate({}, { taskId: exact }).episode.task, instruction: exact },
          actions: [
            { kind: "key", keys: exact },
            { kind: "launch", app: exact },
            { kind: "type", text: exact },
          ],
        },
        { taskId: exact },
      ).episode,
    );
    const items = ep.actions.items as unknown as Array<Record<string, string>>;
    expect([
      ep.task.id,
      ep.task.instruction,
      items[0]?.keys,
      items[1]?.app,
      items[2]?.text,
    ]).toEqual([exact, exact, exact, exact, exact]);
  });

  it("every hashed form is h- plus the first 60 hex of the tagged sha256 (62 characters, no input text)", () => {
    const v = ["C:\\Users\\", "Jo Smith"].join("");
    expect(hashed(v)).toMatch(HASHED);
    expect(hashed(v)).toHaveLength(62);
    const ep = closeEpisode(
      candidate({ task: { ...candidate().episode.task, instruction: v } }).episode,
    );
    expect(ep.task.instruction).toBe(hashed(v));
    expect(HASHED.test(`h-${"a".repeat(64)}`)).toBe(false);
  });
});

describe("should-pins: V22, V7, V2", () => {
  it("V22: an unknown exclusion code is refused without echoing it", () => {
    const ps = editedManifest((m) => {
      m.counts.excluded = { ...m.counts.excluded, NOT_A_CODE: 0 };
    }, NOBODY);
    expect(ps.length).toBeGreaterThan(0);
    expect(echoes(ps, "NOT_A_CODE")).toBe(false);
  });

  // V7 (round 3): a FIFO read blocks synchronously, so it runs in a child process with a hard
  // timeout. A broken guard fails this test in at most 8 s instead of hanging the suite.
  it.skipIf(process.platform === "win32").each(["records.jsonl", "manifest.json"])(
    "V7: a FIFO at %s is NOT_REGULAR at once (never opened, so it cannot block)",
    (name) => {
      const started = Date.now();
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "fifo-child.ts"), name],
        { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8", timeout: 8_000 },
      );
      expect(child.signal, "validateContainer blocked on the FIFO and was killed").toBeNull();
      expect(child.status).toBe(0);
      const problems = JSON.parse(child.stdout.trim()) as string[];
      expect(problems).toContain(`NOT_REGULAR ${name}`);
      expect(Date.now() - started).toBeLessThan(8_000);
    },
    15_000,
  );

  it("V7: a directory at manifest.json or records.jsonl is NOT_REGULAR (fast, in process)", () => {
    for (const name of ["manifest.json", "records.jsonl"]) {
      const b = tmp();
      try {
        const dir = join(b, "ds");
        exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
        unlinkSync(join(dir, name));
        mkdirSync(join(dir, name));
        expect(validateContainer(dir, NOBODY), name).toContain(`NOT_REGULAR ${name}`);
      } finally {
        rmSync(b, { recursive: true, force: true });
      }
    }
  });

  it("V2: an unreadable identity file is VALIDATOR_ERROR, with no throw and no path", () => {
    const b = tmp();
    try {
      const dir = join(b, "ds");
      exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
      const missing = join(b, "no-such-identity-file");
      const ps = validateContainer(dir, { ...NOBODY, identityFile: missing });
      expect(ps).toEqual(["VALIDATOR_ERROR $"]);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("S1 (round 3): an id that looks hashed but is not exactly h-<60 hex> is hashed, and refused verbatim", () => {
  const exact = `h-${"b".repeat(60)}`;
  const looksHashed = [
    `h-${"a".repeat(64)}`,
    `h-${"a".repeat(59)}`,
    `h-${"a".repeat(61)}`,
    `h-${"A".repeat(60)}`,
    `H-${"a".repeat(60)}`,
    `h-${"g".repeat(60)}`,
    "h-task-1",
    "H-run",
  ];

  it("task.id, provenance.runId, harness.plannerModelId, desktop.backend and desktop.image", () => {
    const ep = candidate().episode;
    for (const v of looksHashed) {
      const closed = closeEpisode({
        ...ep,
        task: { ...ep.task, id: v },
        harness: { ...ep.harness, plannerModelId: v },
        provenance: { ...ep.provenance, runId: v },
      });
      expect(closed.task.id, v).toBe(hashed(v));
      expect(closed.harness.plannerModelId, v).toBe(hashed(v));
      expect(closed.provenance.runId, v).toBe(hashed(v));
      const record = closeRecordFields({
        desktop: { backend: v, image: v },
        capture: { path: "doc.csv" },
      });
      expect(record.desktop.backend, v).toBe(hashed(v));
      expect(record.desktop.image, v).toBe(hashed(v));
    }
    // An exact h-<60 hex> id is kept (idempotent); a plain closed id is kept.
    const kept = closeEpisode({ ...ep, task: { ...ep.task, id: exact } });
    expect(kept.task.id).toBe(exact);
    expect(closeEpisode(ep).task.id).toBe("task-1");
  });

  it("the container's open-string check refuses such an id written verbatim", () => {
    const closed = closeEpisode(candidate().episode);
    for (const v of looksHashed) {
      expect(openEpisodeStrings({ ...closed, task: { ...closed.task, id: v } }), v).toEqual([
        "$.task.id",
      ]);
      expect(
        openRecordStrings({ desktop: { backend: v, image: "img/1" }, capture: { path: exact } }),
        v,
      ).toEqual(["$.desktop.backend"]);
    }
    expect(openEpisodeStrings({ ...closed, task: { ...closed.task, id: exact } })).toEqual([]);
  });
});

describe("S2 (round 3): the hash bits are pinned against an independent tagged sha256", () => {
  // Computed here from the documented construction, not from the exporter's own helper.
  const reference = (v: string) =>
    `h-${createHash("sha256")
      .update(`myco.dataset.export-text/1\u0000${v}`, "utf8")
      .digest("hex")
      .slice(0, 60)}`;

  it("hashed() and every hashed field equal h- plus the first 60 hex of sha256(tag NUL value)", () => {
    for (const v of ["Set the cell.", ["C:\\Users\\", "Jo Smith"].join(""), "jsmith", "", "ß"]) {
      expect(hashed(v), JSON.stringify(v)).toBe(reference(v));
    }
    const v = "an instruction";
    const ep = candidate().episode;
    const closed = closeEpisode({
      ...ep,
      task: { ...ep.task, instruction: v, id: "h-x" },
      actions: { ...ep.actions, items: [{ kind: "key", keys: v }] },
    } as unknown as typeof ep);
    expect(closed.task.instruction).toBe(reference(v));
    expect(closed.task.id).toBe(reference("h-x"));
    expect((closed.actions.items[0] as { keys?: string }).keys).toBe(reference(v));
  });
});
