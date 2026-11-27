/**
 * Shared fixtures for the pilot tests: the published fc-v1 task set, the reviewed config,
 * a private temp run directory and a dry run on a virtual clock. No model, no `claude`, no VM.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PACING, type PacingConfig, pilotConfig } from "../../src/pilot/config.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../../src/pilot/dry-run.ts";
import { publishedTasks } from "../../src/pilot/reviewed.ts";
import { type PilotDriver, runPilot } from "../../src/pilot/runner.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const PUBLISHED = publishedTasks(ROOT);
export const SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) =>
  join(ROOT, p),
);

/** Subscription-quota wording (lead ruling, PR #598 round 2, D3): each one stops the run. */
export const USAGE_LIMIT_PHRASES = [
  "Claude AI usage limit reached|1700000000",
  "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
  "5-hour limit reached ∙ resets 3pm",
  "5 hour limit reached",
  "Weekly limit reached ∙ resets Mon",
  "weekly limit reached",
  "Opus limit reached ∙ resets 11pm",
  "Sonnet limit reached · resets 3pm",
  "Your limit will reset at 5pm",
  "Limit resets at 9am",
  "daily limit exceeded",
  "usage_limit_reached",
  // #607 round 2, B1: none of these matched before the phrase was added.
  "You've hit your limit",
  "You’ve hit your limit",
  "YOU'VE HIT YOUR LIMIT",
  "You have reached your limit",
] as const;

/**
 * Whitespace the quota wording may carry in place of an ASCII space (#606 S2): NBSP, figure
 * space, narrow NBSP, U+2000-U+200A, ideographic space, a tab, a newline, repeated spaces.
 * Spelled by code point, so no invisible character sits in the source.
 */
const cp = (code: number): [string, string] => [
  `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
  String.fromCharCode(code),
];
export const UNICODE_SPACES: readonly (readonly [string, string])[] = [
  cp(0x00a0), // NBSP
  cp(0x2007), // figure space
  cp(0x202f), // narrow NBSP
  ...Array.from({ length: 11 }, (_, i) => cp(0x2000 + i)), // U+2000-U+200A
  cp(0x3000), // ideographic space
  ["tab", "\t"],
  ["newline", "\n"],
  ["repeated spaces", "   "],
];

const ch = (code: number) => String.fromCharCode(code);

/**
 * Quota wording with a Unicode format character (`\p{Cf}`) or a hyphen variant inside it
 * (#607 round 2, F-A). None matches the vocabulary on its raw text; each matches once folded.
 */
export const FOLDED_USAGE_PHRASES: readonly (readonly [string, string])[] = [
  ["ZWSP U+200B before a space", `Claude usage${ch(0x200b)} limit`],
  ["word joiner U+2060 as the space", `limit${ch(0x2060)}reached`],
  ["ZWSP U+200B in a contraction", `You${ch(0x200b)}'ve hit your limit`],
  ["ZWNJ U+200C before a space", `session${ch(0x200c)} limit`],
  ["ZWJ U+200D as the space", `Opus${ch(0x200d)}limit`],
  ["Mongolian vowel separator U+180E as the space", `weekly${ch(0x180e)}limit`],
  ["non-breaking hyphen U+2011", `5${ch(0x2011)}hour limit`],
  ["hyphen U+2010", `five${ch(0x2010)}hour limit`],
  ["en dash U+2013", `5${ch(0x2013)}hour limit`],
];

/** Thin space (U+2009). */
export const THIN_SPACE = ch(0x2009);

/** ZWSP (U+200B). */
export const ZWSP = ch(0x200b);

/** NBSP (U+00A0). */
export const NBSP = String.fromCharCode(0x00a0);

/** `phrase` with every ASCII space replaced by `space`. */
export const spaced = (phrase: string, space: string) => phrase.replaceAll(" ", space);

export const tmp = (prefix = "myco-pilot-") => mkdtempSync(join(tmpdir(), prefix));

export function config(pacing: Partial<PacingConfig> = {}) {
  return pilotConfig(PUBLISHED, { ...DEFAULT_PACING, ...pacing });
}

export async function dryRun(
  outDir: string,
  opts: {
    driver?: PilotDriver;
    pacing?: Partial<PacingConfig>;
    clock?: ReturnType<typeof virtualClock>;
    log?: string[];
  } = {},
) {
  const clock = opts.clock ?? virtualClock();
  const result = await runPilot({
    config: config(opts.pacing),
    published: PUBLISHED,
    outDir,
    repoRoot: ROOT,
    oracleSources: SOURCES,
    driver: opts.driver ?? fakeDriver(),
    plannerModelId: PILOT_DRY_RUN_PLANNER,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => opts.log?.push(l),
  });
  return { result, clock };
}
