/**
 * Track K's pre-registered analysis (docs/product/capability-prereg/k-v1/prereg.json;
 * docs/recovery/recovery.md, "Pre-registration and analysis").
 *
 *   npx tsx scripts/k-recovery-analysis.ts --prereg docs/product/capability-prereg/k-v1/prereg.json \
 *     --k <k-pack.json> --none <none-pack.json> [--plumbing]
 *
 * Reads the two `myco.recovery.pack/1` files, checks the pre-registration against the
 * committed spec and code, checks each pack's recorded hash against the pre-registration as
 * committed at the pack's recorded commit (`git show <commit>:<prereg path>`), and prints
 * the result as JSON. Exit 0: analyzed or halted (reported). Exit 1: refused. Exit 2: usage.
 * `--plumbing` allows simulated rows and a draft pre-registration; its output is never
 * evidence (`evidence: false`). No network, no model, no VM.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRecoveryPacks, type RecoveryPack } from "../src/recovery/analysis.ts";
import { K_PREREG_PATH, preregHash } from "../src/recovery/prereg.ts";

const ROOT = resolve(import.meta.dirname, "..");

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: npx tsx scripts/k-recovery-analysis.ts --prereg ${K_PREREG_PATH} --k <pack> --none <pack> [--plumbing]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]) {
  const out: { prereg?: string; k?: string; none?: string; plumbing: boolean } = {
    plumbing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plumbing") out.plumbing = true;
    else if (arg === "--prereg" || arg === "--k" || arg === "--none") {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      out[arg.slice(2) as "prereg" | "k" | "none"] = value;
    } else usage(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!out.prereg || !out.k || !out.none) usage("--prereg, --k and --none are required");
  if (out.prereg !== K_PREREG_PATH) usage(`--prereg must be ${K_PREREG_PATH}`);
  return out as Required<typeof out>;
}

const files = {
  sha256(path: string): string | null {
    const full = resolve(ROOT, path);
    if (!full.startsWith(`${ROOT}/`) || !existsSync(full)) return null;
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  },
  text(path: string): string | null {
    const full = resolve(ROOT, path);
    if (!full.startsWith(`${ROOT}/`) || !existsSync(full)) return null;
    return readFileSync(full, "utf8");
  },
};

function committedPreregHash(commit: string): string | null {
  const shown = spawnSync("git", ["show", `${commit}:${K_PREREG_PATH}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (shown.status !== 0) return null;
  try {
    return preregHash(JSON.parse(shown.stdout));
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  const result = analyzeRecoveryPacks({
    prereg: JSON.parse(readFileSync(resolve(ROOT, args.prereg), "utf8")),
    files,
    committedPreregHash,
    k: JSON.parse(readFileSync(resolve(args.k), "utf8")) as RecoveryPack,
    none: JSON.parse(readFileSync(resolve(args.none), "utf8")) as RecoveryPack,
    plumbing: args.plumbing,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`refused: ${(error as Error).message}\n`);
  process.exit(1);
}
