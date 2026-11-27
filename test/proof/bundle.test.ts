/**
 * Track Q (replayable proof): round trip and every tamper case. $0: no model, no VM, no network.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportProofBundle,
  PROOF_CLAIM,
  type ProofBundle,
  ProofExportError,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { eventSha256, type LedgerEvent, verifyLedgerChain } from "../../src/proof/ledger.ts";
import {
  buildLedger,
  clone,
  NO_CTX,
  rechain,
  STORE_TEXT,
  sampleLedger,
  sampleRun,
} from "./fixture.ts";

const bundle = () => exportProofBundle(sampleRun(), NO_CTX);
const verify = (b: ProofBundle, opts = {}) => verifyProofBundle(serializeProofBundle(b), opts);
const codes = (b: ProofBundle, opts = {}) => verify(b, opts).errors.map((e) => e.code);

type LooseRecord = { seq: number; prevSha256: string; kind: string; body: Record<string, unknown> };
function mutate(f: (b: { records: LooseRecord[] } & Record<string, unknown>) => void): ProofBundle {
  const b = clone(bundle()) as unknown as { records: LooseRecord[] } & Record<string, unknown>;
  f(b);
  return b as unknown as ProofBundle;
}

describe("proof bundle round trip", () => {
  it("an honest run exports, serializes, parses and verifies, recomputing every digest", () => {
    const b = bundle();
    expect(b.records.map((r) => r.kind)).toEqual([
      "policy",
      "action",
      "action",
      "checkpoint",
      "handoff",
      "action",
      "evidence",
      "evidence",
      "verdict",
      "ledger-anchor",
    ]);
    const r = verify(b);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.simulated).toBe(true);
    expect(r.evidenceRecomputed).toEqual([]);
    expect(r.evidenceDigestOnly).toEqual(["ev-store", "ev-frame"]);
    expect(r.ledgerHead).toEqual(sampleLedger().head);
    expect(b.claim).toBe(PROOF_CLAIM);
    // Deterministic: the same run gives the same head.
    expect(bundle().head.headSha256).toBe(b.head.headSha256);
  });

  it("no artifact is ever inlined (text or frame): only its digest and byte count", () => {
    const evidence = bundle().records.filter((r) => r.kind === "evidence");
    expect(evidence).toHaveLength(2);
    for (const r of evidence) {
      expect(Object.keys(r.body).sort()).toEqual(
        ["bytes", "evidenceId", "kind", "mediaType", "path", "sha256"].sort(),
      );
    }
    const frame = evidence.find(
      (r) => (r.body as { evidenceId: string }).evidenceId === "ev-frame",
    );
    expect(frame?.body).toMatchObject({ bytes: 7 });
    expect(serializeProofBundle(bundle())).not.toContain("buy milk");
  });

  it("digest-only evidence is recomputed from an evidence dir, and a swapped file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-ev-"));
    mkdirSync(join(dir, "run-1"));
    writeFileSync(join(dir, "run-1", "frame-0001.png"), new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    writeFileSync(join(dir, "run-1", ".myco-todo.json"), STORE_TEXT);
    const ok = verify(bundle(), { evidenceDir: dir });
    expect(ok.errors).toEqual([]);
    expect(ok.evidenceRecomputed).toEqual(["ev-store", "ev-frame"]);
    expect(ok.evidenceDigestOnly).toEqual([]);
    // An artifact whose original was swapped on disk is refused.
    writeFileSync(join(dir, "run-1", ".myco-todo.json"), "{}");
    expect(codes(bundle(), { evidenceDir: dir })).toEqual(["PROOF_EVIDENCE_DIGEST"]);
    writeFileSync(join(dir, "run-1", ".myco-todo.json"), STORE_TEXT);
    writeFileSync(join(dir, "run-1", "frame-0001.png"), new Uint8Array([137, 80, 78, 71, 9]));
    expect(codes(bundle(), { evidenceDir: dir })).toContain("PROOF_EVIDENCE_DIGEST");
  });

  it("an evidence path that resolves outside the evidence dir via a symlink is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-ev-"));
    const outside = mkdtempSync(join(tmpdir(), "proof-out-"));
    writeFileSync(join(outside, ".myco-todo.json"), STORE_TEXT);
    writeFileSync(join(outside, "frame-0001.png"), new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    symlinkSync(outside, join(dir, "run-1"));
    expect(codes(bundle(), { evidenceDir: dir })).toContain("PROOF_EVIDENCE");
    expect(verify(bundle(), { evidenceDir: dir }).ok).toBe(false);
  });

  it("a missing evidence file is refused when an evidence dir is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "proof-ev-"));
    expect(codes(bundle(), { evidenceDir: dir })).toContain("PROOF_EVIDENCE_MISSING");
  });

  it("a run with no ledger verifies, and says so (no anchor)", () => {
    const { ledger: _l, ...run } = sampleRun();
    const b = exportProofBundle(run, NO_CTX);
    expect(b.ledger).toBeNull();
    expect(verify(b).ok).toBe(true);
  });
});

describe("tamper cases: every edit, gap, reorder and truncation is refused", () => {
  it("edit: one character of an action summary", () => {
    const b = mutate((x) => {
      (x.records[1]?.body as { summary: string }).summary = "typed 'buy milks'";
    });
    expect(codes(b)).toContain("PROOF_CHAIN");
  });

  it("edit: a verdict flipped to verified (with its codes) breaks the chain", () => {
    const b = mutate((x) => {
      const v = x.records[8]?.body as { verdict: string; accepted: boolean; reasonCodes: string[] };
      v.verdict = "verified";
      v.accepted = true;
      v.reasonCodes = ["ORACLE_PASS"];
    });
    expect(verify(b).ok).toBe(false);
    expect(codes(b)).toContain("PROOF_CHAIN");
  });

  it("edit: the last record (only the head pin catches it)", () => {
    const b = mutate((x) => {
      (x.records[9]?.body as { endSeq: number }).endSeq = 3;
      (x.records[9]?.body as { startSeq: number }).startSeq = 2;
      (x.records[9]?.body as { trialKey: string }).trialKey = "t-ours2";
    });
    expect(codes(b)).toContain("PROOF_TRUNCATED");
  });

  it("R3-S2: only the pinned record count edited (head hash and records intact)", () => {
    const b = mutate((x) => {
      (x.head as { records: number }).records = 99;
    });
    expect(codes(b)).toEqual(["PROOF_TRUNCATED"]);
  });

  it("gap: a record removed from the middle", () => {
    const b = mutate((x) => {
      x.records.splice(3, 1);
    });
    expect(codes(b)).toContain("PROOF_GAP");
  });

  it("gap: a record removed and the rest renumbered", () => {
    const b = mutate((x) => {
      x.records.splice(3, 1);
      x.records.forEach((r, i) => {
        (r as { seq: number }).seq = i;
      });
    });
    expect(codes(b)).toContain("PROOF_CHAIN");
  });

  it("reorder: two records swapped", () => {
    const b = mutate((x) => {
      const [a, c] = [x.records[1], x.records[2]] as [LooseRecord, LooseRecord];
      x.records[1] = c;
      x.records[2] = a;
    });
    expect(codes(b)).toContain("PROOF_GAP");
  });

  it("reorder: two records swapped with their seqs renumbered", () => {
    const b = mutate((x) => {
      const [a, c] = [x.records[1], x.records[2]] as [LooseRecord, LooseRecord];
      x.records[1] = { ...c, seq: 1 };
      x.records[2] = { ...a, seq: 2 };
    });
    expect(codes(b)).toContain("PROOF_CHAIN");
  });

  it("truncation: the tail cut off", () => {
    const b = mutate((x) => {
      x.records.splice(7);
    });
    expect(codes(b)).toContain("PROOF_TRUNCATED");
  });

  it("extension: a record appended without moving the head", () => {
    const b = mutate((x) => {
      const last = x.records.at(-1) as LooseRecord;
      x.records.push({ ...last, seq: x.records.length });
    });
    expect(verify(b).ok).toBe(false);
  });

  it("inline evidence content added by a forger is refused even if re-chained (closed schema)", () => {
    const b = rechain(
      mutate((x) => {
        (x.records[6]?.body as { content: string }).content = STORE_TEXT;
      }),
    );
    expect(codes(b)).toEqual(["PROOF_SCHEMA"]);
  });

  it("a frame inlined by a forger is refused", () => {
    const b = rechain(
      mutate((x) => {
        const e = x.records[7]?.body as Record<string, unknown>;
        e.content = "PNG";
      }),
    );
    expect(codes(b)).toContain("PROOF_SCHEMA");
  });

  it("an inflated claim is refused (no stronger claim than #518's)", () => {
    const b = mutate((x) => {
      x.claim = "Tamper-proof, cryptographically signed record.";
    });
    expect(codes(b)).toEqual(["PROOF_CLAIM"]);
  });

  it("an unknown field anywhere is refused (closed schemas)", () => {
    expect(
      codes(
        mutate((x) => {
          x.extra = 1;
        }),
      ),
    ).toContain("PROOF_SCHEMA");
    expect(
      codes(
        mutate((x) => {
          (x.records[1]?.body as Record<string, unknown>).note = "x";
        }),
      ),
    ).toContain("PROOF_SCHEMA");
    expect(
      codes(
        mutate((x) => {
          (x.records[8]?.body as Record<string, unknown>).reasons = ["free text"];
        }),
      ),
    ).toContain("PROOF_SCHEMA");
  });

  it("a verdict reason that is not a gate code is refused", () => {
    const b = rechain(
      mutate((x) => {
        (x.records[8]?.body as { reasonCodes: string[] }).reasonCodes = [
          "ORACLE_FAIL",
          "LOOKS_GOOD",
        ];
      }),
    );
    expect(codes(b)).toContain("PROOF_SCHEMA");
  });

  it("an inconsistent verdict is refused even when re-chained (a false VERIFIED is never shown)", () => {
    const accepted = rechain(
      mutate((x) => {
        (x.records[8]?.body as { accepted: boolean }).accepted = true;
      }),
    );
    expect(codes(accepted)).toContain("PROOF_VERDICT");
    const noPass = rechain(
      mutate((x) => {
        const v = x.records[8]?.body as { verdict: string; accepted: boolean };
        v.verdict = "verified";
        v.accepted = true;
      }),
    );
    expect(codes(noPass)).toContain("PROOF_VERDICT");
    const passOnRefuted = rechain(
      mutate((x) => {
        (x.records[8]?.body as { reasonCodes: string[] }).reasonCodes = ["ORACLE_PASS"];
      }),
    );
    expect(codes(passOnRefuted)).toContain("PROOF_VERDICT");
  });

  it("a verdict for another run, or citing unrecorded evidence, is refused", () => {
    const other = rechain(
      mutate((x) => {
        (x.records[8]?.body as { runId: string }).runId = "run-2";
      }),
    );
    expect(codes(other)).toContain("PROOF_VERDICT");
    const cite = rechain(
      mutate((x) => {
        (x.records[8]?.body as { evidence: string[] }).evidence = ["ev-nope"];
      }),
    );
    expect(codes(cite)).toContain("PROOF_VERDICT");
    const late = rechain(
      mutate((x) => {
        const v = x.records.splice(8, 1)[0] as LooseRecord;
        x.records.splice(6, 0, v);
      }),
    );
    expect(codes(late)).toContain("PROOF_VERDICT");
  });

  it("an evidence id recorded twice, or with a withheld field, is refused", () => {
    const twice = rechain(
      mutate((x) => {
        (x.records[7]?.body as { evidenceId: string }).evidenceId = "ev-store";
      }),
    );
    expect(codes(twice)).toContain("PROOF_EVIDENCE");
    const both = rechain(
      mutate((x) => {
        (x.records[6]?.body as Record<string, unknown>).withheld = "binary";
      }),
    );
    expect(codes(both)).toContain("PROOF_SCHEMA");
  });

  it("an evidence path written as a string (here an escaping ..) is refused by the schema", () => {
    const b = rechain(
      mutate((x) => {
        (x.records[6]?.body as { path: string }).path = "../outside/x.json";
      }),
    );
    expect(codes(b)).toContain("PROOF_SCHEMA");
  });

  it("an absolute evidence path string (POSIX or drive letter) is refused by the schema", () => {
    for (const path of ["/abs/x.json", "C:/x.json", "c:x.json"]) {
      const b = rechain(
        mutate((x) => {
          (x.records[6]?.body as { path: string }).path = path;
        }),
      );
      expect(codes(b), path).toContain("PROOF_SCHEMA");
    }
  });

  it("the run header is chained: flipping simulated, the arm or the ids is refused", () => {
    for (const edit of [
      (r: Record<string, unknown>) => {
        r.simulated = false;
      },
      (r: Record<string, unknown>) => {
        r.arm = "hcu+shell";
      },
      (r: Record<string, unknown>) => {
        r.runId = "run-2";
      },
    ]) {
      const b = mutate((x) => edit(x.run as Record<string, unknown>));
      // The chain break is the first error (the arm and id edits also trip their bindings).
      expect(codes(b)[0]).toBe("PROOF_CHAIN");
    }
    expect(codes(mutate((x) => ((x.run as Record<string, unknown>).simulated = false)))).toEqual([
      "PROOF_CHAIN",
    ]);
    // Re-chained, it is a whole-bundle regeneration: only the out-of-band head sees it.
    const honest = bundle();
    const forged = rechain(
      mutate((x) => {
        (x.run as Record<string, unknown>).simulated = false;
      }),
    );
    expect(codes(forged, { expectHead: honest.head.headSha256 })).toEqual([
      "PROOF_ANCHOR_MISMATCH",
    ]);
  });

  it("a verdict that is not myco.gate/v1 is refused, even re-chained", () => {
    const b = rechain(
      mutate((x) => {
        (x.records[8]?.body as { gateApi: string }).gateApi = "myco.gate/v2";
      }),
    );
    expect(codes(b)).toContain("PROOF_SCHEMA");
  });

  it("not JSON is refused", () => {
    expect(verifyProofBundle("{").errors.map((e) => e.code)).toEqual(["PROOF_SCHEMA"]);
  });
});

describe("the attempt ledger (#518 format) inside the bundle", () => {
  it("an edited ledger event is refused", () => {
    const b = mutate((x) => {
      (
        (x.ledger as { events: Record<string, unknown>[] }).events[1] as Record<string, unknown>
      ).outcome = "harness-fault";
    });
    expect(codes(b)).toContain("PROOF_LEDGER_CHAIN");
  });

  it("a ledger gap or reordering is refused", () => {
    const gap = mutate((x) => {
      (x.ledger as { events: unknown[] }).events.splice(1, 1);
    });
    expect(codes(gap)).toContain("PROOF_LEDGER_CHAIN");
    const swap = mutate((x) => {
      const ev = (x.ledger as { events: unknown[] }).events;
      [ev[0], ev[1]] = [ev[1], ev[0]];
    });
    expect(codes(swap)).toContain("PROOF_LEDGER_CHAIN");
  });

  it("a truncated ledger is refused against the anchored head", () => {
    const b = mutate((x) => {
      (x.ledger as { events: unknown[] }).events.splice(3);
    });
    expect(codes(b)).toContain("PROOF_LEDGER_HEAD");
  });

  it("a ledger with no anchor, or an anchor with no ledger, is refused", () => {
    const noAnchor = rechain(
      mutate((x) => {
        x.records.pop();
      }),
    );
    expect(codes(noAnchor)).toContain("PROOF_LEDGER_ANCHOR");
    const noLedger = mutate((x) => {
      x.ledger = null;
    });
    expect(codes(noLedger)).toContain("PROOF_LEDGER_ANCHOR");
  });

  it("an anchor pointing at another trial or the wrong events is refused", () => {
    const other = rechain(
      mutate((x) => {
        Object.assign(x.records[9]?.body as object, {
          trialKey: "t-other",
          startSeq: 0,
          endSeq: 1,
        });
      }),
    );
    expect(codes(other)).toContain("PROOF_LEDGER_ANCHOR");
    const wrong = rechain(
      mutate((x) => {
        Object.assign(x.records[9]?.body as object, { startSeq: 0 });
      }),
    );
    expect(codes(wrong)).toContain("PROOF_LEDGER_ANCHOR");
  });

  it("a trial started twice in the ledger is refused", () => {
    const l = buildLedger([
      { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate" },
      { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate" },
      { kind: "end", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate", outcome: "completed" },
    ]);
    expect(() =>
      exportProofBundle({ ...sampleRun(), ledger: { ...l, trialKey: "t-ours" } }, NO_CTX),
    ).toThrow(/PROOF_LEDGER_ANCHOR/);
  });

  it("the exporter refuses a broken ledger, a ledger off its pin, and a run not in the ledger", () => {
    const l = sampleLedger();
    const broken = clone(l.lines);
    (broken[2] as { taskId: string }).taskId = "df-s01";
    expect(() =>
      exportProofBundle(
        { ...sampleRun(), ledger: { lines: broken, head: l.head, trialKey: "t-ours" } },
        NO_CTX,
      ),
    ).toThrow(ProofExportError);
    expect(() =>
      exportProofBundle(
        {
          ...sampleRun(),
          ledger: { lines: l.lines.slice(0, 3), head: l.head, trialKey: "t-ours" },
        },
        NO_CTX,
      ),
    ).toThrow(/PROOF_LEDGER_HEAD/);
    expect(() =>
      exportProofBundle({ ...sampleRun(), ledger: { ...l, trialKey: "t-none" } }, NO_CTX),
    ).toThrow(/PROOF_LEDGER_ANCHOR/);
  });

  it("a trial whose end is recorded before its start is refused", () => {
    const l = buildLedger([
      { kind: "end", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate", outcome: "completed" },
      { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "myco-gate" },
    ]);
    expect(() =>
      exportProofBundle({ ...sampleRun(), ledger: { ...l, trialKey: "t-ours" } }, NO_CTX),
    ).toThrow(/ends before it starts/);
  });

  it("a schema-valid edit of an early ledger event breaks the chain (the head alone would not see it)", () => {
    const b = mutate((x) => {
      const ev = (x.ledger as { events: Record<string, unknown>[] }).events;
      (ev[0] as Record<string, unknown>).taskId = "df-s09";
    });
    expect(codes(b)).toContain("PROOF_LEDGER_CHAIN");
  });

  it("a ledger with a dropped prefix, re-chained but not renumbered, is refused (seq != index)", () => {
    const full = sampleLedger().lines.slice(2);
    let prev = "0".repeat(64);
    const lines = full.map((e) => {
      const next = { ...e, prevSha256: prev };
      prev = eventSha256(next);
      return next;
    });
    expect(() =>
      exportProofBundle(
        {
          ...sampleRun(),
          ledger: { lines, head: { events: 2, headSha256: prev }, trialKey: "t-ours" },
        },
        NO_CTX,
      ),
    ).toThrow(/ledger event 0 fails #518's check/);
  });

  it("a ledger event with an unknown field is refused, even when chained", () => {
    const base = sampleLedger().lines.map((e) => ({ ...e }) as Record<string, unknown>);
    (base[0] as Record<string, unknown>).note = "extra";
    let prev = "0".repeat(64);
    const lines = base.map((e) => {
      const next = { ...e, prevSha256: prev } as unknown as LedgerEvent;
      prev = eventSha256(next);
      return next;
    });
    expect(() =>
      exportProofBundle(
        {
          ...sampleRun(),
          ledger: { lines, head: { events: 4, headSha256: prev }, trialKey: "t-ours" },
        },
        NO_CTX,
      ),
    ).toThrow(/PROOF_LEDGER_CHAIN: ledger event 0 fails #518's check/);
  });

  it("a ledger trial for another task is refused", () => {
    const l = buildLedger([
      { kind: "start", trialKey: "t-ours", taskId: "df-s01", arm: "myco-gate" },
      { kind: "end", trialKey: "t-ours", taskId: "df-s01", arm: "myco-gate", outcome: "completed" },
    ]);
    expect(() =>
      exportProofBundle({ ...sampleRun(), ledger: { ...l, trialKey: "t-ours" } }, NO_CTX),
    ).toThrow(/another task/);
  });
});

describe("the run's arm and the ledger trial's arm", () => {
  const hcuLedger = () =>
    buildLedger([
      { kind: "start", trialKey: "t-ours", taskId: "df-s02", arm: "hcu+shell" },
      { kind: "end", trialKey: "t-ours", taskId: "df-s02", arm: "hcu+shell", outcome: "completed" },
    ]);

  it("an hcu+shell run exports and verifies (the arm may carry +)", () => {
    const b = exportProofBundle(
      { ...sampleRun(), arm: "hcu+shell", ledger: { ...hcuLedger(), trialKey: "t-ours" } },
      NO_CTX,
    );
    expect(b.run.arm).toBe("hcu+shell");
    expect(verify(b).ok).toBe(true);
  });

  it("a run whose arm differs from its ledger trial's arm is refused (export and verify)", () => {
    expect(() =>
      exportProofBundle(
        { ...sampleRun(), arm: "myco-gate", ledger: { ...hcuLedger(), trialKey: "t-ours" } },
        NO_CTX,
      ),
    ).toThrow(/another arm/);
    const forged = rechain(
      mutate((x) => {
        (x.run as Record<string, unknown>).arm = "hcu+shell";
      }),
    );
    expect(codes(forged)).toEqual(["PROOF_LEDGER_ANCHOR"]);
  });

  it("a ledger-anchored run that states no arm is refused", () => {
    const { arm: _a, ...run } = sampleRun();
    expect(() => exportProofBundle(run, NO_CTX)).toThrow(/must state its arm/);
  });
});

describe("ledger event rules (#518's own check, messages never echo a value)", () => {
  type In = Parameters<typeof buildLedger>[0][number];
  const chainOf = (events: readonly Record<string, unknown>[]) =>
    verifyLedgerChain(buildLedger(events as unknown as In[]).lines).errors;
  const start = { kind: "start", trialKey: "t", taskId: "df-s02", arm: "myco-gate" };
  const end = { ...start, kind: "end", outcome: "completed" };

  it("a well-formed start/end pair passes (control)", () => {
    expect(chainOf([start, end])).toEqual([]);
    expect(chainOf([start, { ...end, outcome: "harness-fault", harnessClass: "timeout" }])).toEqual(
      [],
    );
  });

  it("an arm outside the ledger's arms is refused", () => {
    expect(chainOf([{ ...start, arm: "other-arm" }])).toEqual([
      "ledger event 0 fails #518's check (1 issue(s))",
    ]);
  });

  it("a start event that carries an outcome is refused", () => {
    expect(chainOf([{ ...start, outcome: "completed" }])).toEqual([
      "ledger event 0 fails #518's check (1 issue(s))",
    ]);
  });

  it("an end event without an outcome is refused", () => {
    const { outcome: _o, ...bare } = end;
    expect(chainOf([start, bare])).toEqual(["ledger event 1 fails #518's check (1 issue(s))"]);
  });

  it("a harness class exactly when the outcome is harness-fault", () => {
    const msg = "ledger event 1 fails #518's check (1 issue(s))";
    expect(chainOf([start, { ...end, harnessClass: "timeout" }])).toEqual([msg]);
    expect(chainOf([start, { ...end, outcome: "harness-fault" }])).toEqual([msg]);
  });

  it("an unknown field is refused without echoing its name", () => {
    const errors = chainOf([{ ...start, PLANTEDKEYNAME: 1 }]);
    expect(errors).toEqual(["ledger event 0 fails #518's check (1 issue(s))"]);
    expect(JSON.stringify(errors)).not.toContain("PLANTED");
  });
});

describe("out-of-band anchors, and the stated limit", () => {
  it("expectHead and expectLedgerHead pass when they match and refuse when they do not", () => {
    const b = bundle();
    expect(
      verify(b, { expectHead: b.head.headSha256, expectLedgerHead: sampleLedger().head.headSha256 })
        .ok,
    ).toBe(true);
    expect(codes(b, { expectHead: "0".repeat(64) })).toEqual(["PROOF_ANCHOR_MISMATCH"]);
    expect(codes(b, { expectLedgerHead: "0".repeat(64) })).toEqual(["PROOF_ANCHOR_MISMATCH"]);
    const { ledger: _l, ...run } = sampleRun();
    expect(codes(exportProofBundle(run, NO_CTX), { expectLedgerHead: "0".repeat(64) })).toEqual([
      "PROOF_ANCHOR_MISMATCH",
    ]);
  });

  it("STATED LIMIT: a forger who regenerates the whole bundle passes WITHOUT an out-of-band head", () => {
    // Truncate and re-pin: the chain is unkeyed and the head travels in the bundle. This
    // is #518's limit, inherited, and the reason the claim says "the trusted harness is the
    // boundary". Only a head received out of band catches it.
    const honest = bundle();
    const forged = rechain(
      mutate((x) => {
        x.records.splice(1, 2);
      }),
    );
    expect(verify(forged).ok).toBe(true);
    expect(codes(forged, { expectHead: honest.head.headSha256 })).toEqual([
      "PROOF_ANCHOR_MISMATCH",
    ]);
  });
});
