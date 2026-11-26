/**
 * Track Q (replayable proof): the doc's claims are executed, not just written.
 * docs/architecture/replayable-proof.md must match the code it describes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROOF_CLAIM } from "../../src/proof/bundle.ts";
import { KNOWN } from "../../src/proof/cli.ts";
import { DECODE_DEPTH, findLeaks } from "../../src/proof/redact.ts";

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
    // verify's documented flags plus --forbid-file (documented in prose) are all of its flags.
    expect(DOC).toContain("`--forbid-file`");
    expect([...verifyFlags, "--forbid-file"].sort()).toEqual([...(KNOWN.verify ?? [])].sort());
  });

  it("home roots are caught after any leading character, as documented (R2-D1)", () => {
    expect(DOC).toContain("**Home roots have no such exception:**");
    for (const lead of [".../", "../../", "v2/", "build-/", "x.", "-"])
      for (const root of ["Users/", "home/", "root/", "Users\\\\"])
        expect(findLeaks(`${lead}${root}plantuser05/x`), `${lead}${root}`).not.toEqual([]);
  });

  it("R3-D1: spaced user segments are documented, and no completeness claim is made", () => {
    expect(DOC).not.toContain("never under-matches");
    expect(DOC).toContain("**The user segment after a home root may contain spaces**");
    expect(DOC).toContain("It is not a proof that nothing identifying can get through");
    expect(DOC).toContain("**Limits.**");
    for (const root of ["C:\\Users\\", "C:\\Documents and Settings\\", "C:\\DOCUME~1\\"]) {
      const value = `${root}Plantfirst ZqPLANTEDlast\\x`;
      expect(findLeaks(value), root).not.toEqual([]);
    }
  });

  it("#548 D1/D3: the UNC class and the username forms are documented, with their limits", () => {
    expect(DOC).toContain("**The UNC shape covers the whole");
    expect(DOC).toContain("**Usernames are caught in exactly these forms:**");
    expect(DOC).toContain("The aim is that no secret");
    expect(DOC).not.toContain("No secret, absolute host path, username or vault key may be");
    expect(DOC).toContain("`--user-file`");
    const limits = DOC.slice(DOC.indexOf("**Limits.**"), DOC.indexOf("Planted-marker tests"));
    for (const item of ["plain prose", "**POSIX** path outside the home roots", "`x_CORP\\user`"])
      expect(limits, item).toContain(item);
    // Each documented UNC form is caught.
    for (const form of [
      "\\\\?\\UNC\\nas\\Plantfirst ZqPLANTEDlast\\x",
      "\\\\.\\UNC\\nas\\Plantfirst ZqPLANTEDlast\\x",
      "\\\\nas/homes/Plantfirst ZqPLANTEDlast/x",
      "//nas/Plantfirst ZqPLANTEDlast/x",
      "smb://nas/homes/Plantfirst ZqPLANTEDlast/x",
      "desktop-7\\Plantfirst ZqPLANTEDlast",
      "zqplantedguest@DESKTOP-7 ~ %",
    ])
      expect(findLeaks(form), form).not.toEqual([]);
  });

  it("an unchecked episode reference is stated in the doc", () => {
    expect(DOC).toContain("**not\ncross-checked**");
    expect(DOC).toContain("episodeChecked: false");
  });

  it("decoders stack three deep, as documented", () => {
    expect(DOC).toContain("stacked up to three deep");
    expect(DECODE_DEPTH).toBe(3);
    // A path percent-encoded, then JSON-escaped, then entity-encoded is still found.
    const stacked = ["see ", "Users", "plantuser05", "x"].join("&#92;u00252F");
    expect(findLeaks(stacked)).not.toEqual([]);
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
    expect(DOC).toContain("TO FILE: switch to #542's `Episode` type");
    expect(DOC).toContain("TO FILE: consolidate this scanner and #542's episode cleanliness scan");
    expect(DOC).toContain("#528's `handoffs` field");
  });
});
