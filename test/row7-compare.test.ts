import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// TIF-211: the two numeric helpers behind row 7, called in process from Python so the
// test exercises the scripts' own functions, not a re-implementation.
//   - scripts/row7-compare.py key_counts(): Escape counts under `Escape` or `Esc`, any case.
//   - scripts/m1-scorecard.py wilson(): bounds clamped to [0, 1] (wilson(0, 30) was -1.2e-17).
function py(body: string): unknown {
  const prelude = [
    "import importlib.util, json, sys",
    "def load(name, path):",
    "    spec = importlib.util.spec_from_file_location(name, path)",
    "    mod = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(mod)",
    "    return mod",
    "row7 = load('row7_compare', 'scripts/row7-compare.py')",
    "card = load('m1_scorecard', 'scripts/m1-scorecard.py')",
  ].join("\n");
  const result = spawnSync("python3", ["-c", `${prelude}\n${body}`], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

const press = (key: string) => ({ tool: "press_key", arguments: { key } });

describe("row7-compare key_counts", () => {
  it("counts Escape under either key name, case-insensitively", () => {
    const actions = [
      press("Escape"),
      press("esc"),
      press("ESC"),
      press(" Esc "),
      press("escape"),
      press("Ctrl+s"),
      press("ctrl+S"),
      press("Return"),
      press("Escapes"),
      { tool: "type_text", arguments: { text: "Escape" } },
      { tool: "click", arguments: {} },
    ];
    const out = py(`print(json.dumps(row7.key_counts(${JSON.stringify(actions)})))`);
    expect(out).toEqual({ pressKey: 9, ctrlS: 2, escape: 5 });
  });

  it("counts nothing when no key is pressed", () => {
    expect(py("print(json.dumps(row7.key_counts([])))")).toEqual({
      pressKey: 0,
      ctrlS: 0,
      escape: 0,
    });
  });
});

type Interval = [number, number];

describe("m1-scorecard wilson", () => {
  it("clamps both bounds to [0, 1] at the extremes", () => {
    const [zeroOf30, allOf30, zeroOf1] = py(
      "print(json.dumps([card.wilson(0, 30), card.wilson(30, 30), card.wilson(0, 1)]))",
    ) as [Interval, Interval, Interval];
    expect(zeroOf30[0]).toBe(0);
    expect(Object.is(zeroOf30[0], -0)).toBe(false);
    expect(zeroOf30[1]).toBeCloseTo(0.1135, 4);
    expect(allOf30[1]).toBe(1);
    expect(allOf30[0]).toBeCloseTo(0.8865, 4);
    expect(zeroOf1[0]).toBe(0);
    expect(zeroOf1[1]).toBeLessThanOrEqual(1);
  });

  it("formats the r6 lower bound as 0.000, and leaves interior intervals unchanged", () => {
    const out = py(
      [
        "lo, hi = card.wilson(0, 30)",
        "vlo, vhi = card.wilson(29, 30)",
        "print(json.dumps([f'{lo:.3f}', f'{hi:.3f}', round(lo, 3), f'{vlo:.3f}', f'{vhi:.3f}']))",
      ].join("\n"),
    ) as [string, string, number, string, string];
    expect(out).toEqual(["0.000", "0.114", 0, "0.833", "0.994"]);
  });

  it("returns None with no trials", () => {
    expect(py("print(json.dumps(card.wilson(0, 0)))")).toBeNull();
  });
});
