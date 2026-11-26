/**
 * Export: deterministic and reproducible (byte-identical datasets from the same stores and
 * filter, whatever the store order), filters by task set / arm / outcome / date, never mixes
 * simulated and real, and `validate` catches any edit to a dataset. Import round-trips. $0.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PLANTED_MARKER as PLANTED_FAKE } from "../../src/episode/clean.ts";
import { main as episodesMain } from "../../src/episode/cli.ts";
import {
  exportDataset,
  importDataset,
  NO_FILTER,
  validateDataset,
} from "../../src/episode/export.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore, readStoreDir } from "../../src/episode/store.ts";
import { canonicalJson } from "../../src/episode/validate.ts";
import { draft, HOST, scratch } from "./helpers.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(root: string, offset: number): string {
  const store = EpisodeStore.open(root, { simulated: true, host: HOST });
  const days = ["2026-11-24", "2026-11-25", "2026-11-26"];
  for (let i = 0; i < 6; i++) {
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text: `value-${offset + i}` });
    rec.state("persisted", "text/csv", new TextEncoder().encode(`id,v\nA,${offset + i}\n`), 0);
    const snap = rec.snapshot();
    const refuted = i % 2 === 1;
    const r = store.record(
      draft({
        outcome: refuted ? "refuted" : "verified",
        gate: refuted
          ? { verdict: "refuted", accepted: false, reasonCodes: ["ORACLE_FAIL"], oracle: null }
          : { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
        actions: snap.actions,
        observations: snap.observations,
        task: { ...draft().task, id: `t-${offset + i}`, taskSetVersion: i < 3 ? "fc-v1" : "fc-v2" },
        harness: {
          ...draft().harness,
          arm: i % 3 === 0 ? "hcu+shell" : "myco-gate",
          timing: { startedAt: `${days[i % 3]}T10:00:00Z` },
        },
        provenance: {
          ...draft().provenance,
          runId: `run-${offset + i}`,
          attemptLedger: {
            schema: "myco.m2.attempt-event/1",
            events: 2 * (i + 1),
            headSha256: String(i).repeat(64),
          },
        },
      }),
      snap.blobs,
    );
    expect(r.status).toBe("written");
  }
  return root;
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(join(root, p)).toString("base64");
    }
  };
  walk("");
  return out;
}

describe("exportDataset", () => {
  it("is deterministic: same stores and filter, byte-identical dataset, in any store order", () => {
    const a = seed(join(dir("a"), "s"), 0);
    const b = seed(join(dir("b"), "s"), 100);
    const one = join(dir("o1"), "ds");
    const two = join(dir("o2"), "ds");
    const m1 = exportDataset({ stores: [a, b], out: one, simulated: true, host: HOST });
    const m2 = exportDataset({ stores: [b, a], out: two, simulated: true, host: HOST });
    expect(tree(one)).toEqual(tree(two));
    expect(m1.datasetSha256).toBe(m2.datasetSha256);
    expect(m1.counts.episodes).toBe(12);
    expect(validateDataset(one, HOST)).toEqual([]);
    const manifest = readFileSync(join(one, "manifest.json"), "utf8");
    expect(manifest).not.toContain(a);
    expect(manifest).not.toMatch(/"(createdAt|exportedAt|host)"/);
  });

  it("filters by task set, arm, outcome and date", () => {
    const a = seed(join(dir("f"), "s"), 0);
    const count = (filter: Partial<typeof NO_FILTER>) =>
      exportDataset({
        stores: [a],
        out: join(dir("fo"), "ds"),
        simulated: true,
        host: HOST,
        filter: { ...NO_FILTER, ...filter },
      }).counts.episodes;
    expect(count({})).toBe(6);
    expect(count({ taskSetVersion: "fc-v1" })).toBe(3);
    expect(count({ arm: "hcu+shell" })).toBe(2);
    expect(count({ outcome: "refuted" })).toBe(3);
    expect(count({ since: "2026-11-25" })).toBe(4);
    expect(count({ since: "2026-11-25", until: "2026-11-25" })).toBe(2);
    expect(() => count({ since: "26/11/2026" })).toThrow(/invalid filter/);
  });

  it("only copies the blobs the selected episodes reference", () => {
    const a = seed(join(dir("bl"), "s"), 0);
    const out = join(dir("blo"), "ds");
    const m = exportDataset({
      stores: [a],
      out,
      simulated: true,
      host: HOST,
      filter: { ...NO_FILTER, outcome: "refuted" },
    });
    const refs = new Set(
      readStoreDir(a)
        .episodes.filter((e) => e.outcome === "refuted")
        .flatMap((e) => e.observations.items.map((o) => ("file" in o ? o.file : ""))),
    );
    expect(
      readdirSync(join(out, "blobs"))
        .map((f) => `blobs/${f}`)
        .every((f) => refs.has(f)),
    ).toBe(true);
    expect(m.counts.blobs).toBe(readdirSync(join(out, "blobs")).length);
    expect(m.counts.blobs).toBe(3);
    expect(validateDataset(out, HOST)).toEqual([]);
  });

  it("never mixes simulated and real stores", () => {
    const sim = seed(join(dir("m1"), "s"), 0);
    const real = join(dir("m2"), "s");
    EpisodeStore.open(real, { simulated: false, host: HOST });
    expect(() =>
      exportDataset({
        stores: [sim, real],
        out: join(dir("mo"), "ds"),
        simulated: true,
        host: HOST,
      }),
    ).toThrow(/never mix/);
    expect(() =>
      exportDataset({ stores: [sim], out: join(dir("mo2"), "ds"), simulated: false, host: HOST }),
    ).toThrow(/never mix/);
  });

  it("fails closed on an invalid episode in a store (planted marker written behind the writer's back)", () => {
    const a = seed(join(dir("bad"), "s"), 0);
    const file = readdirSync(join(a, "episodes"))[0] as string;
    const text = readFileSync(join(a, "episodes", file), "utf8").replace(
      "value-",
      `${PLANTED_FAKE}-`,
    );
    writeFileSync(join(a, "episodes", file), text);
    expect(() =>
      exportDataset({ stores: [a], out: join(dir("bo"), "ds"), simulated: true, host: HOST }),
    ).toThrow(/invalid/);
  });

  it("refuses a non-empty output directory", () => {
    const a = seed(join(dir("ne"), "s"), 0);
    const out = dir("neo");
    writeFileSync(join(out, "x"), "x");
    expect(() => exportDataset({ stores: [a], out, simulated: true, host: HOST })).toThrow(
      /not empty/,
    );
  });
});

describe("validateDataset catches every edit", () => {
  const exported = () => {
    const a = seed(join(dir("v"), "s"), 0);
    const out = join(dir("vo"), "ds");
    exportDataset({ stores: [a], out, simulated: true, host: HOST });
    return out;
  };

  it("an edited episode", () => {
    const out = exported();
    const f = readdirSync(join(out, "episodes"))[0] as string;
    const p = join(out, "episodes", f);
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace('"agentClaim":"done"', '"agentClaim":"not-done"'),
    );
    expect(validateDataset(out, HOST).join("\n")).toMatch(/manifest hash|ID_MISMATCH/);
  });

  it("an added file, a removed file, an edited count", () => {
    const out = exported();
    writeFileSync(join(out, "episodes", `${"0".repeat(64)}.json`), "{}");
    expect(validateDataset(out, HOST).join("\n")).toMatch(/not in the manifest/);
    const out2 = exported();
    rmSync(join(out2, "blobs", readdirSync(join(out2, "blobs"))[0] as string));
    expect(validateDataset(out2, HOST).join("\n")).toMatch(/listed but missing/);
    const out3 = exported();
    const m = JSON.parse(readFileSync(join(out3, "manifest.json"), "utf8"));
    m.counts.byOutcome.verified += 1;
    writeFileSync(join(out3, "manifest.json"), JSON.stringify(m));
    expect(validateDataset(out3, HOST).join("\n")).toMatch(/do not match the dataset/);
  });

  it("a dataset relabelled real", () => {
    const out = exported();
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    m.simulated = false;
    writeFileSync(join(out, "manifest.json"), JSON.stringify(m));
    expect(validateDataset(out, HOST).join("\n")).toMatch(/simulated=true in a real dataset/);
  });
});

describe("import and the CLI", () => {
  it("import round-trips a dataset into a store of the same kind", () => {
    const a = seed(join(dir("i"), "s"), 0);
    const out = join(dir("io"), "ds");
    exportDataset({ stores: [a], out, simulated: true, host: HOST });
    const into = join(dir("ii"), "s");
    const results = importDataset(out, into, HOST);
    expect(results.every((r) => r.status === "written")).toBe(true);
    const back = readStoreDir(into)
      .episodes.map((e) => canonicalJson(e))
      .sort();
    expect(back).toEqual(
      readStoreDir(a)
        .episodes.map((e) => canonicalJson(e))
        .sort(),
    );
  });

  it("myco-episodes export / validate / usage exit codes", async () => {
    const io = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return { stdout, stderr };
    };
    // The CLI uses this machine's host facts: seed with them.
    const a = join(dir("c"), "s");
    EpisodeStore.open(a, { simulated: true });
    const out = join(dir("co"), "ds");
    expect(await episodesMain(["export", "--from", a, "--out", out, "--simulated"], io())).toBe(0);
    expect(await episodesMain(["validate", "--dataset", out], io())).toBe(0);
    expect(await episodesMain(["validate", "--store", a], io())).toBe(0);
    expect(await episodesMain(["export", "--from", a, "--out", join(dir("cx"), "ds")], io())).toBe(
      3,
    );
    expect(
      await episodesMain(["export", "--from", a, "--out", join(dir("cy"), "ds"), "--real"], io()),
    ).toBe(1);
    writeFileSync(join(out, "stray.txt"), "x");
    expect(await episodesMain(["validate", "--dataset", out], io())).toBe(1);
    expect(await episodesMain(["bogus"], io())).toBe(3);
  });
});
