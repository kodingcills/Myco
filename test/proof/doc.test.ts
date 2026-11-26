/**
 * Track Q (replayable proof): the doc's claims are executed, not just written.
 * docs/architecture/replayable-proof.md must match the code it describes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECODE_DEPTH, findLeaks } from "../../src/proof/backstop.ts";
import { PROOF_CLAIM } from "../../src/proof/bundle.ts";
import { KNOWN } from "../../src/proof/cli.ts";
import { CLOSED_ID_SOURCE, FIELD_TREATMENT, TEXT_DIGEST_TAG } from "../../src/proof/closed.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs", "architecture", "replayable-proof.md"), "utf8");
const BUNDLE_SRC = readFileSync(join(ROOT, "src", "proof", "bundle.ts"), "utf8");

describe("docs/architecture/replayable-proof.md matches the code", () => {
  it("the verifier's refusal-code table lists exactly the codes the verifier emits", () => {
    const table = DOC.slice(DOC.indexOf("| Code | Cause |"), DOC.indexOf("The exporter runs"));
    const documented = new Set(table.match(/PROOF_[A-Z_]+/g));
    const verifyFn = BUNDLE_SRC.slice(BUNDLE_SRC.indexOf("export function verifyProofBundle"));
    const emitted = new Set([...verifyFn.matchAll(/fail\(\s*"(PROOF_[A-Z_]+)"/g)].map((m) => m[1]));
    expect([...documented].sort()).toEqual([...emitted].sort());
  });

  it("the quoted claim is the bundle's fixed claim, word for word", () => {
    const quote = DOC.split("\n")
      .filter((l) => l.startsWith("> "))
      .map((l) => l.slice(2))
      .join(" ");
    expect(quote).toBe(PROOF_CLAIM);
  });

  it("the documented usage names only flags each command accepts, and every flag", () => {
    const block = DOC.slice(
      DOC.indexOf("```\nnpx tsx scripts/proof.ts"),
      DOC.indexOf("Exit codes"),
    );
    const verifyFlags = new Set<string>();
    for (const line of block.split("\n").filter((l) => l.startsWith("npx tsx"))) {
      const command = line.split(" ")[3] as string;
      const flags = line.match(/--[a-z-]+/g) ?? [];
      for (const f of flags) expect(KNOWN[command], `${command} ${f}`).toContain(f);
      if (command === "verify") for (const f of flags) verifyFlags.add(f);
      if (command === "report") expect(line).toContain("[verify flags]");
    }
    expect(DOC).toContain("`--forbid-file`");
    expect([...verifyFlags, "--forbid-file"].sort()).toEqual([...(KNOWN.verify ?? [])].sort());
  });

  it("the allowlist table names every input field with its treatment", () => {
    const table = DOC.slice(
      DOC.indexOf("| Type | Written as | Fields |"),
      DOC.indexOf("**Hashed, not placeholdered.**"),
    );
    for (const field of Object.keys(FIELD_TREATMENT))
      expect(table, `${field} is not in the doc's allowlist table`).toContain(`\`${field}\``);
    expect(table).toContain(CLOSED_ID_SOURCE);
    expect(DOC).toContain(`\`${TEXT_DIGEST_TAG}\``);
    // Text is always hashed; artifacts and episodes are never written.
    expect(table).toMatch(/\| text \| \*\*always hashed\*\*/);
    expect(table).toMatch(/\| artifact \| \*\*never written\*\*/);
    expect(table).toMatch(/\| episode \| \*\*never written\*\*/);
  });

  it("states what is hashed vs placeholdered, and the guess-confirmation limit", () => {
    expect(DOC).toContain("no field uses a fixed placeholder");
    expect(DOC).toContain("can confirm the guess");
  });

  it("the threat model is exactly #518's, and no verdict is claimed right", () => {
    expect(DOC).toContain("This is exactly #518's ruled threat model");
    expect(DOC).toContain(
      "**The adversary is the checked agent and any guest-side process. The harness is trusted.**",
    );
    expect(DOC).toContain("**It is not proof against a malicious bundle author.**");
    expect(DOC).toContain("never a finding that the gate was right");
    expect(PROOF_CLAIM).toContain("not a finding that it was right");
    for (const overclaim of [
      "tamper-proof record",
      "unforgeable",
      "cryptographically signed",
      "never under-matches",
    ])
      expect(DOC.toLowerCase()).not.toContain(overclaim.toLowerCase());
  });

  it("the backstop is described as a backstop, with its decode depth", () => {
    expect(DOC).toContain("It is a backstop, not the guarantee.");
    expect(DOC).toContain("stacked up to three deep");
    expect(DECODE_DEPTH).toBe(3);
    const stacked = ["see ", "Users", "plantuser05", "x"].join("&#92;u00252F");
    expect(findLeaks(stacked)).not.toEqual([]);
  });

  it("an unchecked episode reference is stated in the doc", () => {
    expect(DOC).toContain("**not\ncross-checked**");
    expect(DOC).toContain("episodeChecked: false");
  });

  it("Q2 names its paired unit, the pair rule, the minimum, the cap and the test", () => {
    const q2 = DOC.slice(DOC.indexOf("**Q2,"), DOC.indexOf("**Cost.**"));
    expect(q2).toContain("**Paired unit.**");
    expect(q2).toMatch(
      /in BOTH arms' runs of\s+that slot, the agent claimed done and the independent grader says not done/,
    );
    expect(q2).toContain("at least 40 pairs");
    expect(q2).toContain("cap of 200 slots");
    expect(q2).toContain("Exact McNemar on the pairs' discordant outcomes");
    expect(q2).toContain("Holm");
  });

  it("the episode is referenced, never redefined, and the TO FILE items are present", () => {
    expect(DOC).toContain("container over the attempt's canonical episode record");
    // #542 is merged: the episode is bound to its validator, and the doc says so.
    expect(DOC).toContain("**#542 (`myco.episode/1`), merged.**");
    expect(DOC).toContain("validated as a whole by #542's own `validateEpisode`");
    expect(DOC).not.toContain("#542 (`myco.episode/1`), open");
    expect(DOC).toContain("TO FILE: consolidate this scanner and #542's episode cleanliness scan");
    expect(DOC).toContain("#528's `handoffs` field");
  });
});
