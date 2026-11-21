import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ActualState,
  FixtureManifest,
  GuardTraceEvent,
  ScreenView,
  TaskIntent,
} from "../types.ts";

export interface EvidenceBundle {
  readonly fixture: FixtureManifest;
  readonly intent: TaskIntent;
  readonly actual: ActualState;
  readonly screen: ScreenView;
  readonly trace: readonly GuardTraceEvent[];
  readonly selfReport: { readonly claimsSuccess: boolean; readonly text: string };
  readonly fixtureVersion: number;
  readonly oracleVersion: number;
  readonly faultVersion: number;
  readonly hiddenSplitVersion: number;
}
export const encode = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    x instanceof Uint8Array ? { $bytes: Buffer.from(x).toString("base64") } : x,
  );
export const decode = (s: string): unknown =>
  JSON.parse(s, (_k, x: unknown) =>
    x &&
    typeof x === "object" &&
    Object.keys(x).length === 1 &&
    "$bytes" in x &&
    typeof x.$bytes === "string"
      ? new Uint8Array(Buffer.from(x.$bytes, "base64"))
      : x,
  );
export function collectEvidence(dir: string, bundle: EvidenceBundle): void {
  if (
    bundle.fixtureVersion !== bundle.fixture.version ||
    ![
      bundle.fixtureVersion,
      bundle.oracleVersion,
      bundle.faultVersion,
      bundle.hiddenSplitVersion,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    typeof bundle.selfReport.claimsSuccess !== "boolean" ||
    typeof bundle.selfReport.text !== "string"
  )
    throw new Error("Invalid evidence bundle");
  mkdirSync(join(dir, "state"), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(bundle.actual.files)) {
    if (basename(name) !== name || name === "manifest.json")
      throw new Error("Invalid state filename");
    writeFileSync(join(dir, "state", name), bytes);
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  writeFileSync(join(dir, "state", "manifest.json"), JSON.stringify(hashes));
  const { actual: _actual, screen, trace, selfReport, ...metadata } = bundle;
  writeFileSync(join(dir, "bundle.json"), encode(metadata));
  writeFileSync(join(dir, "screen.json"), encode(screen));
  writeFileSync(join(dir, "trace.jsonl"), trace.map(encode).join("\n"));
  writeFileSync(join(dir, "selfreport.json"), encode(selfReport));
}
