/**
 * `myco-episodes` CLI (data capture track). `scripts/myco-episodes.ts` is a thin shell over
 * `main`. Local files only; no network.
 */
import type { Writable } from "node:stream";
import { type EpisodeFilter, exportDataset, importDataset, validateDataset } from "./export.ts";
import { blobsFor, EpisodeStore, readStoreDir } from "./store.ts";
import type { EpisodeOutcome } from "./types.ts";
import { validateEpisode } from "./validate.ts";

export const USAGE = `usage:
  myco-episodes export --from <store> [--from <store> ...] --out <dir> (--real | --simulated)
                       [--task-set <v>] [--arm <arm>] [--outcome <o>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  myco-episodes validate (--dataset <dir> | --store <dir>)
  myco-episodes import --dataset <dir> --into <store>

exit: 0 ok, 1 invalid or refused, 3 usage
`;

class UsageError extends Error {}

function parse(argv: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (!flag.startsWith("--")) throw new UsageError(`unexpected argument ${flag}`);
    if (flag === "--real" || flag === "--simulated") {
      flags.set(flag, ["true"]);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`${flag} needs a value`);
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
    i++;
  }
  return flags;
}

const one = (flags: Map<string, string[]>, name: string): string | null => {
  const v = flags.get(name);
  if (v === undefined) return null;
  if (v.length > 1) throw new UsageError(`${name} given more than once`);
  return v[0] as string;
};

export async function main(
  argv: readonly string[],
  io: { readonly stdout: Writable; readonly stderr: Writable },
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const flags = parse(rest);
    switch (command) {
      case "export": {
        const out = one(flags, "--out");
        const stores = flags.get("--from") ?? [];
        const real = flags.has("--real");
        const simulated = flags.has("--simulated");
        if (out === null || stores.length === 0 || real === simulated)
          throw new UsageError(
            "export needs --from, --out and exactly one of --real / --simulated",
          );
        const filter: EpisodeFilter = {
          taskSetVersion: one(flags, "--task-set"),
          arm: one(flags, "--arm"),
          outcome: one(flags, "--outcome") as EpisodeOutcome | null,
          since: one(flags, "--since"),
          until: one(flags, "--until"),
        };
        const manifest = exportDataset({ stores, out, simulated, filter });
        io.stdout.write(
          `exported ${manifest.counts.episodes} episode(s), ${manifest.counts.blobs} blob(s); dataset ${manifest.datasetSha256}\n`,
        );
        return 0;
      }
      case "validate": {
        const dataset = one(flags, "--dataset");
        const store = one(flags, "--store");
        if ((dataset === null) === (store === null))
          throw new UsageError("validate needs exactly one of --dataset / --store");
        let problems: string[];
        if (dataset !== null) problems = validateDataset(dataset);
        else {
          const kind = EpisodeStore.readKind(store as string);
          const { episodes, blobs } = readStoreDir(store as string);
          problems = episodes.flatMap((ep) => [
            ...validateEpisode(ep, { blobs: blobsFor(ep, blobs) }).map(
              (i) => `episode ${String(ep.episodeId).slice(0, 12)}: ${i.code} at ${i.path}`,
            ),
            ...(ep.simulated === kind
              ? []
              : [`episode ${String(ep.episodeId).slice(0, 12)}: wrong store kind`]),
          ]);
        }
        for (const p of problems) io.stderr.write(`invalid: ${p}\n`);
        io.stdout.write(problems.length === 0 ? "valid\n" : `${problems.length} problem(s)\n`);
        return problems.length === 0 ? 0 : 1;
      }
      case "import": {
        const dataset = one(flags, "--dataset");
        const into = one(flags, "--into");
        if (dataset === null || into === null)
          throw new UsageError("import needs --dataset and --into");
        const results = importDataset(dataset, into);
        const refused = results.filter((r) => r.status === "refused").length;
        io.stdout.write(`imported ${results.length - refused} episode(s), refused ${refused}\n`);
        return refused === 0 ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown command ${String(command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`myco-episodes: ${error.message}\n${USAGE}`);
      return 3;
    }
    io.stderr.write(`myco-episodes: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
