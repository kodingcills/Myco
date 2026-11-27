/**
 * #579 on track U's container: PROVENANCE-BOUND `h-<60 hex>` (O3) and ACCENT FOLDING (O2).
 *
 *  - an agent-supplied `h-<60 hex>` in every hashed field (the episode's text, ids, key and app
 *    names; the record's desktop facts and capture path) is re-hashed, never written as is;
 *  - a harness-produced one (in the caller's hash ledger for this episode id and path, built by
 *    `containerHashLedger` from a container the harness wrote) is kept; elsewhere it is re-hashed;
 *  - export -> import (the container's ledger) -> export is byte-identical, file for file;
 *  - accented identities (and their accent-stripped forms) in every field are digested or refused.
 *
 * Every planted value is a fake word built at run time; no real identity value is printed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeEpisode,
  closeRecordFields,
  fold,
  hashed,
  hashLedgerOf,
  type JoinedIdentity,
  joinedIdentity,
  RECORD_SCOPE,
} from "../../src/dataset/closed.ts";
import type { Episode } from "../../src/dataset/episode.ts";
import {
  containerHashLedger,
  type ExportCandidate,
  exportDataset,
  validateContainer,
} from "../../src/dataset/export.ts";
import { identityStrings } from "../../src/dataset/hygiene.ts";
import { episodeScope, HashLedger } from "../../src/export-guard/provenance.ts";
import { attempt, candidate } from "./identity-fixture.ts";

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `myco-u-pv-${p}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A short home path (built at run time: no home-path literal is committed), hex-encoded. */
const SMUGGLED = Buffer.from(
  ["", "Users", "qzsmug", "Documents", "x.csv"].join("/"),
  "utf8",
).toString("hex");
const AGENT_HEX = `h-${SMUGGLED.padEnd(60, "0").slice(0, 60)}`;
const CAFE = `h-${"cafe".repeat(15)}`;
const NO_HOST = { hostIdentity: false, identity: { user: "zz", host: "zz" } } as const;
const NOW = () => new Date("2026-11-27T00:00:00.000Z");

/** A candidate carrying `v` in every hashed field of its episode and record. */
function everywhere(v: string, ids = { taskId: v, runId: v }): ExportCandidate {
  const c = candidate(
    {
      task: { ...candidate().episode.task, id: ids.taskId, instruction: v },
      actions: [
        { kind: "type", text: v },
        { kind: "shell", command: v },
        { kind: "key", keys: v },
        { kind: "launch", app: v },
      ],
      observations: [{ afterAction: 0, text: v }],
      plannerModelId: v,
      trialKey: v,
      // A non-real planner id: the attempt is labelled simulated (never mixed into real rows).
      simulated: true,
    },
    ids,
  );
  return { ...c, desktop: { ...c.desktop, backend: v, image: v } };
}

function episodeFields(ep: Episode): Array<readonly [string, unknown]> {
  const a = ep.actions.items as unknown as Array<Record<string, string>>;
  const o = ep.observations.items as unknown as Array<Record<string, string>>;
  return [
    ["$.task.id", ep.task.id],
    ["$.task.instruction", ep.task.instruction],
    ["$.harness.plannerModelId", ep.harness.plannerModelId],
    ["$.provenance.runId", ep.provenance.runId],
    ["$.provenance.trialKey", ep.provenance.trialKey],
    ["$.actions.items[0].text", a[0]?.text],
    ["$.actions.items[1].command", a[1]?.command],
    ["$.actions.items[2].keys", a[2]?.keys],
    ["$.actions.items[3].app", a[3]?.app],
    ["$.observations.items[0].text", o[0]?.text],
  ];
}

const recordOf = (c: ExportCandidate, id = "e".repeat(64)) => ({
  episode: { id },
  desktop: { backend: c.desktop.backend, image: c.desktop.image },
  capture: { path: c.capture?.path ?? "" },
});

describe("O3: an agent-supplied h-<60 hex> is re-hashed in every hashed field", () => {
  it.each([
    ["hex-encoded path", AGENT_HEX],
    ["hex-letter identity", CAFE],
  ])("%s: episode and record fields get the hash of the value", (_l, v) => {
    const joined: JoinedIdentity[] = [["username", "cafe"]];
    const c = everywhere(v);
    const closed = closeEpisode(c.episode, joined);
    for (const [path, out] of episodeFields(closed)) expect(out, path).toBe(hashed(v));
    const rec = closeRecordFields({ ...recordOf(c), capture: { path: v } }, joined);
    expect([rec.desktop.backend, rec.desktop.image, rec.capture.path]).toEqual(
      Array(3).fill(hashed(v)),
    );
  });

  it("through the real export: no agent hex reaches the container, and it validates", () => {
    const r = attempt(everywhere(AGENT_HEX), NO_HOST);
    expect(r.refused).toBeNull();
    expect(r.written.includes(SMUGGLED.slice(0, 40))).toBe(false);
    expect(r.written.includes(hashed(AGENT_HEX))).toBe(true);
    expect(r.valid).toEqual([]);
  });
});

describe("O3: a harness-produced h-<60 hex> is kept, only where the harness produced it", () => {
  it("kept in every episode field and record field the ledger records", () => {
    const c = everywhere(AGENT_HEX);
    const rec = { ...recordOf(c), capture: { path: AGENT_HEX } };
    const ledger = hashLedgerOf([c.episode], [rec]);
    for (const [path, out] of episodeFields(closeEpisode(c.episode, [], ledger)))
      expect(out, path).toBe(AGENT_HEX);
    const kept = closeRecordFields(rec, [], ledger);
    expect([kept.desktop.backend, kept.desktop.image, kept.capture.path]).toEqual(
      Array(3).fill(AGENT_HEX),
    );
  });

  it("re-hashed when recorded for another episode, another path, or the episode's path for a record", () => {
    const c = everywhere(AGENT_HEX);
    const otherEpisode = new HashLedger();
    for (const [path] of episodeFields(c.episode))
      otherEpisode.record(episodeScope("f".repeat(64), path), AGENT_HEX);
    const otherPath = new HashLedger();
    otherPath.record(episodeScope(c.episode.episodeId, "$.task.family"), AGENT_HEX);
    for (const ledger of [otherEpisode, otherPath])
      for (const [path, out] of episodeFields(closeEpisode(c.episode, [], ledger)))
        expect(out, path).toBe(hashed(AGENT_HEX));
    // A record value recorded as an EPISODE path (no `record:` prefix) does not count.
    const asEpisode = new HashLedger();
    asEpisode.record(episodeScope("e".repeat(64), "$.desktop.backend"), AGENT_HEX);
    expect(closeRecordFields(recordOf(c), [], asEpisode).desktop.backend).toBe(hashed(AGENT_HEX));
    const asRecord = new HashLedger();
    asRecord.record(episodeScope("e".repeat(64), `${RECORD_SCOPE}$.desktop.backend`), AGENT_HEX);
    expect(closeRecordFields(recordOf(c), [], asRecord).desktop.backend).toBe(AGENT_HEX);
  });

  it("re-hashed when the ledger holds a DIFFERENT h-<60 hex> at this same episode, path or record field", () => {
    const c = everywhere(AGENT_HEX);
    const other = new HashLedger();
    for (const [path] of episodeFields(c.episode))
      other.record(episodeScope(c.episode.episodeId, path), CAFE);
    for (const f of ["$.desktop.backend", "$.desktop.image", "$.capture.path"])
      other.record(episodeScope("e".repeat(64), `${RECORD_SCOPE}${f}`), CAFE);
    for (const [path, out] of episodeFields(closeEpisode(c.episode, [], other)))
      expect(out, path).toBe(hashed(AGENT_HEX));
    const rec = closeRecordFields({ ...recordOf(c), capture: { path: AGENT_HEX } }, [], other);
    expect([rec.desktop.backend, rec.desktop.image, rec.capture.path]).toEqual(
      Array(3).fill(hashed(AGENT_HEX)),
    );
  });

  it("containerHashLedger refuses a container that does not validate", () => {
    const out = join(tmp("bad"), "ds");
    exportDataset([everywhere(AGENT_HEX, { taskId: "task-1", runId: "run-1" })], {
      outDir: out,
      hygiene: NO_HOST,
      now: NOW,
    });
    writeFileSync(join(out, "stray.txt"), "x");
    expect(() => containerHashLedger(out, NO_HOST)).toThrow(/hash ledger refused/);
  });
});

describe("O3: export -> import -> export is byte-identical", () => {
  function files(dir: string): string {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        const p = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else out.push(`${p}\n${readFileSync(join(dir, p), "utf8")}`);
      }
    };
    walk("");
    return out.join("\u0000");
  }

  it("re-exporting a container's own episodes under its ledger writes the same bytes", () => {
    const ids = { taskId: "task-1", runId: "run-1" };
    const c = everywhere(AGENT_HEX, ids);
    const original = {
      ...c,
      capture: { ...(c.capture as NonNullable<typeof c.capture>), path: CAFE },
    };
    const first = join(tmp("rt1"), "ds");
    exportDataset([original], { outDir: first, hygiene: NO_HOST, now: NOW });
    expect(validateContainer(first, NO_HOST)).toEqual([]);

    // Import: the container's ledger, and its episodes and records back as candidates.
    const ledger = containerHashLedger(first, NO_HOST);
    expect(ledger.size).toBeGreaterThan(0);
    const record = JSON.parse(readFileSync(join(first, "records.jsonl"), "utf8").trim());
    const ep = JSON.parse(readFileSync(join(first, record.episode.file), "utf8")) as Episode;
    const again: ExportCandidate = {
      ...original,
      episode: ep,
      gate: {
        ...(original.gate as NonNullable<typeof original.gate>),
        request: { taskId: ep.task.id, runId: ep.provenance.runId },
      },
      capture: {
        ...(original.capture as NonNullable<typeof original.capture>),
        path: record.capture.path,
      },
      desktop: {
        ...original.desktop,
        backend: record.desktop.backend,
        image: record.desktop.image,
      },
    };
    const second = join(tmp("rt2"), "ds");
    exportDataset([again], { outDir: second, hygiene: NO_HOST, now: NOW, hashLedger: ledger });
    expect(files(second)).toBe(files(first));

    // Without the ledger the same import is re-hashed (the ledger is what keeps the values).
    const third = join(tmp("rt3"), "ds");
    exportDataset([again], { outDir: third, hygiene: NO_HOST, now: NOW });
    expect(files(third)).not.toBe(files(first));
  });
});

describe("O2: accent folding (NFD, combining marks removed) on both sides", () => {
  it("fold matches accent-stripped and transliterated forms, both ways", () => {
    for (const [configured, written] of [
      ["josé", "JOSE"],
      ["JOSE", "josé"],
      ["reña", "rena"],
      ["Søren", "SOREN"],
      ["Łukasz", "lukasz"],
      ["Ærø", "AERO"],
      ["josé", "JOSÉ"],
    ] as const)
      expect(fold(written), `${configured} ~ ${written}`).toBe(fold(configured));
  });

  const NAME = ["Qzjosé", "Qzreña"].join(" ");
  const ASCII = "QZJOSE_QZRENA";
  const identityFile = (line: string) => {
    const p = join(tmp("id"), "identity.txt");
    writeFileSync(p, `${line}\n`);
    return p;
  };

  it("an accented identity's ASCII form, and the reverse, in every hashed field is digested", () => {
    for (const [configured, written] of [
      [NAME, ASCII],
      ["Qzjose Qzrena", "QzJosé-QzReña"],
    ] as const) {
      const joined = identityStrings({ ...NO_HOST, identityFile: identityFile(configured) });
      const c = everywhere(written);
      for (const [path, out] of episodeFields(closeEpisode(c.episode, joined)))
        expect(out, path).toBe(hashed(written));
      const rec = closeRecordFields({ ...recordOf(c), capture: { path: written } }, joined);
      expect([rec.desktop.backend, rec.desktop.image, rec.capture.path]).toEqual(
        Array(3).fill(hashed(written)),
      );
    }
  });

  it("an accented identity's ASCII form in a closed pattern field refuses the export (LEAK)", () => {
    const hygiene = { ...NO_HOST, identityFile: identityFile(NAME) };
    const joined = identityStrings(hygiene);
    const base = candidate();
    for (const [path, ep] of [
      [
        "$.task.family",
        { ...base.episode, task: { ...base.episode.task, family: "qzjose-qzrena" } },
      ],
      [
        "$.task.taskSetVersion",
        { ...base.episode, task: { ...base.episode.task, taskSetVersion: ASCII } },
      ],
    ] as const) {
      expect(
        joinedIdentity(closeEpisode(ep as Episode, joined), joined).map((h) => h.path),
      ).toContain(path);
    }
    const r = attempt(
      candidate({ task: { ...base.episode.task, taskSetVersion: ASCII } }),
      hygiene,
    );
    expect(r.refused?.code).toBe("LEAK");
    expect(r.refused?.message.toLowerCase().includes("qzjose")).toBe(false);
  });
});
