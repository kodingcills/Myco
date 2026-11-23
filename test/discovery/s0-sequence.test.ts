import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { runS0Sequence } from "../../src/discovery/s0-sequence.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "myco-s0-"));
}

describe("S0 mock sequence", () => {
  it("verifies DF-S01 and refutes DF-S02 with a false success", async () => {
    const output = dir();
    const sequence = await runS0Sequence(output);
    expect(sequence.ok).toBe(true);
    const [clean, seeded] = sequence.runs;
    expect(clean?.result.status).toBe("verified");
    expect(clean?.result.falseSuccess).toBe(false);
    expect(seeded?.result.status).toBe("refuted");
    expect(seeded?.result.falseSuccess).toBe(true);
    expect(seeded?.result.claimed).toBe("saved 4 item(s)");
    expect(seeded?.result.missing).toHaveLength(2);
    for (const run of sequence.runs) {
      const record: unknown = JSON.parse(readFileSync(join(output, run.id, "result.json"), "utf8"));
      expect(validateSchema(record, resultRecordSchema)).toEqual([]);
      expect((record as { simulated?: boolean }).simulated).toBe(true);
    }
    expect(existsSync(join(output, "s0-report.md"))).toBe(true);
    const report = readFileSync(join(output, "s0-report.md"), "utf8");
    expect(report).toContain("df-s01");
    expect(report).toContain("df-s02");
    expect(report).toContain("Provenance: **simulated**");
    expect(report).toContain("not live evidence");
    expect(report).toContain("It is not a head-to-head decision");
    expect(report).toContain("| df-s02 | refuted | refuted | yes | 2 |");
  });

  it("fails the sequence when a scenario does not match its expected verdict", async () => {
    const sequence = await runS0Sequence(dir(), {
      verify: () => ({ status: "verified", reasons: ["always verified"] }),
    });
    expect(sequence.ok).toBe(false);
    // The contradiction guard downgrades a verifier that says verified while the
    // store is missing items; the sequence still reports the mismatch.
    expect(sequence.runs[1]?.result.status).toBe("uncertain");
  });
});
