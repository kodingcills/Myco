/**
 * Clean by construction, then checked. Markers are planted in the env, the home directory,
 * the fixture, the vault and the oracle config of a REAL gated trial (the sealed vault, the
 * calc-record-edit gate): none may reach the episode. Then the validator refuses an episode
 * that does carry a marker, an absolute path or a key-shaped string, and screenshots only
 * pass through a frame redactor.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEpisode } from "../../src/episode/build.ts";
import {
  blobIssues,
  cleanIssues,
  PLANTED_MARKER,
  redactText,
  stringIssues,
} from "../../src/episode/clean.ts";
import { exportDataset } from "../../src/episode/export.ts";
import { runGatedTrialWithEpisode } from "../../src/episode/gated.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore, forbiddenStoreRoot, readStoreDir } from "../../src/episode/store.ts";
import {
  captureFor,
  draft,
  fakeKey,
  HOST,
  honestDoc,
  ORACLE_SOURCES,
  plan,
  registry,
  scratch,
  task,
  vaultIn,
} from "./helpers.ts";

const made: string[] = [];
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function storeFiles(root: string): string {
  const parts: string[] = [];
  for (const sub of ["episodes", "blobs"])
    for (const f of readdirSync(join(root, sub)))
      parts.push(readFileSync(join(root, sub, f), "latin1"));
  return parts.join("\n");
}

describe("planted markers never reach an episode (clean by construction)", () => {
  it("env, home, fixture, vault and oracle config markers stay out of a gated trial's episode", async () => {
    const base = dir("planted");
    // vault: its root path carries the marker; oracle config: a source path with the marker.
    const vault = vaultIn(base, `vault-${PLANTED_MARKER}`);
    const oracleDir = join(base, `oracle-${PLANTED_MARKER}`);
    mkdirSync(oracleDir);
    const oracleCopy = join(oracleDir, "families.ts");
    writeFileSync(
      oracleCopy,
      `// ${PLANTED_MARKER}\n${readFileSync(ORACLE_SOURCES[0] as string, "utf8")}`,
    );
    const home = `/home/${PLANTED_MARKER}`;
    const t = task("none");
    const store = EpisodeStore.open(join(base, "store"), {
      simulated: true,
      host: { ...HOST, home },
    });
    const recorder = new EpisodeRecorder({ host: { ...HOST, home } });
    const { outcome, episode } = await runGatedTrialWithEpisode(
      {
        vault,
        runId: "run-planted",
        taskId: t.taskId,
        tasks: registry(t),
        // env: the agent's MCP server env carries a marker and a key-shaped value.
        plan: plan(base, { PLANTED: PLANTED_MARKER, API_KEY: fakeKey() }),
        // fixture: an extra sealed fixture holding the marker.
        fixtures: { "fixtures/extra.csv": new TextEncoder().encode(`id\n${PLANTED_MARKER}\n`) },
        oracleSources: [oracleCopy, ORACLE_SOURCES[1] as string],
        transport: {
          async runAgent() {
            // The agent types a path under the planted home: redaction scrubs it.
            recorder.action({ kind: "type", text: `${home}/notes.txt` });
          },
          async captureAfterStop() {
            return { "persisted/doc.csv": honestDoc(t) };
          },
        },
      },
      captureFor(store, t, { recorder }),
    );
    expect(outcome.status).toBe("decided");
    expect(episode.status).toBe("written");
    const bytes = storeFiles(store.root);
    expect(bytes).not.toContain(PLANTED_MARKER);
    expect(bytes).not.toContain(fakeKey());
    expect(bytes).not.toContain(base);
    expect(bytes).toContain("<home>/notes.txt");
    expect(readFileSync(join(store.root, "STORE.json"), "utf8")).not.toContain(PLANTED_MARKER);
  });
});

describe("the validator refuses unclean episodes", () => {
  const typed = (text: string) => {
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text });
    const snap = rec.snapshot();
    return buildEpisode(draft({ actions: snap.actions }), new Map(), HOST);
  };

  it("refuses a planted marker (never scrubbed)", () => {
    const r = typed(`hello ${PLANTED_MARKER}`);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("PLANTED_MARKER");
  });

  it("refuses a key-shaped string (never scrubbed)", () => {
    const r = typed(`export KEY=${fakeKey()}`);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain("KEY_SHAPED");
    for (const k of [
      ["ghp", "a".repeat(30)].join("_"),
      ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
      ["xoxb", "1234567890-abc"].join("-"),
    ])
      expect(stringIssues(k, HOST)).toContain("KEY_SHAPED");
  });

  it("does not report content hashes, MIME types, dates or URLs as leaks", () => {
    for (const s of [
      "a".repeat(64),
      "image/png",
      "2026-11-26T10:00:00Z",
      "https://example.com/a/b",
      "and/or",
      "task-fc-v1-001",
    ])
      expect(stringIssues(s, HOST)).toEqual([]);
  });

  it("refuses an absolute path that got past redaction (a field the redactor does not touch)", () => {
    const e = draft();
    const r = buildEpisode(
      {
        ...e,
        task: { ...e.task, id: "t-1" },
        harness: { ...e.harness, arm: "myco-gate" },
        provenance: { ...e.provenance, runId: "run-1" },
      },
      new Map(),
      HOST,
    );
    expect(r.ok).toBe(true);
    // A writer that bypasses the recorder and hands a raw path is refused.
    const raw = JSON.parse(JSON.stringify(r.ok ? r.episode : {}));
    raw.actions = {
      capture: "recorded",
      truncated: false,
      items: [{ seq: 0, atMs: null, kind: "shell", command: "cat /etc/hosts.d/x" }],
    };
    const issues = cleanIssues(raw, HOST).map((i) => i.code);
    expect(issues).toContain("ABSOLUTE_PATH");
    for (const p of ["C:\\Users\\me\\x", "\\\\server\\share\\x", "~/notes", "file:///x"])
      expect(stringIssues(p, HOST)).toContain("ABSOLUTE_PATH");
  });

  it("refuses host identifiers (home, temp, /user)", () => {
    expect(stringIssues("at /home/episode-tester", HOST)).toContain("HOST_IDENTIFIER");
    expect(stringIssues("C:\\episode-tester", HOST)).toContain("HOST_IDENTIFIER");
  });

  it("redaction scrubs host paths but leaves markers and keys for the refusal", () => {
    const out = redactText(
      `open /home/episode-tester/a.csv and /var/tmp-episode/b and /srv/x/y ${PLANTED_MARKER} ${fakeKey()}`,
      HOST,
    );
    expect(out).not.toContain("episode-tester");
    expect(out).not.toContain("/srv/");
    expect(out).toContain(PLANTED_MARKER);
    expect(out).toContain(fakeKey());
  });

  it("an unclean state document is withheld, not altered; the blob backstop refuses it", () => {
    const rec = new EpisodeRecorder({ host: HOST });
    rec.state("persisted", "text/csv", new TextEncoder().encode(`id\n${PLANTED_MARKER}\n`));
    const snap = rec.snapshot();
    expect(snap.observations.items).toHaveLength(0);
    expect(snap.observations.withheld).toBe(1);
    expect(blobIssues(new TextEncoder().encode("/home/x/y"), "text", HOST)).toContain(
      "ABSOLUTE_PATH",
    );
  });
});

describe("screenshots only through the watch view's redaction rules (FrameRedactor)", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

  it("with no redactor every screenshot is withheld", () => {
    const rec = new EpisodeRecorder({ host: HOST });
    rec.screenshot(png);
    expect(rec.snapshot().observations).toMatchObject({ withheld: 1, items: [] });
  });

  it("a refused frame, a non-PNG, or a frame still carrying a marker is withheld", () => {
    const marker = Uint8Array.from([...png, ...new TextEncoder().encode(PLANTED_MARKER)]);
    for (const redact of [() => null, () => new TextEncoder().encode("GIF89a.."), () => marker]) {
      const rec = new EpisodeRecorder({ host: HOST, frameRedactor: { redact } });
      rec.screenshot(png);
      expect(rec.snapshot().observations.withheld).toBe(1);
    }
  });

  it("a redacted frame is stored content-addressed, as the redactor returned it", () => {
    const rec = new EpisodeRecorder({ host: HOST, frameRedactor: { redact: (b) => b } });
    rec.screenshot(png);
    rec.screenshot(png);
    const snap = rec.snapshot();
    expect(snap.observations.items).toHaveLength(2);
    expect(snap.blobs.size).toBe(1);
  });
});

describe("the raw Sai ledger and stray files are never captured", () => {
  it("refuses a store under scripts/sai, ~/.myco/secrets or an evidence pack", () => {
    expect(forbiddenStoreRoot("scripts/sai/episodes")).not.toBeNull();
    expect(forbiddenStoreRoot("/x/.myco/secrets/e")).not.toBeNull();
    expect(forbiddenStoreRoot("docs/research/experiments/m2-x/episodes")).not.toBeNull();
    expect(() => EpisodeStore.open("scripts/sai/episodes", { simulated: true })).toThrow(/Sai/);
  });

  it("a planted ledger file in a store fails the read and the export closed", () => {
    const root = join(dir("stray"), "store");
    EpisodeStore.open(root, { simulated: true, host: HOST });
    writeFileSync(join(root, "sai-ledger.jsonl"), `{"marker":"${PLANTED_MARKER}"}\n`);
    expect(() => readStoreDir(root)).toThrow(/unexpected entry/);
    expect(() =>
      exportDataset({ stores: [root], out: join(dir("out"), "ds"), simulated: true, host: HOST }),
    ).toThrow(/unexpected entry/);
  });

  it("a refusal is logged by code only, never with the offending content", () => {
    const root = join(dir("refuse"), "store");
    const store = EpisodeStore.open(root, { simulated: true, host: HOST });
    const rec = new EpisodeRecorder({ host: HOST });
    rec.action({ kind: "type", text: fakeKey() });
    const r = store.record(draft({ actions: rec.snapshot().actions }));
    expect(r.status).toBe("refused");
    const log = readFileSync(join(root, "refused.jsonl"), "utf8");
    expect(log).toContain("KEY_SHAPED");
    expect(log).not.toContain(fakeKey());
    expect(readdirSync(join(root, "episodes"))).toEqual([]);
  });
});
