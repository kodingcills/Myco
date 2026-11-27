/**
 * Benchmark site (workstream 3, track G; #667): the results table shows only numbers recomputed
 * at build time from committed, digest-verified result packs, and a placeholder when there are
 * none. Fixture packs are written into private temp git repositories (no VM, no model).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSite,
  gitCommittedCheck,
  RESULTS_ROOT,
  SiteBuildRefused,
  scanSite,
  writeSite,
} from "../../src/benchmark/site/build.ts";
import { renderMarkdown } from "../../src/benchmark/site/markdown.ts";
import { FIXTURE_BANNER, PLACEHOLDER, resultsPage } from "../../src/benchmark/site/render.ts";
import {
  RESULT_MANIFEST,
  ResultPackRefused,
  type VerifiedResult,
  verifyResultPack,
} from "../../src/benchmark/site/results.ts";
import { checkPack, readPack } from "../../src/m2/evidence.ts";
import { manifest, r1Trials, type Trial, writePack } from "../m2/pack-fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const IDENTITY = { user: "zqxsiteuser", host: "zqxsitehost" };
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function git(repo: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    ["-c", "user.name=site-test", "-c", "user.email=site-test@example.invalid", ...args],
    { cwd: repo, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function filesOf(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) filesOf(abs, base, out);
    else out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

/** Pin every file of a result pack in its `result.json`. */
function writeManifest(dir: string, id: string, kind: string, extra: object = {}) {
  const files: Record<string, string> = {};
  for (const f of filesOf(dir))
    if (f !== RESULT_MANIFEST) files[f] = sha256(readFileSync(join(dir, f)));
  writeFileSync(
    join(dir, RESULT_MANIFEST),
    `${JSON.stringify({ schema: "myco.benchmark.site-result/1", id, kind, files, ...extra }, null, 2)}\n`,
  );
}

interface Repo {
  readonly repo: string;
  readonly results: string;
  readonly dir: string;
}

/** A temp git repo with one result pack `id` (the fc-v1 R1 fixture unless `trials` says otherwise). */
function packRepo(
  opts: {
    id?: string;
    kind?: string;
    trials?: Trial[];
    commit?: boolean;
    before?: (dir: string) => void;
    extra?: object;
  } = {},
): Repo {
  const id = opts.id ?? "fixture-r1";
  const repo = temp("site-repo-");
  git(repo, "init", "-q");
  const results = join(repo, "results");
  const dir = join(results, id);
  writePack("pack", opts.trials ?? r1Trials(), manifest(), dir);
  opts.before?.(dir);
  writeManifest(dir, id, opts.kind ?? "test-fixture", opts.extra);
  if (opts.commit !== false) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fixture");
  }
  return { repo, results, dir };
}

const build = (r: Repo | null, extra: Partial<Parameters<typeof buildSite>[0]> = {}) =>
  buildSite({
    repoRoot: ROOT,
    resultsRoot: r === null ? join(temp("site-empty-"), "none") : r.results,
    isCommitted: r === null ? () => false : gitCommittedCheck(r.repo),
    identity: IDENTITY,
    ...extra,
  });

const verify = (r: Repo, allowTestFixture = true) =>
  verifyResultPack(r.dir, "fixture-r1", {
    isCommitted: gitCommittedCheck(r.repo),
    allowTestFixture,
  });

const refusal = (fn: () => unknown): readonly string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ResultPackRefused) return err.reasons;
    throw err;
  }
  throw new Error("expected a refusal");
};

const main = (html: string) => html.slice(html.indexOf("<main>"), html.indexOf("</main>"));

describe("benchmark site: no packs", () => {
  it("renders the labelled placeholder and no number in the results table", () => {
    const html = build(null).get("results.html") ?? "";
    expect(html).toContain(PLACEHOLDER);
    const body = main(html);
    expect(body).not.toMatch(/<td>\s*\d/);
    expect(body).not.toMatch(/\d+ \/ \d+/);
    expect(body).not.toContain("Result pack");
  });

  it("the committed results root holds no pack, so the real build shows the placeholder", () => {
    const entries = readdirSync(join(ROOT, RESULTS_ROOT), { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory())).toEqual([]);
    const files = buildSite({
      repoRoot: ROOT,
      isCommitted: gitCommittedCheck(ROOT),
      identity: IDENTITY,
    });
    expect(files.get("results.html")).toContain(PLACEHOLDER);
  });

  it("builds every page, deterministically, with SHA256SUMS over each", () => {
    const a = build(null);
    const b = build(null);
    expect([...a.keys()].sort()).toEqual([
      "SHA256SUMS",
      "grader.html",
      "index.html",
      "protocol.html",
      "results.html",
      "task-set.html",
    ]);
    expect([...a]).toEqual([...b]);
    const sums = (a.get("SHA256SUMS") ?? "").trim().split("\n");
    expect(sums).toHaveLength(5);
    for (const line of sums) {
      const [digest, name] = line.split("  ");
      expect(sha256(a.get(name ?? "") ?? "x")).toBe(digest);
    }
  });

  it("the task-set page lists every published fc-v1 task; the grader page pins its modules", () => {
    const files = build(null);
    const tasks = readFileSync(join(ROOT, "benchmark/false-completion/fc-v1/tasks.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { taskId: string });
    const page = files.get("task-set.html") ?? "";
    expect(tasks).toHaveLength(100);
    for (const t of tasks) expect(page).toContain(`<code>${t.taskId}</code>`);
    const grader = files.get("grader.html") ?? "";
    expect(grader).toContain("false-completion-grader/1");
    const gradeTs = readFileSync(join(ROOT, "src/benchmark/grade/grade.ts"));
    expect(grader).toContain(sha256(gradeTs));
  });
});

describe("benchmark site: a verified fixture pack", () => {
  const r = packRepo();

  it("renders numbers equal to the evidence check's own recomputation, under the TEST FIXTURE banner", () => {
    const html = build(r, { allowTestFixture: true }).get("results.html") ?? "";
    const own = checkPack(readPack(join(r.dir, "pack"), () => ({ ok: false, detail: "" })));
    expect(own.ok).toBe(true);
    const r1 = own.r1;
    if (r1 === null) throw new Error("fixture is an R1 pack");
    expect(r1.headline.numerator).toBe(0);
    expect(r1.headline.denominator).toBe(100);
    const body = main(html);
    expect(body).toContain(FIXTURE_BANNER);
    expect(body).toContain("Test fixture <code>fixture-r1</code>");
    expect(body).not.toContain(PLACEHOLDER);
    expect(body).toContain(`<td>${r1.headline.numerator} / ${r1.headline.denominator} (Wilson 95%`);
    expect(body).toContain(`<td>${r1.trials} (of which faulted: ${r1.faultTrials})</td>`);
    expect(body).toContain(
      `<td>${r1.unregistrable.trials} (claimed done: ${r1.unregistrable.claimedDone})</td>`,
    );
    expect(body).toContain(`<tr><th>Verdict</th><td>${r1.pass ? "pass" : "not met"}</td></tr>`);
    expect(body).toContain(sha256(readFileSync(join(r.dir, RESULT_MANIFEST))));
    // The banner sits on every section that carries numbers (Arms and R1 here), not only once.
    expect(body.split(FIXTURE_BANNER).length - 1).toBeGreaterThanOrEqual(3);
  });

  it("an evidence-kind pack renders without the banner", () => {
    const ev = packRepo({ kind: "evidence" });
    const body = main(build(ev).get("results.html") ?? "");
    expect(body).toContain("Result pack <code>fixture-r1</code>");
    expect(body).not.toContain(FIXTURE_BANNER);
  });

  it("a test-fixture pack is refused outside tests (the build CLI never allows it)", () => {
    expect(refusal(() => verify(r, false))).toEqual(["test-fixture-outside-tests"]);
    expect(() => build(r)).toThrow(ResultPackRefused);
  });
});

describe("benchmark site: refuses any number not backed by a committed, digest-verified pack", () => {
  it("a file edited after pinning (even when committed): digest-mismatch", () => {
    const r = packRepo({ commit: false });
    appendFileSync(join(r.dir, "pack", "grades.jsonl"), "\n");
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "-m", "edit");
    expect(refusal(() => verify(r))).toEqual(["digest-mismatch pack/grades.jsonl"]);
  });

  it("an unpinned extra file, and a pinned file that is missing", () => {
    const extra = packRepo({ commit: false });
    writeFileSync(join(extra.dir, "pack", "notes.txt"), "x\n");
    git(extra.repo, "add", "-A");
    git(extra.repo, "commit", "-q", "-m", "extra");
    expect(refusal(() => verify(extra))).toEqual(["file-not-in-manifest pack/notes.txt"]);

    const missing = packRepo({ commit: false });
    rmSync(join(missing.dir, "pack", "ops.jsonl"));
    git(missing.repo, "add", "-A");
    git(missing.repo, "commit", "-q", "-m", "missing");
    expect(refusal(() => verify(missing))).toEqual(["file-missing pack/ops.jsonl"]);
  });

  it("a pack with correct digests that is not committed, or edited in the working tree", () => {
    const never = packRepo({ commit: false });
    expect(refusal(() => verify(never))).toContain("not-committed result.json");

    const edited = packRepo();
    // Re-pin after an edit: digests match the disk, but HEAD holds the old bytes.
    appendFileSync(join(edited.dir, "pack", "grades.jsonl"), "\n");
    writeManifest(edited.dir, "fixture-r1", "test-fixture");
    expect(refusal(() => verify(edited))).toEqual([
      "not-committed result.json",
      "not-committed pack/grades.jsonl",
    ]);
  });

  it("a manifest cannot carry a number of its own", () => {
    const r = packRepo({ extra: { headline: { numerator: 0, denominator: 100 } } });
    expect(refusal(() => verify(r))).toEqual(["manifest-unknown-field"]);
  });

  it("simulated rows (a dry-run planner) are refused even though the evidence check passes", () => {
    const trials = r1Trials().map((t) => ({
      ...t,
      arm: { ...t.arm, plannerModelId: "simulated:dry-run" },
    }));
    const r = packRepo({ trials });
    const own = checkPack(readPack(join(r.dir, "pack"), () => ({ ok: false, detail: "" })));
    expect(own.ok).toBe(true); // the M2 check alone would accept it; the site must not
    expect(refusal(() => verify(r))).toEqual(["not-evidence-provenance"]);
    expect(() => build(r, { allowTestFixture: true })).toThrow(ResultPackRefused);
  });

  it("a SIMULATED marker is refused", () => {
    const r = packRepo({ before: (d) => writeFileSync(join(d, "pack", "SIMULATED"), "") });
    const reasons = refusal(() => verify(r));
    expect(reasons).toContain("not-evidence-provenance");
  });

  it("a pack the evidence check fails (a short run) is refused", () => {
    const r = packRepo({ trials: r1Trials().slice(0, 99) });
    const reasons = refusal(() => verify(r));
    expect(reasons.some((x) => x.startsWith("evidence-check-failed"))).toBe(true);
  });

  it("a symlink in a pack is refused", () => {
    const r = packRepo({
      commit: false,
      before: (d) => symlinkSync("arm.jsonl", join(d, "pack", "link.jsonl")),
    });
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "-m", "link");
    expect(refusal(() => verify(r))).toContain("not-a-regular-file pack/link.jsonl");
  });

  it("the renderer refuses a result that did not come from verifyResultPack", () => {
    const r = packRepo();
    const real = verify(r);
    expect(() => resultsPage([real])).not.toThrow();
    const forged = { ...real } as VerifiedResult;
    expect(() => resultsPage([forged])).toThrow(/never rendered/);
    expect(() => {
      (real.check.r1 as { headline: unknown }).headline = { numerator: 0, denominator: 1 };
    }).toThrow(TypeError);
  });
});

describe("benchmark site: output hygiene", () => {
  it("scanSite reports file:line:kind and never the matched text", () => {
    const home = ["", "home", "someone", "x"].join("/");
    const key = ["sk", "ant", "abcdefghijklmnop"].join("-");
    const files = new Map([
      ["a.html", `ok\n<p>${home}</p>`],
      ["b.html", `<p>${key}</p>`],
      ["c.html", "<p>zqxsitehost</p>"],
    ]);
    const findings = scanSite(files, { identity: IDENTITY });
    expect(findings).toEqual(["a.html:2:host-path", "b.html:1:secret-shaped", "c.html:1:hostname"]);
    expect(findings.join(" ")).not.toContain("someone");
  });

  it("the build scans its real output with the export-guard identity rule and refuses on a hit", () => {
    const dir = temp("site-id-");
    const idFile = join(dir, "identity.txt");
    writeFileSync(idFile, "# a configured identity string\nApache Foundation\n");
    let err: unknown;
    try {
      build(null, { identityFile: idFile });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SiteBuildRefused);
    const findings = (err as SiteBuildRefused).findings;
    expect(findings.some((f) => /^index\.html:\d+:identity$/.test(f))).toBe(true);
    expect(findings.join(" ")).not.toMatch(/apache/i);
  });

  it("Markdown is escaped, and links the site does not publish render as text", () => {
    const html = renderMarkdown(
      "# T\n\nA <script>x</script> [card](task-set-card.md) [repo](../false-completion.md) `a<b`",
      (h) => (h === "task-set-card.md" ? "task-set.html" : null),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="task-set.html">card</a>');
    expect(html).toContain(" repo ");
    expect(html).not.toContain("false-completion.md");
    expect(html).toContain("<code>a&lt;b</code>");
  });

  it("reproduce-linux.md is not a page: rendered, it trips the leak scan (docs/benchmark/site.md)", () => {
    const md = readFileSync(join(ROOT, "docs/benchmark/public/reproduce-linux.md"), "utf8");
    const findings = scanSite(new Map([["r.html", renderMarkdown(md, () => null)]]), {
      identity: IDENTITY,
    });
    expect(findings.some((f) => f.endsWith(":host-path"))).toBe(true);
    expect([...build(null).keys()].some((k) => k.includes("reproduce"))).toBe(false);
  });

  it("writeSite refuses a non-empty output directory", () => {
    const out = temp("site-out-");
    writeFileSync(join(out, "keep"), "x");
    expect(() => writeSite(out, new Map([["index.html", "x"]]))).toThrow(/not empty/);
  });
});

describe("benchmark site: CLI", () => {
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts/benchmark-site-build.ts"), ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );

  it("builds the placeholder site into a fresh directory", () => {
    const out = join(temp("site-cli-"), "site");
    const r = cli("--out", out);
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, "results.html"), "utf8")).toContain(PLACEHOLDER);
    mkdirSync(join(out, "x"), { recursive: true });
    expect(cli("--out", out).status).toBe(1);
  });

  it("usage error exits 2", () => {
    expect(cli().status).toBe(2);
    expect(cli("--bogus").status).toBe(2);
  });
});
