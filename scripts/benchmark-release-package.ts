/**
 * Build the publishable false-completion release bundle (track G, #613; #612 item N2).
 *
 *   npx tsx scripts/benchmark-release-package.ts --out <dir> [--ref <git ref>]
 *     [--dataset <name>=<dir>]... [--identity-file <file>]
 *
 * Reads the allowlisted files (task set, public protocol pages, grader and its import closure)
 * from the commit `--ref` names (default HEAD; a release uses origin/main), never from the
 * working tree. Each `--dataset` adds one cleared dataset directory, which must be named
 * `dataset` or `ds`. Every file is scanned for host paths, this machine's user and host
 * names, the strings in `--identity-file` (one per line) and secret-shaped strings; any finding
 * refuses the build. Writes `<dir>/myco-false-completion-fc-v1/`, the archive
 * `<dir>/myco-false-completion-fc-v1.tar` (plain ustar: no extended attributes, no owner
 * names) and its `.sha256`. See `src/benchmark/release/package.ts`.
 *
 * Exit 0 with a JSON summary; 1 when the build is refused (each finding names a file, line
 * and kind, never the matched text); 2 on a usage error.
 */
import {
  buildRelease,
  type DatasetSource,
  ReleaseRefusal,
} from "../src/benchmark/release/package.ts";
import { RequestBuildError } from "../src/benchmark/requests.ts";

const usage = () => {
  process.stderr.write(
    "usage: benchmark-release-package.ts --out <dir> [--ref <git ref>] [--dataset <name>=<dir>]... [--identity-file <file>]\n",
  );
  process.exit(2);
};

let out: string | undefined;
let ref = "HEAD";
let identityFile: string | undefined;
const datasets: DatasetSource[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) usage();
  i++;
  if (flag === "--out") out = value;
  else if (flag === "--ref") ref = value as string;
  else if (flag === "--identity-file") identityFile = value;
  else if (flag === "--dataset") {
    const eq = (value as string).indexOf("=");
    if (eq < 1 || eq === (value as string).length - 1) usage();
    datasets.push({ name: (value as string).slice(0, eq), dir: (value as string).slice(eq + 1) });
  } else usage();
}
if (out === undefined) usage();

try {
  const result = buildRelease({
    repoDir: process.cwd(),
    ref,
    outDir: out as string,
    datasets,
    scan: { hygiene: identityFile === undefined ? {} : { identityFile } },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (e) {
  if (e instanceof ReleaseRefusal || e instanceof RequestBuildError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
