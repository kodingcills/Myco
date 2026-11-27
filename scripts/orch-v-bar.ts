/**
 * Analyse a track V pack under the frozen v-v1 pre-registration (capability track V).
 *
 *   npx tsx scripts/orch-v-bar.ts --pack <pack.json>
 *
 * The pack is `{ "preregHash": "...", "rows": [ ... ] }` (`VBarPack`, `src/orchestrate/v-bar.ts`).
 * The pre-registration, its pinned analysis files and the orch-v1 manifest are checked first
 * (`src/orchestrate/v-prereg.ts`); any drift refuses the run. Prints the result as JSON.
 * Exit 0: analysed (shown, not-shown or void). Exit 2: refused. Exit 1: usage or load error.
 */
import { readFileSync } from "node:fs";
import { analyseV, type VBarPack } from "../src/orchestrate/v-bar.ts";
import { loadVPrereg } from "../src/orchestrate/v-prereg.ts";

const args = process.argv.slice(2);
const packIndex = args.indexOf("--pack");
const packPath = packIndex >= 0 ? args[packIndex + 1] : undefined;
if (packPath === undefined) {
  process.stderr.write("usage: orch-v-bar.ts --pack <pack.json>\n");
  process.exit(1);
}

let loaded: ReturnType<typeof loadVPrereg>;
try {
  loaded = loadVPrereg(process.cwd());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const pack = JSON.parse(readFileSync(packPath, "utf8")) as VBarPack;
const result = analyseV({
  prereg: loaded.prereg,
  preregHash: loaded.preregHash,
  tasks: loaded.tasks,
  pack,
});
process.stdout.write(`${JSON.stringify({ preregHash: loaded.preregHash, ...result }, null, 2)}\n`);
process.exit(result.decision === "refused" ? 2 : 0);
