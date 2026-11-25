/** TIF-268: the hcu+shell prompt stays in parity with C1, and replies parse strictly. */
import { describe, expect, it } from "vitest";
import {
  C1_SCREENSHOT_PHRASE,
  HCU_SHELL_PHRASE,
  HCU_SHELL_PROMPT,
  OUTPUT_CEILING,
  parseHcuShellDecision,
  renderShellHistory,
  SHELL_SENTENCE,
} from "../../../src/baseline/hcu-shell/decision.ts";
import { MAX_OUTPUT, PROMPT } from "../../../src/baseline/planner.ts";

describe("prompt parity with the C1 arm", () => {
  it("is the C1 prompt with one phrase swapped and the shell sentence appended", () => {
    expect(PROMPT).toContain(C1_SCREENSHOT_PHRASE);
    expect(HCU_SHELL_PROMPT).toBe(
      `${PROMPT.replace(C1_SCREENSHOT_PHRASE, HCU_SHELL_PHRASE)} ${SHELL_SENTENCE}`,
    );
    expect(HCU_SHELL_PROMPT).not.toContain(C1_SCREENSHOT_PHRASE);
  });
  it("keeps the C1 output ceiling", () => expect(OUTPUT_CEILING).toBe(MAX_OUTPUT));
});

describe("reading a planner reply", () => {
  it.each([
    ['{"claim":"done"}', "done"],
    ['{"claim":"failure"}', "failure"],
    ['{"tool":"click","arguments":{"x":1,"y":2}}', { tool: "click", arguments: { x: 1, y: 2 } }],
    [
      '{"shell":"convert-csv","path":"c:/myco/work/task.xlsx"}',
      { shell: "convert-csv", path: "c:/myco/work/task.xlsx" },
    ],
  ])("reads %s", (text, expected) => expect(parseHcuShellDecision(text)).toEqual(expected));

  it.each([
    '{"shell":"exec","path":"c:/x"}',
    '{"shell":"cat","path":"c:/x","flags":"-n"}',
    '{"shell":"cat"}',
    '{"claim":"done","shell":"cat"}',
    '{"tool":"run_command","arguments":{"x":1,"y":2}}',
    "cat c:/x",
    '```json\n{"claim":"done"}\n```',
    7,
  ])("refuses %s", (text) => expect(parseHcuShellDecision(text)).toBeUndefined());

  it("does not filter paths: a denied path is still an attempt the loop records", () =>
    expect(
      parseHcuShellDecision('{"shell":"cat","path":"c:/myco-host/judge/expected.json"}'),
    ).toEqual({
      shell: "cat",
      path: "c:/myco-host/judge/expected.json",
    }));
});

it("renders only the last three shell results", () => {
  const text = renderShellHistory(
    ["a", "b", "c", "d"].map((p) => ({ request: { shell: "cat", path: p }, result: `out-${p}` })),
  );
  expect(text).not.toContain("out-a");
  expect(text).toContain("out-d");
});
