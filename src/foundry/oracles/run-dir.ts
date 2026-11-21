import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { decode, type EvidenceBundle, encode } from "../hidden-split/evidence.ts";
import { scoreTrial } from "./blind.ts";
import { oracleForApp } from "./state.ts";

type FileIO = Pick<typeof fs, "readFileSync" | "writeFileSync">;
export function scoreRunDir(dir: string, io: FileIO = fs) {
  const read = (name: string) => io.readFileSync(join(dir, name), "utf8");
  const metadata = decode(read("bundle.json")) as Omit<
    EvidenceBundle,
    "actual" | "screen" | "trace" | "selfReport"
  >;
  if (
    metadata.fixtureVersion !== metadata.fixture.version ||
    metadata.oracleVersion !== oracleForApp(metadata.fixture.app).version
  )
    throw new Error("Evidence version mismatch");
  const hashes = JSON.parse(read("state/manifest.json")) as Record<string, string>;
  const files: Record<string, Uint8Array> = {};
  for (const [name, hash] of Object.entries(hashes)) {
    if (basename(name) !== name) throw new Error("Invalid state filename");
    const bytes = io.readFileSync(join(dir, "state", name));
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("State integrity failure");
    files[name] = bytes;
  }
  const screen = decode(read("screen.json")) as EvidenceBundle["screen"];
  const trace = read("trace.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((line) => decode(line)) as EvidenceBundle["trace"];
  const input = {
    fixture: metadata.fixture,
    intent: metadata.intent,
    faultVersion: metadata.faultVersion,
    actual: { kind: metadata.fixture.app, files },
    screen,
    trace,
  } as const;
  const verdict = scoreTrial({ ...input, selfReport: { claimsSuccess: false, text: "" } });
  io.writeFileSync(join(dir, "verdict.json"), encode(verdict));
  const selfReport = decode(read("selfreport.json")) as EvidenceBundle["selfReport"];
  if (typeof selfReport.claimsSuccess !== "boolean" || typeof selfReport.text !== "string")
    throw new Error("Invalid self report");
  const score = scoreTrial({ ...input, selfReport });
  io.writeFileSync(
    join(dir, "score.json"),
    encode({ ...score, selfReport, hiddenSplitVersion: metadata.hiddenSplitVersion }),
  );
  return score;
}
