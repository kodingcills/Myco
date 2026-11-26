import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreparedC1 } from "../../src/baseline/c1-trial.ts";
import { runC1Trial } from "../../src/baseline/c1-trial.ts";
import type { Planner } from "../../src/baseline/planner.ts";
import { taskText } from "../../src/tasks/task-text.ts";

const params = { fixtureSeed: "s", rowKey: "EMP-0001", column: "name", newValue: "REVISED-1" };

describe("canonical task text", () => {
  // The defect this exists for: Myco's arm was told "…and save the file", the C1
  // baseline's task line was not, and 12 of its refutations were rows that typed
  // the right value and never saved. A comparison across two different
  // instructions is not a comparison.
  it("reproduces Myco's documented intent verbatim", () => {
    expect(taskText(params)).toBe(
      'Set the cell at record EMP-0001, column name, to "REVISED-1", and save the file.',
    );
  });

  it("names the save, which is the whole point", () => {
    // Reverting the string to the old task line ("Set the name cell for record
    // X to Y.") must fail here, because that form omits the save requirement
    // that Myco's instruction carried.
    expect(taskText(params)).toContain("save the file");
  });

  it("matches the intent documented in docs/architecture/m1.md", () => {
    // The doc and the code must not drift: the doc is what a reader trusts.
    const doc = readFileSync(join(process.cwd(), "docs/architecture/m1.md"), "utf8");
    expect(doc).toContain("and save the file");
    expect(taskText(params).endsWith("and save the file.")).toBe(true);
  });

  it("quotes the value, so a text value and a numeric one both survive", () => {
    expect(taskText({ ...params, newValue: 9733 })).toContain("to 9733,");
    expect(taskText({ ...params, newValue: "REVISED-9" })).toContain('to "REVISED-9",');
  });
});

describe("the row records the instruction it used", () => {
  const shot = { type: "image", mimeType: "image/png", data: "eA==" } as const;

  function plannerCapturing(seen: string[]): Planner {
    return {
      paid: true,
      act: async (instruction) => {
        seen.push(instruction);
        return {
          calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0 } }],
          decision: { tool: "click", arguments: { x: 1, y: 2 } },
        };
      },
    };
  }

  function prepared(): PreparedC1 {
    return {
      driver: {
        hostVersion: "0.56.4",
        guestVersion: "0.56.4",
        pipeReachable: true,
        sessionIdentityMatches: true,
      },
      resetMs: 1,
      acPower: true,
      caffeinate: true,
      loadAvg1: 0,
      window: { pid: 1, window_id: 2 },
      connect: async () => ({
        request: async (method: string, p: { name?: string }) => {
          if (method === "initialize") return { protocolVersion: "2025-11-25" };
          if (p.name === "get_window_state")
            return {
              content: [{ type: "text", text: "tree" }, shot],
              structuredContent: { element_token: "tree" },
            };
          return { structuredContent: { path: "pixel", verified: true } };
        },
        notify: async () => {},
      }),
      closeTransport: async () => {},
      judge: async () => ({ kind: "persisted", actual: "wrong", expected: "right" }),
      audit: async () => true,
    };
  }

  it("sends the canonical text and persists the same string", async () => {
    const seen: string[] = [];
    const row = await runC1Trial(
      { index: 0, params, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(),
      plannerCapturing(seen),
    );
    // What the planner received is what the row records. If these ever differ,
    // instruction parity stops being checkable from artifacts.
    expect(seen[0]).toBe(taskText(params));
    expect(row.instruction).toBe(taskText(params));
    expect(row.instruction).toContain("save the file");
  });
});
