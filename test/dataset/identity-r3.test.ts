/**
 * #559 round 3 (round-2 verdict, comment 7205416504): B1, a refusal never echoes a foreign key;
 * B2, the #560 account floor (X7) and strict `h-` idempotence for key and app names (F1d); the
 * one hashed form `h-<60 hex>` (lead ruling 23:06Z); and the should-pins V22 (unknown exclusion
 * code), V7 (a FIFO is NOT_REGULAR) and V2 (VALIDATOR_ERROR). Every planted value is synthetic.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetManifestSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  closeEpisode,
  HASHED,
  hashed,
  type JoinedIdentity,
  manifestIdentity,
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

  it.skipIf(process.platform === "win32")(
    "V7: a FIFO at records.jsonl is NOT_REGULAR (never opened, so it cannot block)",
    () => {
      const b = tmp();
      try {
        const dir = join(b, "ds");
        exportDataset([candidate()], { outDir: dir, hygiene: NOBODY });
        unlinkSync(join(dir, "records.jsonl"));
        execFileSync("mkfifo", [join(dir, "records.jsonl")]);
        expect(validateContainer(dir, NOBODY)).toContain("NOT_REGULAR records.jsonl");
      } finally {
        rmSync(b, { recursive: true, force: true });
      }
    },
  );

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
