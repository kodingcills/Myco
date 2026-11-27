/**
 * Track R analysis CLI under pre-registration r-v1 (`docs/product/capability-prereg/r-v1/`).
 *
 *   npx tsx scripts/r-v1-analysis.ts analyse --pack DIR [--evidence] [--marker TEXT]...
 *   npx tsx scripts/r-v1-analysis.ts manifest (--write | --check)
 *   npx tsx scripts/r-v1-analysis.ts hash
 *
 * `analyse` reads `DIR/pack.json`, `DIR/trials.jsonl` (myco.capability.r-trial/1) and
 * `DIR/grades.jsonl` (the independent grader's myco.benchmark.grade-row/1 rows), checks them
 * against the committed prereg and fr-v1 manifest, and prints the analysis as JSON. Before
 * anything else it checks that `prereg.json` still hashes to the committed `prereg.sha256`
 * (PREREG_NOT_COMMITTED otherwise) and that this script and the analysis module still hash to
 * the values the prereg froze (ANALYSIS_CODE_CHANGED otherwise), so a pack is never analysed
 * against an edited prereg or by code other than the pre-registered code.
 * VERIFIED comes only from the grader's rows; the derived oracle and the replay never decide.
 *
 * `manifest` regenerates the fr-v1 manifest from `src/recording-eval/fr-v1.ts` and writes it
 * (`--write`) or checks the committed file is byte-identical (`--check`). `hash` prints the
 * pre-registration hash (SHA-256 over canonical JSON of prereg.json).
 *
 * Offline, $0: no model, no network, no VM. Exit codes: 0 analysed / ok, 1 refused or
 * mismatch (codes on stdout), 3 usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyseRPack } from "../src/recording-eval/analysis.ts";
import { canonicalSha256, sha256Hex } from "../src/recording-eval/canonical.ts";
import { buildFrV1, manifestText } from "../src/recording-eval/fr-v1.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PREREG_DIR = "docs/product/capability-prereg/r-v1";
const PREREG = join(PREREG_DIR, "prereg.json");
const PREREG_HASH = join(PREREG_DIR, "prereg.sha256");
const MANIFEST = join(PREREG_DIR, "fr-v1-manifest.json");
const USAGE =
  "usage: npx tsx scripts/r-v1-analysis.ts (analyse --pack DIR [--evidence] [--marker TEXT]... | manifest (--write|--check) | hash)";

const out = (s: string) => process.stdout.write(`${s}\n`);
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const readJsonl = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

function frozenCodeMatches(prereg: unknown): boolean {
  const analysis = (prereg as { analysis?: { files?: unknown } }).analysis;
  const files = analysis?.files;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f: { path?: unknown; sha256?: unknown }) => {
    if (typeof f?.path !== "string" || typeof f.sha256 !== "string") return false;
    try {
      return sha256Hex(readFileSync(join(ROOT, f.path))) === f.sha256;
    } catch {
      return false;
    }
  });
}

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "hash") {
    out(canonicalSha256(readJson(PREREG)));
    return 0;
  }
  if (cmd === "manifest") {
    const text = manifestText(buildFrV1());
    if (rest.length === 1 && rest[0] === "--write") {
      writeFileSync(join(ROOT, MANIFEST), text);
      out(`wrote ${MANIFEST}`);
      return 0;
    }
    if (rest.length === 1 && rest[0] === "--check") {
      const same = readFileSync(join(ROOT, MANIFEST), "utf8") === text;
      out(same ? "MANIFEST_OK" : "MANIFEST_DRIFT");
      return same ? 0 : 1;
    }
    out(USAGE);
    return 3;
  }
  if (cmd !== "analyse") {
    out(USAGE);
    return 3;
  }
  let pack: string | undefined;
  let evidence = false;
  const markers: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (f === "--evidence") evidence = true;
    else if (f === "--pack" && rest[i + 1] !== undefined) pack = rest[++i];
    else if (f === "--marker" && rest[i + 1] !== undefined) markers.push(rest[++i] as string);
    else {
      out(USAGE);
      return 3;
    }
  }
  if (pack === undefined) {
    out(USAGE);
    return 3;
  }
  const prereg = readJson(PREREG);
  const codes: string[] = [];
  // The pack's hash is checked against prereg.json below; this binds prereg.json itself to
  // the committed hash, so an edited prereg (and a pack built against it) is never analysed.
  if (canonicalSha256(prereg) !== readFileSync(join(ROOT, PREREG_HASH), "utf8").trim()) {
    codes.push("PREREG_NOT_COMMITTED");
  }
  if (!frozenCodeMatches(prereg)) codes.push("ANALYSIS_CODE_CHANGED");
  if (codes.length > 0) {
    out(JSON.stringify({ status: "refused", codes }));
    return 1;
  }
  const result = analyseRPack({
    prereg,
    manifest: readJson(MANIFEST),
    pack: JSON.parse(readFileSync(join(pack, "pack.json"), "utf8")),
    trials: readJsonl(join(pack, "trials.jsonl")),
    grades: readJsonl(join(pack, "grades.jsonl")),
    evidence,
    markers,
  });
  out(JSON.stringify(result, null, 2));
  return result.status === "analysed" ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch {
  out(JSON.stringify({ status: "refused", codes: ["INPUT_UNREADABLE"] }));
  process.exitCode = 1;
}
