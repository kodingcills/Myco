/**
 * Track Q (replayable proof): the bundle is a container over the canonical episode record
 * (`myco.episode/1`, #542), never a competing per-attempt record. $0: no model, no VM.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  type ProofBundle,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import {
  EPISODE_FIELDS_USED,
  EPISODE_SCHEMA,
  episodeIdOf,
  projectEpisode,
} from "../../src/proof/episode-ref.ts";
import { canonicalJson, sha256Hex } from "../../src/proof/ledger.ts";
import { renderProofReport } from "../../src/proof/report.ts";
import {
  clone,
  NO_CTX,
  rechain,
  sampleEpisode,
  sampleRun,
  sampleRunWithEpisode,
} from "./fixture.ts";

const verify = (b: ProofBundle, opts = {}) => verifyProofBundle(serializeProofBundle(b), opts);
const codes = (b: ProofBundle, opts = {}) => verify(b, opts).errors.map((e) => e.code);

function deletePath(o: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  delete cur[parts.at(-1) as string];
}

describe("the mirrored episode interface (pinned until #542 merges)", () => {
  it("Q reads exactly these episode fields and the myco.episode/1 schema id", () => {
    expect(EPISODE_SCHEMA).toBe("myco.episode/1");
    expect([...EPISODE_FIELDS_USED]).toEqual([
      "schema",
      "episodeId",
      "simulated",
      "task.id",
      "harness.arm",
      "provenance.runId",
      "provenance.trialKey",
    ]);
  });

  it("every field Q reads is required: deleting any one refuses the projection", () => {
    for (const path of EPISODE_FIELDS_USED) {
      const ep = clone(sampleEpisode());
      deletePath(ep, path);
      // Re-derive the id (except when the id itself is the deleted field), so the refusal
      // comes from the missing field, not from the content hash.
      if (path !== "episodeId") ep.episodeId = episodeIdOf(ep);
      const r = projectEpisode(ep);
      expect(r.ok, path).toBe(false);
      expect(JSON.stringify(r), path).not.toContain("not the hash");
    }
  });

  it("the id is #542's rule (sha256 of the canonical episode without episodeId) and is recomputed", () => {
    const ep = sampleEpisode();
    const { episodeId, ...rest } = ep;
    expect(episodeId).toBe(sha256Hex(canonicalJson(rest)));
    expect(episodeIdOf(ep)).toBe(episodeId);
    const p = projectEpisode(ep);
    expect(p.ok && p.projection).toMatchObject({
      ref: { schema: "myco.episode/1", episodeId, sha256: sha256Hex(canonicalJson(ep)) },
      runId: "run-1",
      taskId: "df-s02",
      arm: "myco-gate",
      simulated: true,
      trialKey: "t-ours",
    });
    // An edited episode whose id was not recomputed is refused.
    const edited = { ...ep, outcome: "verified" };
    expect(projectEpisode(edited)).toEqual({
      ok: false,
      errors: ["$.episodeId is not the hash of the episode's content"],
    });
  });

  it("a non-episode or another schema is refused", () => {
    expect(projectEpisode(null).ok).toBe(false);
    expect(projectEpisode(sampleEpisode({ schema: "myco.episode/2" })).ok).toBe(false);
    expect(projectEpisode(sampleEpisode({ simulated: "yes" })).ok).toBe(false);
  });
});

describe("a bundle references its episode by id and digest and carries no copy of it", () => {
  it("the bundle holds only the reference; with the episode, verify cross-checks it", () => {
    const ep = sampleEpisode();
    const b = exportProofBundle(sampleRunWithEpisode(), NO_CTX);
    expect(b.run.episode).toEqual({
      schema: "myco.episode/1",
      episodeId: ep.episodeId,
      sha256: sha256Hex(canonicalJson(ep)),
    });
    // Not a competing record: none of the episode's own groups is copied into the bundle.
    const text = serializeProofBundle(b);
    for (const key of ['"groundTruth"', '"agentClaim"', '"provenance"', '"observations"'])
      expect(text).not.toContain(key);
    const checked = verify(b, { episode: ep });
    expect(checked.ok).toBe(true);
    expect(checked.episodeChecked).toBe(true);
    const unchecked = verify(b);
    expect(unchecked.ok).toBe(true);
    expect(unchecked.episodeChecked).toBe(false);
    expect(renderProofReport(b, checked)).toContain("recomputed and cross-checked");
    expect(renderProofReport(b, unchecked)).toContain("reference only: not checked here");
  });

  it("a run without an episode says so (null), and an episode given for it is refused", () => {
    const b = exportProofBundle(sampleRun(), NO_CTX);
    expect(b.run.episode).toBeNull();
    expect(codes(b, { episode: sampleEpisode() })).toEqual(["PROOF_EPISODE"]);
  });

  it("another episode (different id/digest) is refused", () => {
    const b = exportProofBundle(sampleRunWithEpisode(), NO_CTX);
    const other = sampleEpisode({ outcome: "uncertain" });
    expect(codes(b, { episode: other })).toEqual(["PROOF_EPISODE"]);
  });

  it("an edited reference is refused against the episode, even re-chained", () => {
    const b = clone(exportProofBundle(sampleRunWithEpisode(), NO_CTX)) as unknown as {
      run: { episode: { sha256: string } };
    };
    b.run.episode.sha256 = "1".repeat(64);
    // Without the episode, the run header is covered by the chain: the edit breaks it.
    expect(codes(b as unknown as ProofBundle)).toEqual(["PROOF_CHAIN"]);
    // Re-chained, only the episode cross-check sees it.
    const forged = rechain(b as unknown as ProofBundle);
    expect(codes(forged)).toEqual([]);
    expect(codes(forged, { episode: sampleEpisode() })).toEqual(["PROOF_EPISODE"]);
  });

  it("each projected run field must agree with the episode (export and verify both refuse)", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        "runId",
        { provenance: { ...(sampleEpisode().provenance as object), runId: "run-9" } },
        /runId/,
      ],
      ["taskId", { task: { ...(sampleEpisode().task as object), id: "df-s01" } }, /taskId/],
      ["arm", { harness: { ...(sampleEpisode().harness as object), arm: "hcu+shell" } }, /arm/],
      ["simulated", { simulated: false }, /simulated/],
      [
        "trialKey",
        { provenance: { ...(sampleEpisode().provenance as object), trialKey: "t-other" } },
        /trial/,
      ],
    ];
    for (const [name, over, re] of cases) {
      const ep = sampleEpisode(over);
      expect(() => exportProofBundle({ ...sampleRun(), episode: ep }, NO_CTX), name).toThrow(re);
      // A forger who rewrites the reference to point at that episode is still refused.
      const p = projectEpisode(ep);
      if (!p.ok) throw new Error("fixture");
      const b = clone(exportProofBundle(sampleRunWithEpisode(), NO_CTX)) as unknown as {
        run: { episode: unknown };
      };
      b.run.episode = p.projection.ref;
      const r = verify(rechain(b as unknown as ProofBundle), { episode: ep });
      expect(
        r.errors.map((e) => e.code),
        name,
      ).toEqual(["PROOF_EPISODE"]);
    }
  });

  it("a malformed reference is refused by the schema", () => {
    const b = clone(exportProofBundle(sampleRunWithEpisode(), NO_CTX)) as unknown as {
      run: { episode: Record<string, unknown> };
    };
    b.run.episode.schema = "myco.episode/2";
    expect(codes(b as unknown as ProofBundle)).toContain("PROOF_SCHEMA");
    const c = clone(exportProofBundle(sampleRun(), NO_CTX)) as unknown as {
      run: Record<string, unknown>;
    };
    delete c.run.episode;
    expect(codes(c as unknown as ProofBundle)).toContain("PROOF_SCHEMA");
  });
});

describe("CLI: RUN.json episodeFile and verify --episode", () => {
  it("exports a bundle referencing the episode, verifies it with --episode, refuses another", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-episode-"));
    const run = sampleRun();
    const steps = run.steps.filter((s) => !(s.kind === "evidence" && s.evidenceId === "ev-frame"));
    writeFileSync(join(dir, "episode.json"), JSON.stringify(sampleEpisode()));
    writeFileSync(join(dir, "other.json"), JSON.stringify(sampleEpisode({ outcome: "uncertain" })));
    writeFileSync(
      join(dir, "RUN.json"),
      JSON.stringify({ ...run, steps, episodeFile: "episode.json" }),
    );
    const call = (args: string[]) => {
      let out = "";
      const code = main(args, { out: (t) => (out += t), err: (t) => (out += t) });
      return { code, out };
    };
    const bundle = join(dir, "bundle.json");
    expect(call(["export", join(dir, "RUN.json"), "--out", bundle]).code).toBe(0);
    const ok = call(["verify", bundle, "--episode", join(dir, "episode.json")]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ok: true, episodeChecked: true });
    const bad = call(["verify", bundle, "--episode", join(dir, "other.json")]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).errors.map((e: { code: string }) => e.code)).toEqual([
      "PROOF_EPISODE",
    ]);
    const report = call([
      "report",
      bundle,
      "--out",
      join(dir, "r.html"),
      "--episode",
      join(dir, "other.json"),
    ]);
    expect(report.code).toBe(1);
  });
});
