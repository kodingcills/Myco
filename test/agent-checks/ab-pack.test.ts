/**
 * Track C, round 2 of #590 (D2): an agent-written check signal is never evidence on the A/B
 * pack path either. `checkAbPack` (src/m2/ab-pack.ts) is what `scripts/m2-evidence-check.ts`
 * runs on an A/B pack, and the scorecard's AB row (`scripts/m2-scorecard-check.py`) cites A/B
 * packs only through it. Round 1 found that a full signal in both arms' `run-config.json`
 * passed `checkAbPack`; every record of the pack is now scanned.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_CHECK_EVIDENCE_CLASS,
  AGENT_CHECK_SIGNAL_KIND,
  AGENT_CHECK_SOURCE,
} from "../../src/agent-checks/label.ts";
import { type AbPackInput, checkAbPack, readAbPack } from "../../src/m2/ab-pack.ts";
import { PREREG_MD } from "../../src/pilot/ab-prereg.ts";
import { abConfig, writeAbPack } from "../m2/ab-fixture.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const AGENT = /agent-written check signal.*advisory only, never evidence/;
const T = 120_000;

/** What `runAgentCheck` returns (its shape, without running a sandbox). */
const signal = {
  kind: AGENT_CHECK_SIGNAL_KIND,
  advisory: true,
  r1Evidence: false,
  evidenceClass: AGENT_CHECK_EVIDENCE_CLASS,
  status: "verified",
  code: "TARGET_OK",
  codeSource: "check",
  provenance: { source: AGENT_CHECK_SOURCE, taskId: "t", runId: "r", family: "calc-record-edit" },
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function fresh(): string {
  const r = mkdtempSync(join(tmpdir(), "track-c-ab-"));
  roots.push(r);
  return r;
}

function stage1(): AbPackInput {
  const root = fresh();
  return readAbPack(writeAbPack("m2-ab-s1", { stage: 1 }, root), root);
}

describe("D2: checkAbPack refuses an agent-written check signal in every record", () => {
  it("control: the clean Stage-1 pack passes with no agent-check error", () => {
    const r = checkAbPack(stage1());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("the round-1 repro: a full signal in both arms' run-config.json", () => {
    const base = stage1();
    const withSignal = (c: unknown) => ({ ...(c as object), agentCheck: signal });
    const r = checkAbPack({
      ...base,
      on: { ...base.on, runConfig: withSignal(base.on.runConfig) },
      off: { ...base.off, runConfig: withSignal(base.off.runConfig) },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(AGENT);
    expect(r.errors.join("\n")).toMatch(/on\/run-config\.json/);
    expect(r.errors.join("\n")).toMatch(/off\/run-config\.json/);
  });

  it("every other record: manifest, ops, stage0, arm and grade rows, one marker at a time", () => {
    const base = stage1();
    const s0 = base.stage0 as NonNullable<AbPackInput["stage0"]>;
    const ops = base.on.ops as Record<string, unknown>[];
    const markers = [
      signal,
      { kind: AGENT_CHECK_SIGNAL_KIND },
      { evidenceClass: AGENT_CHECK_EVIDENCE_CLASS },
      { provenance: { source: AGENT_CHECK_SOURCE } },
    ];
    for (const m of markers) {
      const attempts: Record<string, AbPackInput> = {
        manifest: { ...base, manifest: { ...(base.manifest as object), note: m } },
        onOps: { ...base, on: { ...base.on, ops: [{ ...ops[0], note: m }, ...ops.slice(1)] } },
        offOps: { ...base, off: { ...base.off, ops: [...base.off.ops, m] } },
        onConfig: { ...base, on: { ...base.on, runConfig: { ...abConfig("on"), x: [m] } } },
        stage0On: { ...base, stage0: { ...s0, on: [...s0.on, m] } },
        stage0Off: { ...base, stage0: { on: s0.on, off: [{ ...(s0.off[0] as object), m }] } },
        arm: { ...base, on: { ...base.on, arm: [...base.on.arm, m] } },
        grades: { ...base, off: { ...base.off, grades: [...base.off.grades, m] } },
      };
      for (const [what, a] of Object.entries(attempts)) {
        const r = checkAbPack(a);
        const label = `${what} ${JSON.stringify(m).slice(0, 40)}`;
        expect(r.ok, label).toBe(false);
        expect(r.errors.join("\n"), label).toMatch(AGENT);
      }
    }
  });
});

describe("D2: the scorecard's AB row refuses a pack that carries a signal", () => {
  it(
    "the same pack cited clean is REPORTED; with a signal in its run configs it is refused",
    () => {
      const root = fresh();
      const prereg = { root: REPO, file: PREREG_MD };
      writeAbPack("m2-ab-clean", { stage: 1, preregRepoFile: prereg }, root);
      const configs = {
        on: { ...abConfig("on"), agentCheck: signal },
        off: { ...abConfig("off"), agentCheck: signal },
      };
      writeAbPack("m2-ab-signal", { stage: 1, preregRepoFile: prereg, configs }, root);
      const doc = readFileSync(join(REPO, "docs/m2-scorecard.md"), "utf8");
      const line = doc.split("\n").find((l) => l.startsWith("| AB |")) as string;
      const pending = "| PENDING | — | — |";
      expect(line.endsWith(pending)).toBe(true);
      const run = (pack: string) => {
        const dir = mkdtempSync(join(tmpdir(), "track-c-ab-doc-"));
        roots.push(dir);
        const cells = `| REPORTED | \`docs/research/experiments/${pack}/\` | x |`;
        writeFileSync(
          join(dir, "doc.md"),
          doc.replace(line, `${line.slice(0, -pending.length)}${cells}`),
        );
        const r = spawnSync(
          "python3",
          ["scripts/m2-scorecard-check.py", "--doc", join(dir, "doc.md"), "--evidence-root", root],
          { encoding: "utf8", timeout: T, cwd: REPO },
        );
        return { status: r.status, stderr: r.stderr };
      };
      // Clean: the pack passes every gate; only the placeholder figures ("x") mismatch.
      const clean = run("m2-ab-clean");
      expect(clean.stderr).not.toMatch(/A\/B pack passes every gate/);
      expect(clean.stderr).toMatch(/AB recomputed figures/);
      const signalled = run("m2-ab-signal");
      expect(signalled.status).not.toBe(0);
      expect(signalled.stderr).toMatch(/A\/B pack passes every gate/);
      expect(signalled.stderr).toMatch(AGENT);
    },
    T,
  );
});
