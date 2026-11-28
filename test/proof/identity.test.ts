/**
 * Track Q, #553 round 3: the identity guard (lead ruling 21:52Z). A bare host username, or
 * any configured identity string (account name, full name, hostname), is a leak on its own,
 * not only inside a path. These tests plant the CURRENT host's real account name and
 * hostname (read here, at test time, and never printed: no assertion message carries a
 * value), their upper- and mixed-case variants, a full name with a space, and names embedded
 * in ids, tokens and codes, into every input field, and check that none reaches any output,
 * with the backstop ON (export with self-verify, verify, report, CLI) and OFF (the allowlist
 * step alone: `assembleProofBundle`, verify and report with no redaction or identity).
 *
 * How absence is checked without printing a value:
 *  - structurally: the planted run's outputs are walked against a NEUTRAL run's (same
 *    shape, a neutral value). Every string that differs is value-derived and must not
 *    contain any identity string in the guard's normal form (lower case, letters and digits
 *    only), unless it is a digest. This holds for needles of any length, even a 2-character
 *    hostname;
 *  - byte-wise: in every output byte (bundle, verify result, report, CLI stdout and files),
 *    each identity string of 3+ characters (8+ when it is all hex, which a digest could
 *    spell by chance) occurs, case-insensitively, no more often than in the neutral run's
 *    output (where it can only be part of a constant such as the claim).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEpisode } from "../../src/episode/validate.ts";
import { POLICY_AGENT_CODES, POLICY_DECISION_CODES } from "../../src/policy/codes.ts";
import type { RedactionContext } from "../../src/proof/backstop.ts";
import {
  assembleProofBundle,
  exportProofBundle,
  type ProofBundle,
  ProofExportError,
  type ProofRunInput,
  serializeProofBundle,
  verifyProofBundle,
} from "../../src/proof/bundle.ts";
import { main } from "../../src/proof/cli.ts";
import {
  allowlist,
  closedPolicyCode,
  hashedId,
  POLICY_REASON_CODES,
} from "../../src/proof/closed.ts";
import {
  compileIdentity,
  hostIdentity,
  type IdentityContext,
  identityNormal,
  SHAPES_ONLY,
} from "../../src/proof/identity.ts";
import { renderProofReport } from "../../src/proof/report.ts";
import {
  buildLedger,
  clone,
  NO_CTX,
  rechain,
  sampleEpisode,
  sampleRun,
  sampleRunWithEpisode,
} from "./fixture.ts";
import { plantEverywhere, withoutEpisode } from "./plant.ts";

// ---------------------------------------------------------------------------------------
// The host's identity, read at test time. NEVER printed.

const HOST_USER = (() => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
})();
const HOST_NAME = hostname();
/** A synthetic full name (the host's real one is not readable portably): first and last. */
const FIRST = "Zqfirstname";
const LAST = "Zqlastname";
const FULL_NAME = `${FIRST} ${LAST}`;

const DIR = mkdtempSync(join(tmpdir(), "proof-identity-"));
const IDENTITY_FILE = join(DIR, "identity.txt");
writeFileSync(IDENTITY_FILE, `${FULL_NAME}\n`);

/** What the CLI builds: host account name, hostname, home, plus the identity file. */
const IDENTITY: IdentityContext = hostIdentity({ identityFile: IDENTITY_FILE });
/** The backstop's context with the same names (backstop ON). */
const CTX_ON: RedactionContext = {
  secrets: [],
  vaultKeys: [],
  hostPaths: [homedir()],
  usernames: [HOST_USER, HOST_NAME, FULL_NAME].filter((s) => s.length > 0),
};

/** The identity strings that must not reach an output (raw, any case). */
const NEEDLES: readonly string[] = [HOST_USER, HOST_NAME, FULL_NAME, FIRST, LAST].filter(
  (s) => identityNormal(s).length >= 2,
);

const mixedCase = (s: string) =>
  [...s].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join("");

/** Planted values, labelled (a label never carries the value). */
const ALL_PLANTS: ReadonlyArray<readonly [string, string]> = [
  ["host username", HOST_USER],
  ["host username, upper case", HOST_USER.toUpperCase()],
  ["host username, mixed case", mixedCase(HOST_USER)],
  ["hostname", HOST_NAME],
  ["hostname, upper case", HOST_NAME.toUpperCase()],
  ["hostname, mixed case", mixedCase(HOST_NAME)],
  ["full name with a space", FULL_NAME],
  ["full name, no separator", `${FIRST}${LAST}`],
  ["full name, dotted lower case", `${FIRST}.${LAST}`.toLowerCase()],
  ["first name alone, upper case", FIRST.toUpperCase()],
  ["username in an id", `run-${HOST_USER}-1`],
  ["username with no separator", `x${HOST_USER}y`],
  ["username in a code", `${HOST_USER.toUpperCase()}_DENIED`],
  ["username in a token", `tok_${mixedCase(HOST_USER)}.v2`],
  ["hostname in a token", `${HOST_NAME}.trial-7`],
  ["hostname in a code", `HOST_${HOST_NAME.toUpperCase()}`],
  ["full name in an id", `agent-${FIRST}-${LAST}`],
  ["code-shaped upper-case token (r2 N1)", "ZQGPTRR"],
];
const PLANTS = ALL_PLANTS.filter(([, v]) => v.length > 0);

const NEUTRAL = "zq-neutral-value";

// ---------------------------------------------------------------------------------------
// Absence checks that never print a value

const DIGEST = /^(?:h-[0-9a-f]{60}|[0-9a-f]{64})$/;

function countCI(text: string, needle: string): number {
  const t = text.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) count++;
  return count;
}

/** Byte-wise: no identity string occurs more often than in the neutral output. */
function bytesClean(planted: string, neutral: string, where: string): void {
  for (const [i, n] of NEEDLES.entries()) {
    const min = /^[0-9a-f]+$/i.test(n) ? 8 : 3;
    if (n.length < min) continue;
    if (countCI(planted, n) > countCI(neutral, n))
      expect.fail(`${where}: identity string #${i} occurs in an output byte`);
  }
}

/**
 * Structurally: walk planted and neutral in parallel; a string (value or key) that differs
 * from the neutral one at the same place is value-derived and must carry no identity string
 * in normal form, unless it is a digest.
 */
function structureClean(planted: unknown, neutral: unknown, where: string): void {
  const needles = NEEDLES.map(identityNormal);
  const check = (s: string, path: string) => {
    if (DIGEST.test(s)) return;
    const v = identityNormal(s);
    for (const [i, n] of needles.entries())
      if (v.includes(n)) expect.fail(`${where}: ${path} carries identity string #${i}`);
  };
  const walk = (p: unknown, n: unknown, path: string) => {
    if (typeof p === "string") {
      if (p !== n) check(p, path);
    } else if (Array.isArray(p)) {
      p.forEach((x, i) => {
        walk(x, Array.isArray(n) ? n[i] : undefined, `${path}[${i}]`);
      });
    } else if (p !== null && typeof p === "object") {
      const no = n !== null && typeof n === "object" ? (n as Record<string, unknown>) : {};
      for (const [k, x] of Object.entries(p)) {
        if (!(k in no)) check(k, `${path}.<key>`);
        walk(x, no[k], `${path}.${k}`);
      }
    }
  };
  walk(planted, neutral, "$");
}

/** The episode only when #542 accepts it (an episode it refuses is refused by export). */
function runFor(value: string): ProofRunInput {
  const run = plantEverywhere(value);
  return run.episode !== undefined && validateEpisode(run.episode).length > 0
    ? withoutEpisode(run)
    : run;
}

interface Outputs {
  bundle: ProofBundle;
  text: string;
  result: string;
  html: string;
}

/** Backstop ON: export (self-verify with ctx and identity), verify with both, report. */
function pipelineOn(run: ProofRunInput): Outputs {
  const bundle = exportProofBundle(run, CTX_ON, IDENTITY);
  const text = serializeProofBundle(bundle);
  const result = verifyProofBundle(text, {
    redaction: CTX_ON,
    identity: IDENTITY,
    ...(run.episode === undefined ? {} : { episode: run.episode }),
  });
  if (!result.ok) expect.fail(`verify refused: ${result.errors.map((e) => e.code).join(",")}`);
  expect(result.episodeChecked).toBe(run.episode !== undefined);
  const html = renderProofReport(bundle, result, CTX_ON);
  return { bundle, text, result: JSON.stringify(result), html };
}

/** Backstop OFF: the allowlist step alone, then verify and report with no scan context. */
function pipelineOff(run: ProofRunInput): Outputs {
  const bundle = assembleProofBundle(run, IDENTITY);
  const text = serializeProofBundle(bundle);
  const result = verifyProofBundle(text, run.episode === undefined ? {} : { episode: run.episode });
  if (!result.ok) expect.fail(`verify refused: ${result.errors.map((e) => e.code).join(",")}`);
  const html = renderProofReport(bundle, result, NO_CTX);
  return { bundle, text, result: JSON.stringify(result), html };
}

function expectClean(p: Outputs, n: Outputs, where: string): void {
  structureClean(JSON.parse(p.text), JSON.parse(n.text), `${where} bundle`);
  bytesClean(p.text, n.text, `${where} bundle`);
  bytesClean(p.result, n.result, `${where} verify result`);
  bytesClean(p.html, n.html, `${where} report`);
}

/** The refusal message carries the class and location only: never the value. */
function expectIdentityRefusal(fn: () => unknown, where: string): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (!(error instanceof ProofExportError)) expect.fail(`${where}: not refused`);
  expect(error.code).toBe("PROOF_IDENTITY");
  expect(error.message).toMatch(
    /^PROOF_IDENTITY: ledger event \d+: (trialKey|taskId) carries a value of class (identity|home-path|key-like)$/,
  );
}

// ---------------------------------------------------------------------------------------

describe("the identity guard (unit, synthetic names)", () => {
  const g = compileIdentity({
    names: ["Zqalice", "Zqfirst Zqlast", "zqbox.example.lan"],
    homes: ["/home/zqhomeuser"],
  });

  it("contains, case-insensitively, through separators", () => {
    for (const v of [
      "zqalice",
      "ZQALICE",
      "ZqAlIcE",
      "run-zqalice-1",
      "xzqalicey",
      "ZQALICE_CODE",
      "z.q.a.l.i.c.e",
    ])
      expect(g.hit(v), "a name form").toBe("identity");
    expect(g.hit("run-1")).toBeNull();
    expect(g.hit("zqalic")).toBeNull();
  });

  it("a full name: whole (any separator or none) and each word of 3+ characters", () => {
    for (const v of ["Zqfirst Zqlast", "zqfirst.zqlast", "ZQFIRSTZQLAST", "ZQFIRST", "zqlast-1"])
      expect(g.hit(v), "a full-name form").toBe("identity");
  });

  it("a hostname: whole and by its first DNS label; a home: whole and by its last segment", () => {
    expect(g.hit("zqbox-trial")).toBe("identity");
    expect(g.hit("ZQBOXEXAMPLELAN")).toBe("identity");
    expect(g.hit("zqhomeuser")).toBe("home-path");
    expect(g.hit("homezqhomeuser")).toBe("home-path");
  });

  it("generic shapes: key-like, home paths, user@host", () => {
    expect(SHAPES_ONLY.hit(`sk_${"PLANTEDPLANTED"}`)).toBe("key-like");
    expect(SHAPES_ONLY.hit(`ghp_${"A".repeat(20)}`)).toBe("key-like");
    expect(SHAPES_ONLY.hit("/home/zqx/y")).toBe("home-path");
    expect(SHAPES_ONLY.hit("zqx@zqhost")).toBe("identity");
    expect(SHAPES_ONLY.hit("run-1")).toBeNull();
  });

  it("a configured string under MIN_IDENTITY characters is not matched (stated limit)", () => {
    expect(compileIdentity({ names: ["q"], homes: [] }).hit("quick")).toBeNull();
    expect(compileIdentity({ names: ["qz"], homes: [] }).hit("aqzb")).toBe("identity");
  });

  it("the exporter's id closer digests a hit; enum closers are constants", () => {
    const a = allowlist(g);
    expect(a.id("run-zqalice", "$.run.runId")).toBe(hashedId("run-zqalice"));
    expect(a.id("run-1", "$.run.runId")).toBe("run-1");
    expect(a.arm("ZQALICE", "$.run.arm")).toBe(hashedId("ZQALICE"));
    expect(a.arm("hcu+shell", "$.run.arm")).toBe("hcu+shell");
  });

  it("host identity reads the account name, hostname, home and the identity file", () => {
    expect(IDENTITY.names).toContain(HOST_NAME);
    if (HOST_USER !== "") expect(IDENTITY.names).toContain(HOST_USER);
    expect(IDENTITY.names).toContain(FULL_NAME);
    expect(IDENTITY.homes).toEqual([homedir()]);
  });
});

describe("library export defaults to the host's identity; constants of the format are exempt", () => {
  it("exportProofBundle with no identity argument still digests the host's name", () => {
    const run = sampleRun();
    for (const id of [`run-${HOST_NAME}`, ...(HOST_USER === "" ? [] : [`run-${HOST_USER}`])]) {
      const b = exportProofBundle({ ...run, runId: id, steps: [] }, NO_CTX);
      expect(b.run.runId === hashedId(id)).toBe(true);
    }
  });

  it("an identity equal to an enum member or schema word does not refuse an honest bundle", () => {
    // `agent` (actor enum), `verified`, `evidence`, `body` (schema words): constants of the
    // format, not host values. Ids that contain them are digested; the constants stay.
    const names = ["agent", "verified", "evidence", "body", "myco-gate"];
    const b = exportProofBundle(sampleRunWithEpisode(), NO_CTX, { names, homes: [] });
    const text = serializeProofBundle(b);
    const r = verifyProofBundle(text, { identity: { names, homes: [] }, episode: sampleEpisode() });
    expect(r.ok).toBe(true);
    expect(r.episodeChecked).toBe(true);
    // ... while the id `agent-a` (handoff.from) was digested.
    expect(text).toContain(hashedId("agent-a"));
  });
});

describe("r2 N1: policy reason codes are a closed enum", () => {
  it("pinned list: the gate's REASON_CODES plus the repo's policy and handoff codes", () => {
    // Track O's closed enums are appended after the repo's earlier codes (pinned in
    // test/policy/codes.test.ts); the earlier ten stay exactly as they were.
    const tail = POLICY_DECISION_CODES.length + POLICY_AGENT_CODES.length;
    expect(POLICY_REASON_CODES.slice(-tail)).toEqual([
      ...POLICY_DECISION_CODES,
      ...POLICY_AGENT_CODES,
    ]);
    expect(POLICY_REASON_CODES.slice(-tail - 10, -tail)).toEqual([
      "POLICY_ALLOW",
      "POLICY_DENIED",
      "POLICY_ERROR",
      "POLICY_INVALID",
      "TASK_NOT_ALLOWED",
      "HUMAN_REJECTED",
      "STILL_PAUSED",
      "HANDOFF_TIMEOUT",
      "HANDOFF_CANCELLED",
      "ATTEMPT_ENDED",
    ]);
    for (const c of POLICY_REASON_CODES) expect(closedPolicyCode(c)).toBe(c);
  });

  it("an upper-case code-shaped value outside the enum is digested, in the bundle too", () => {
    for (const v of ["ZQGPTRR", "POLICY_ALLOWX", "ROOT", "ZQ_USER_NAME"])
      expect(closedPolicyCode(v)).toBe(hashedId(v));
    const run = sampleRun();
    const steps = run.steps.map((s) => (s.kind === "policy" ? { ...s, reasonCode: "ZQGPTRR" } : s));
    const text = serializeProofBundle(exportProofBundle({ ...run, steps }, NO_CTX));
    expect(text.includes("ZQGPTRR")).toBe(false);
    expect(text).toContain(hashedId("ZQGPTRR"));
  });

  it("a forged, re-chained bundle with a code-shaped reasonCode is refused (PROOF_SCHEMA)", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[0]?.body as { reasonCode: string }).reasonCode = "ZQGPTRR";
    const r = verifyProofBundle(serializeProofBundle(rechain(b)));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("PROOF_SCHEMA");
  });
});

describe("the host's real identity planted in every input field never reaches an output", () => {
  const neutralOn = pipelineOn(runFor(NEUTRAL));
  const neutralOff = pipelineOff(runFor(NEUTRAL));

  for (const [label, value] of PLANTS) {
    it(`${label}: backstop ON (export, verify, report)`, () => {
      expectClean(pipelineOn(runFor(value)), neutralOn, label);
    });
    it(`${label}: backstop OFF (the allowlist alone)`, () => {
      expectClean(pipelineOff(runFor(value)), neutralOff, label);
    });
  }

  it("the planted episode is carried and cross-checked for an id-shaped identity value", () => {
    // `run-<user>-1` is an id #542 accepts: the projection compares hashed ids to raw ones.
    const run = plantEverywhere(`run-${HOST_USER || "zquser"}-1`);
    expect(validateEpisode(run.episode)).toEqual([]);
    const off = pipelineOff(run);
    expect(off.bundle.run.episode).not.toBeNull();
    expect(JSON.parse(off.result).episodeChecked).toBe(true);
  });

  it("an identity string in a ledger id refuses the export, ON and OFF, naming no value", () => {
    for (const [label, value] of PLANTS) {
      const id = `t-${value.replace(/[^A-Za-z0-9._-]/g, "")}`;
      if (compileIdentity(IDENTITY).hit(id) === null) continue;
      const ledger = buildLedger([
        { kind: "start", trialKey: id, taskId: "df-s02", arm: "myco-gate" },
        { kind: "end", trialKey: id, taskId: "df-s02", arm: "myco-gate", outcome: "completed" },
      ]);
      const run = {
        ...sampleRun(),
        ledger: { lines: ledger.lines, head: ledger.head, trialKey: id },
      };
      expectIdentityRefusal(() => exportProofBundle(run, CTX_ON, IDENTITY), `${label} ON`);
      expectIdentityRefusal(() => assembleProofBundle(run, IDENTITY), `${label} OFF`);
      const asTask = buildLedger([
        { kind: "start", trialKey: "t-ours", taskId: id, arm: "myco-gate" },
        { kind: "end", trialKey: "t-ours", taskId: id, arm: "myco-gate", outcome: "completed" },
      ]);
      const run2 = {
        ...sampleRun(),
        taskId: id,
        ledger: { lines: asTask.lines, head: asTask.head, trialKey: "t-ours" },
      };
      expectIdentityRefusal(() => assembleProofBundle(run2, IDENTITY), `${label} taskId OFF`);
    }
  });

  it("VERIFY: a forged, re-chained bundle with an identity in a closed id is refused, codes only", () => {
    const honest = exportProofBundle(sampleRun(), NO_CTX);
    for (const [label, value] of PLANTS) {
      const id = value.replace(/[^A-Za-z0-9._-]/g, "") || "x";
      if (compileIdentity(IDENTITY).hit(id) === null) continue;
      // `policyId` is a closed id; `tool` is a closed vocabulary since #562 F1.
      for (const at of ["policyId", "runId"] as const) {
        const b = clone(honest) as unknown as {
          run: { runId: string };
          records: Array<{ body: Record<string, unknown> }>;
        };
        if (at === "policyId")
          (b.records[0] as { body: Record<string, unknown> }).body.policyId = id;
        else b.run.runId = id;
        const text = serializeProofBundle(rechain(b as unknown as ProofBundle));
        // Without an identity the forged bundle is structurally valid ...
        if (at === "policyId") expect(verifyProofBundle(text).ok, label).toBe(true);
        // ... with it, it is refused before any message could name a value.
        const r = verifyProofBundle(text, { identity: IDENTITY });
        expect(r.ok, label).toBe(false);
        expect(
          r.errors.map((e) => e.code),
          label,
        ).toEqual(["PROOF_IDENTITY"]);
        expect(r.errors[0]?.message).toMatch(
          /^the bundle carries \d+ value\(s\) containing a configured identity string or shape: [a-z, -]+$/,
        );
        expect(r.evidenceRecomputed).toEqual([]);
      }
    }
  });
});

describe("CLI: the host's identity is guarded with no flag; --identity-file adds names", () => {
  const cli = (args: string[]) => {
    let out = "";
    const io = { out: (t: string) => (out += t), err: (t: string) => (out += t) };
    return { code: main(args, io), out };
  };
  const writeRun = (name: string, run: ProofRunInput) => {
    const steps = run.steps.map((s) =>
      s.kind === "evidence" && s.content instanceof Uint8Array
        ? { ...s, content: new TextDecoder().decode(s.content) }
        : s,
    );
    const { episode, ...rest } = run;
    const episodeFile = `${name}.episode.json`;
    if (episode !== undefined) writeFileSync(join(DIR, episodeFile), JSON.stringify(episode));
    const path = join(DIR, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({ ...rest, steps, ...(episode === undefined ? {} : { episodeFile }) }),
    );
    return path;
  };
  const roundTrip = (name: string, run: ProofRunInput) => {
    const runPath = writeRun(name, run);
    const bundle = join(DIR, `${name}.bundle.json`);
    const html = join(DIR, `${name}.html`);
    const episodeArgs =
      run.episode === undefined ? [] : ["--episode", join(DIR, `${name}.episode.json`)];
    const e = cli(["export", runPath, "--out", bundle, "--identity-file", IDENTITY_FILE]);
    const v = cli(["verify", bundle, ...episodeArgs, "--identity-file", IDENTITY_FILE]);
    const r = cli(["report", bundle, "--out", html, "--identity-file", IDENTITY_FILE]);
    return { e, v, r, bundle: readFileSync(bundle, "utf8"), html: readFileSync(html, "utf8") };
  };

  it("every plant: export, verify, report exit 0; no identity in any file or output", () => {
    const n = roundTrip("neutral", runFor(NEUTRAL));
    for (const [i, [label, value]] of PLANTS.entries()) {
      const p = roundTrip(`plant-${i}`, runFor(value));
      expect([p.e.code, p.v.code, p.r.code], label).toEqual([0, 0, 0]);
      structureClean(JSON.parse(p.bundle), JSON.parse(n.bundle), `${label} CLI bundle`);
      bytesClean(p.bundle, n.bundle, `${label} CLI bundle`);
      bytesClean(p.html, n.html, `${label} CLI report`);
      bytesClean(p.e.out + p.v.out + p.r.out, n.e.out + n.v.out + n.r.out, `${label} CLI stdout`);
    }
  });

  it("a bundle written elsewhere that carries this host's name is refused by verify and report", () => {
    const b = clone(exportProofBundle(sampleRun(), NO_CTX));
    (b.records[0]?.body as { policyId: string }).policyId = `run-${FIRST}${LAST}`;
    const path = join(DIR, "forged.json");
    writeFileSync(path, serializeProofBundle(rechain(b)));
    const v = cli(["verify", path, "--identity-file", IDENTITY_FILE]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("PROOF_IDENTITY");
    expect(countCI(v.out, FIRST)).toBe(0);
    const r = cli([
      "report",
      path,
      "--out",
      join(DIR, "forged.html"),
      "--identity-file",
      IDENTITY_FILE,
    ]);
    expect(r.code).toBe(1);
    expect(countCI(r.out, FIRST)).toBe(0);
    // Without the file the synthetic name is not configured: it verifies.
    expect(cli(["verify", path]).code).toBe(0);
  });
});

describe("N2: with --episode, the verdict is cross-checked against the episode's gate result", () => {
  const honest = () => exportProofBundle(sampleRunWithEpisode(), NO_CTX);
  const ep = sampleEpisode();
  const flip = (edit: (v: Record<string, unknown>) => void) => {
    const b = clone(honest());
    const rec = b.records.find((r) => r.kind === "verdict") as unknown as {
      body: Record<string, unknown>;
    };
    edit(rec.body);
    return verifyProofBundle(serializeProofBundle(rechain(b)), { episode: ep });
  };

  it("the honest bundle cross-checks", () => {
    const r = verifyProofBundle(serializeProofBundle(honest()), { episode: ep });
    expect(r.ok).toBe(true);
    expect(r.episodeChecked).toBe(true);
  });

  it("a fully re-chained verdict flip no longer verifies as cross-checked", () => {
    const r = flip((v) => {
      v.verdict = "verified";
      v.accepted = true;
      v.reasonCodes = ["ORACLE_PASS"];
    });
    expect(r.ok).toBe(false);
    expect(r.episodeChecked).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual([
      "the verdict differs from the episode's gate verdict",
      "accepted differs from the episode's gate result",
      "the reason codes differ from the episode's gate result",
    ]);
  });

  it("reason codes alone, and order does not matter", () => {
    const r = flip((v) => {
      v.reasonCodes = ["ORACLE_FAIL"];
    });
    expect(r.errors.map((e) => e.message)).toEqual([
      "the reason codes differ from the episode's gate result",
    ]);
    const same = flip((v) => {
      v.reasonCodes = ["CLAIM_RECORDED", "ORACLE_FAIL"];
    });
    expect(same.ok).toBe(true);
  });

  it("no gate result in the episode, but a verdict record; and the reverse", () => {
    const noGate = sampleEpisode({ gate: null, outcome: "no-claim", agentClaim: null });
    const valid = validateEpisode(noGate).length === 0;
    if (valid) {
      const run = { ...sampleRun(), episode: noGate };
      expect(() => exportProofBundle(run, NO_CTX)).toThrow(/no gate result/);
    }
    const run = sampleRunWithEpisode();
    const steps = run.steps.filter((s) => s.kind !== "verdict");
    expect(() => exportProofBundle({ ...run, steps }, NO_CTX)).toThrow(/the bundle has no verdict/);
  });
});
