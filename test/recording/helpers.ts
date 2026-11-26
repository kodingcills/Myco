/**
 * Shared fixtures for track R tests. Planted markers are assembled at runtime from pieces,
 * so no tracked file holds a literal secret-shaped string or home path (gitleaks, TIF-241).
 */
import { generateFixture } from "../../src/tasks/fixture.ts";

const join = (...parts: string[]) => parts.join("");

/** A secret-shaped planted marker (Anthropic key shape). Not a real key. */
export const PLANTED_KEY = join("sk", "-ant-", "api03-", "PLANTEDMARKER", "-track-r-0000");
/** A GitHub-token-shaped planted marker. Not a real token. */
export const PLANTED_GH = join("gh", "p_", "PLANTEDMARKER", "trackr0000");
/** A Linux home path with a planted account name. */
export const PLANTED_LINUX_HOME = join("/", "home", "/", "plantedmarkeruser", "/docs/payroll.csv");
/** A macOS home path with a planted account name. */
export const PLANTED_MAC_HOME = join(
  "/",
  "Users",
  "/",
  "plantedmarkeruser",
  "/Desktop/payroll.csv",
);
/** A free-form marker the operator asked the recorder to refuse. */
export const PLANTED_OPERATOR_MARKER = join("MYCO", "-PLANTED-", "OPERATOR-", "7731");

export const ALL_MARKERS = [
  PLANTED_KEY,
  PLANTED_GH,
  PLANTED_LINUX_HOME,
  PLANTED_MAC_HOME,
  PLANTED_OPERATOR_MARKER,
  "plantedmarkeruser",
  "PLANTEDMARKER",
];

export const utf8 = (s: string) => new TextEncoder().encode(s);

export function fixtureBytes(seed: string): Uint8Array {
  return utf8(generateFixture(seed).csv);
}

export const operator = { startedBy: "operator", interactive: false } as const;
