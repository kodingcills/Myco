/**
 * Track M acceptance 4: poisoning defences. Revocation; quarantine of a skill whose later
 * uses are refuted (sticky); provenance verified on load with tamper-evident digests (an
 * edited line, a recomputed record digest, a fully recomputed chain with planted content,
 * a deleted, reordered or truncated line all refuse the whole store).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { taskFeatures } from "../../src/skills/arm.ts";
import { canonicalJson, recordDigest, sha256, skillIdFor } from "../../src/skills/record.ts";
import { type RetrievalQuery, retrieve } from "../../src/skills/retrieve.ts";
import {
  GENESIS,
  SkillStore,
  SkillStoreError,
  STORE_FILE,
  useOutcome,
} from "../../src/skills/store.ts";
import {
  admitSimulated,
  candidateFrom,
  docWith,
  forbiddenFor,
  gatedRun,
  NONE_TASK as T,
  TASKS,
} from "./helpers.ts";

let base: string;
let dir: string;
let vault: VerdictVault;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-skills-store-"));
  dir = join(base, "store");
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function seeded(n = 2): Promise<{ store: SkillStore; ids: string[] }> {
  const store = SkillStore.open(dir);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const runId = `seed-${i}`;
    const run = await gatedRun(vault, base, T, runId, docWith(T, T.intent.newValue));
    const steps =
      i === 0 ? undefined : [`Open the spreadsheet in Calc, variant ${i}`, "Save as CSV"];
    const added = store.add(
      admitSimulated(candidateFrom(T, runId, run, steps ? { steps } : {}), forbiddenFor(T)),
    );
    if (!added.stored) throw new Error(added.code);
    ids.push(added.skillId);
  }
  return { store, ids };
}

/** The seeded skills come from a scripted (simulated) planner: retrieve in that scope. */
const retrieveSim = (s: SkillStore, query: RetrievalQuery) =>
  retrieve(s, query, { serveSimulated: true });
const q = { taskFamily: T.family, features: taskFeatures(T) };
const lines = () => readFileSync(join(dir, STORE_FILE), "utf8").trimEnd().split("\n");
const writeLines = (ls: string[]) => writeFileSync(join(dir, STORE_FILE), `${ls.join("\n")}\n`);
function reseal(e: Record<string, unknown>): Record<string, unknown> {
  const { eventSha256: _, ...body } = e;
  return { ...body, eventSha256: sha256(canonicalJson(body)) };
}
const refusedWith = (code: string, fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SkillStoreError);
    expect((err as SkillStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("store: append-only, chained, verified on load", () => {
  it("round-trips: reopen verifies and serves the same skills; head pins", async () => {
    const { store, ids } = await seeded();
    const head = store.head();
    expect(head).not.toBe(GENESIS);
    const again = SkillStore.open(dir, { expectHead: head });
    expect(again.active().map((s) => s.record.skillId)).toEqual(ids);
    expect(retrieveSim(again, q).skills.map((s) => s.skillId)).toEqual(ids);
  });

  it("an edited step (digests left alone) refuses the whole store", async () => {
    await seeded();
    const ls = lines();
    ls[0] = (ls[0] as string).replace("Open the spreadsheet", "Open teh spreadsheet");
    writeLines(ls);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("an edited step with the event digest recomputed is still refused (record digest)", async () => {
    // The last line, so no later prevSha256 link gives the edit away: only the record digest can.
    await seeded(1);
    const ls = lines();
    const e = JSON.parse(ls[0] as string);
    e.record.steps[0] = "Open the spreadsheet somewhere else";
    ls[0] = JSON.stringify(reseal(e));
    writeLines(ls);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a fully recomputed chain carrying planted content is refused by the content rules", async () => {
    const e = JSON.parse(
      (await (async () => {
        await seeded(1);
        return lines()[0];
      })()) as string,
    );
    e.record.steps[0] = `Open /${"Users"}/planted/doc.csv`; // built at runtime: no-home-paths
    const sealed = recordDigest(e.record);
    e.record.recordSha256 = sealed;
    e.record.skillId = skillIdFor(sealed);
    writeLines([JSON.stringify(reseal(e))]);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a fully recomputed chain claiming a refuted provenance is refused", async () => {
    await seeded(1);
    const e = JSON.parse(lines()[0] as string);
    e.record.provenance.gateVerdict = "refuted";
    const sealed = recordDigest(e.record);
    e.record.recordSha256 = sealed;
    e.record.skillId = skillIdFor(sealed);
    writeLines([JSON.stringify(reseal(e))]);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  /** Rewrite the single admit line with `edit`, recompute every digest, write it back. */
  async function resealedRecord(edit: (record: Record<string, unknown>) => void): Promise<string> {
    const { store } = await seeded(1);
    const pinned = store.head();
    const e = JSON.parse(lines()[0] as string);
    edit(e.record);
    const sealed = recordDigest(e.record);
    e.record.recordSha256 = sealed;
    e.record.skillId = skillIdFor(sealed);
    writeLines([JSON.stringify(reseal(e))]);
    return pinned;
  }

  it("a resealed record whose simulated flag contradicts its planner is refused", async () => {
    await resealedRecord((r) => {
      // A scripted planner's skill relabelled as real, so a real trial would be served it.
      (r.provenance as Record<string, unknown>).simulated = false;
    });
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a resealed record carrying a host path in provenance is refused (whole-record scan)", async () => {
    // graderVersion only has to be printable; only the whole-record scan sees the path.
    await resealedRecord((r) => {
      (r.provenance as Record<string, unknown>).graderVersion = "grader at /srv/planted/g";
    });
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a resealed revocation with an unknown reason is refused", async () => {
    const { store, ids } = await seeded(1);
    store.revoke(ids[0] as string, "operator");
    const ls = lines();
    const e = JSON.parse(ls[1] as string);
    e.reason = "because";
    ls[1] = JSON.stringify(reseal(e));
    writeLines(ls);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a resealed record planting the task's value loads without a pin, and the pin refuses it", async () => {
    // The store does not know a task's values, so the load-time content rules cannot catch
    // this (docs: only secrets, host paths, oracle internals and injection are re-checked).
    // The head pin is what closes it.
    const pinned = await resealedRecord((r) => {
      (r.steps as string[])[0] = `Type ${T.intent.newValue} into the cell`;
    });
    expect(SkillStore.open(dir).skills()[0]?.record.steps[0]).toContain(T.intent.newValue);
    refusedWith("STORE_HEAD_MISMATCH", () => SkillStore.open(dir, { expectHead: pinned }));
  });

  it("an open handle sees a revocation written through another handle", async () => {
    const { store, ids } = await seeded(2);
    expect(store.active().map((s) => s.record.skillId)).toEqual(ids);
    SkillStore.open(dir).revoke(ids[0] as string, "poisoned");
    expect(store.active().map((s) => s.record.skillId)).toEqual([ids[1]]);
    expect(retrieveSim(store, q).skills.map((s) => s.skillId)).toEqual([ids[1]]);
  });

  it("an open handle refuses a log rolled back below what it verified", async () => {
    const { store, ids } = await seeded(2);
    store.revoke(ids[0] as string, "poisoned");
    writeLines(lines().slice(0, -1));
    refusedWith("STORE_HEAD_MISMATCH", () => store.active());
  });

  it("a deleted line breaks the chain", async () => {
    const { store, ids } = await seeded();
    store.revoke(ids[0] as string, "operator");
    const ls = lines();
    ls.splice(1, 1);
    writeLines(ls);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("reordered lines break the chain", async () => {
    await seeded();
    const ls = lines();
    writeLines([ls[1] as string, ls[0] as string]);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a deleted revocation at the tail is caught by the head pin", async () => {
    const { store, ids } = await seeded();
    store.revoke(ids[0] as string, "poisoned");
    const head = store.head();
    writeLines(lines().slice(0, -1));
    expect(() => SkillStore.open(dir)).not.toThrow();
    refusedWith("STORE_HEAD_MISMATCH", () => SkillStore.open(dir, { expectHead: head }));
  });

  it("an unknown event type, unknown field, or junk line is refused", async () => {
    await seeded(1);
    const ls = lines();
    const prev = JSON.parse(ls[0] as string).eventSha256;
    for (const extra of [
      reseal({ seq: 1, prevSha256: prev, type: "promote", skillId: "x" }),
      reseal({
        seq: 1,
        prevSha256: prev,
        type: "revoke",
        skillId: JSON.parse(ls[0] as string).record.skillId,
        reason: "operator",
        note: "x",
      }),
    ]) {
      writeLines([...ls, JSON.stringify(extra)]);
      refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
    }
    writeLines(ls);
    appendFileSync(join(dir, STORE_FILE), "not json\n");
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a laundered use (refuted -> verified) is refused by the event digest", async () => {
    // A use event has no record digest: only its own event digest protects the outcome.
    const { store, ids } = await seeded(1);
    store.recordUse(ids[0] as string, "warm-1", "refuted");
    const ls = lines();
    ls[1] = (ls[1] as string).replace('"outcome":"refuted"', '"outcome":"verified"');
    writeLines(ls);
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a deleted revocation with renumbered, resealed events is refused by the chain link", async () => {
    // seq and every event digest are made consistent again; only prevSha256 still breaks.
    const { store, ids } = await seeded(2);
    store.revoke(ids[0] as string, "poisoned");
    store.recordUse(ids[1] as string, "warm-1", "verified");
    const ls = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    const kept = [ls[0], ls[1], ls[3]].map((e, i) => reseal({ ...(e as object), seq: i }));
    writeLines(kept.map((e) => JSON.stringify(e)));
    refusedWith("STORE_TAMPERED", () => SkillStore.open(dir));
  });

  it("a write after an outside edit is refused (STORE_CHANGED)", async () => {
    const { store, ids } = await seeded();
    const other = SkillStore.open(dir);
    other.revoke(ids[1] as string, "operator");
    refusedWith("STORE_CHANGED", () => store.revoke(ids[0] as string, "operator"));
  });
});

describe("revocation and quarantine", () => {
  it("a revoked skill is never retrieved again, and stays revoked after reload", async () => {
    const { store, ids } = await seeded();
    store.revoke(ids[0] as string, "poisoned");
    expect(retrieveSim(store, q).skills.map((s) => s.skillId)).toEqual([ids[1]]);
    expect(retrieveSim(SkillStore.open(dir), q).skills.map((s) => s.skillId)).toEqual([ids[1]]);
    expect(store.skills().find((s) => s.record.skillId === ids[0])?.status).toBe("revoked");
  });

  it("revoking an unknown skill or with an unknown reason throws", async () => {
    const { store, ids } = await seeded(1);
    refusedWith("UNKNOWN_SKILL", () => store.revoke("sk-0000000000000000", "operator"));
    refusedWith("INVALID_EVENT", () => store.revoke(ids[0] as string, "because" as never));
  });

  it("a refuted later use quarantines the skill (default threshold 1), sticky", async () => {
    const { store, ids } = await seeded();
    store.recordUse(ids[0] as string, "warm-1", "verified");
    store.recordUse(ids[0] as string, "warm-2", "uncertain");
    expect(store.skills()[0]?.status).toBe("active");
    store.recordUse(ids[0] as string, "warm-3", "refuted");
    expect(store.skills()[0]?.status).toBe("quarantined");
    store.recordUse(ids[0] as string, "warm-4", "verified");
    store.recordUse(ids[0] as string, "warm-5", "verified");
    expect(store.skills()[0]?.status).toBe("quarantined");
    expect(retrieveSim(store, q).skills.map((s) => s.skillId)).toEqual([ids[1]]);
    expect(SkillStore.open(dir).skills()[0]?.status).toBe("quarantined");
  });

  it("a higher threshold quarantines at that many refuted uses; below 1 is refused", async () => {
    const { ids } = await seeded();
    const store = SkillStore.open(dir, { quarantineAfter: 2 });
    store.recordUse(ids[0] as string, "warm-1", "refuted");
    expect(store.skills()[0]?.status).toBe("active");
    store.recordUse(ids[0] as string, "warm-2", "refuted");
    expect(store.skills()[0]?.status).toBe("quarantined");
    refusedWith("INVALID_EVENT", () => SkillStore.open(dir, { quarantineAfter: 0 }));
  });

  it("a use's outcome is verified only when the gate verified AND the grader passed", () => {
    expect(useOutcome("verified", "pass")).toBe("verified");
    expect(useOutcome("verified", "fail")).toBe("refuted");
    expect(useOutcome("verified", "ungradable")).toBe("uncertain");
    expect(useOutcome("verified", null)).toBe("uncertain");
    expect(useOutcome("refuted", "pass")).toBe("refuted");
    expect(useOutcome("refuted", null)).toBe("refuted");
    expect(useOutcome("uncertain", "pass")).toBe("uncertain");
  });

  it("a use with a path-shaped run id is refused", async () => {
    const { store, ids } = await seeded(1);
    refusedWith("INVALID_EVENT", () => store.recordUse(ids[0] as string, "../x", "verified"));
  });
});

describe("retrieval scope", () => {
  it("serves only the task family asked for, ranked by similarity, at most the limit", async () => {
    const { store, ids } = await seeded();
    expect(retrieveSim(store, { taskFamily: "todo-add", features: q.features }).skills).toEqual([]);
    const other = TASKS.find(
      (t) => t.satisfiable && t.columnTypes[t.intent.column] !== T.columnTypes[T.intent.column],
    );
    const r = retrieveSim(store, { taskFamily: T.family, features: taskFeatures(other as never) });
    expect(r.skills.map((s) => s.skillId)).toEqual(ids);
    expect(r.skills[0]?.similarity).toBeLessThan(1);
    expect(retrieveSim(store, { ...q, features: ["app:other"] }).skills).toEqual([]);
    expect(retrieveSim(store, { ...q, limit: 1 }).skills).toHaveLength(1);
    expect(retrieveSim(store, q)).toMatchObject({ advisory: true, evidence: false });
  });
});
