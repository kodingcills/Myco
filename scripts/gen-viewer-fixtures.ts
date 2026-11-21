/**
 * Regenerate viewer fixtures. Small verdict runs -> foundry/viewer-fixtures/ (committed).
 * Perf runs (~5 MB, ~50 MB) are NOT committed: `--perf <dir>` writes them to a directory the
 * viewer's CI chooses.
 */
import {
  buildViewerRun,
  PERF_RUNS,
  VIEWER_RUNS,
  writeViewerRun,
} from "../src/foundry/viewer/fixtures.ts";

const perf = process.argv.indexOf("--perf");
if (perf > 0) {
  const out = process.argv[perf + 1];
  if (!out) throw new Error("--perf needs a directory");
  for (const s of PERF_RUNS) process.stdout.write(`${writeViewerRun(out, buildViewerRun(s))}\n`);
} else {
  for (const s of VIEWER_RUNS)
    process.stdout.write(`${writeViewerRun("foundry/viewer-fixtures", buildViewerRun(s))}\n`);
}
