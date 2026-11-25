/**
 * Regenerate the committed LibreOffice-written Writer fixtures (TIF-99 / M2-08).
 *
 * The host generator (`src/tasks/writer-docgen.ts`) writes the pristine fixture and the
 * fully edited end state (all four postconditions applied) as .docx and .odt. Headless
 * LibreOffice then re-saves each one in the other format, so the committed files are
 * LibreOffice's own serialisation, not ours:
 *
 *   <state>.lo.odt   = soffice --convert-to odt  <state>.docx   (writer8 filter)
 *   <state>.lo.docx  = soffice --convert-to docx <state>.odt    (Office Open XML Text)
 *
 * CI has no LibreOffice, so these files carry the "real LibreOffice output" coverage into
 * `test/writer-oracle.test.ts`. The manifest records the seed, the soffice version and a
 * SHA-256 per file; the test checks the hashes, then the verdicts. Re-running this script
 * yields different bytes (LibreOffice stamps dates into meta.xml) but the same verdicts.
 *
 *   pnpm exec tsx scripts/writer-lo-fixtures.ts [soffice-binary]
 *
 * Uses a throwaway LibreOffice profile in a private temp dir; touches nothing else.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyGroundTruth,
  groundTruth,
  WRITER_POSTCONDITION_KINDS,
  type WriterDocSpec,
  writerFixture,
  writerTaskFor,
} from "../src/tasks/writer-doc-edit.ts";
import { writeDocx, writeOdt } from "../src/tasks/writer-docgen.ts";

export const LO_FIXTURE_SEED = "tif99-lo";
const OUT = join(import.meta.dirname, "..", "test", "fixtures", "writer-lo");
const soffice = process.argv[2] ?? "soffice";

const fixture = writerFixture(LO_FIXTURE_SEED);
let edited: WriterDocSpec = fixture;
for (const kind of WRITER_POSTCONDITION_KINDS) {
  edited = applyGroundTruth(edited, groundTruth(writerTaskFor(LO_FIXTURE_SEED, kind)));
}

const work = mkdtempSync(join(tmpdir(), "myco-writer-lo-"));
try {
  const profile = pathToFileURL(join(work, "profile")).href;
  const convert = (format: "odt" | "docx", input: string, outDir: string): void => {
    execFileSync(
      soffice,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${profile}`,
        "--convert-to",
        format,
        "--outdir",
        outDir,
        input,
      ],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 },
    );
  };
  const version = execFileSync(soffice, ["--version"], { encoding: "utf8" }).trim();
  mkdirSync(OUT, { recursive: true });
  const files: Record<string, { sha256: string; from: string }> = {};
  for (const [state, spec] of [
    ["pristine", fixture],
    ["edited", edited],
  ] as const) {
    const src = join(work, state);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, `${state}.docx`), writeDocx(spec));
    writeFileSync(join(src, `${state}.odt`), writeOdt(spec));
    for (const [format, from] of [
      ["odt", "docx"],
      ["docx", "odt"],
    ] as const) {
      const outDir = join(work, `${state}-to-${format}`);
      convert(format, join(src, `${state}.${from}`), outDir);
      const name = `${state}.lo.${format}`;
      const bytes = readFileSync(join(outDir, `${state}.${format}`));
      writeFileSync(join(OUT, name), bytes);
      files[name] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        from: `${state}.${from}`,
      };
      process.stdout.write(`${join(OUT, name)}\n`);
    }
  }
  const manifest = {
    seed: LO_FIXTURE_SEED,
    soffice: version,
    generator: "scripts/writer-lo-fixtures.ts",
    files,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
