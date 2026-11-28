import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// TIF-98 (#529 round 3, D1' b): the comparator refuses to pair arms from different bases.
// The Myco default moved to trial-base-v2, then trial-base-v3; C1 restores cua-c1-base, a clean-base derivative.
describe("row7-compare check_same_base", () => {
  /** Runs check_same_base(myco, baseline) in process; returns "ok" or the refusal text. */
  const same = (myco: Record<number, object>, baseline: Record<number, object>) =>
    py(
      [
        `myco = {int(k): v for k, v in json.loads(${JSON.stringify(JSON.stringify(myco))}).items()}`,
        `base = {int(k): v for k, v in json.loads(${JSON.stringify(JSON.stringify(baseline))}).items()}`,
        "try:",
        "    row7.check_same_base(myco, base)",
        "    print(json.dumps('ok'))",
        "except SystemExit as e:",
        "    print(json.dumps(str(e)))",
      ].join("\n"),
    ) as string;

  it("accepts legacy Myco rows (no snapshot key: pre-2026-11-26 clean-base) against C1", () => {
    expect(same({ 0: { status: "verified" } }, { 0: {} })).toBe("ok");
  });

  it("accepts a Myco row on clean-base against C1's cua-c1-base (same base family)", () => {
    expect(same({ 0: { snapshot: "clean-base" } }, { 0: {} })).toBe("ok");
    expect(same({ 0: { snapshot: "clean-base" } }, { 0: { snapshot: "cua-c1-base" } })).toBe("ok");
  });

  it("refuses a Myco row on trial-base-v2 against C1's cua-c1-base", () => {
    const r = same(
      { 0: { snapshot: "clean-base" }, 1: { snapshot: "trial-base-v2" } },
      { 0: {}, 1: {} },
    );
    expect(r).toContain("index 1: Myco ran on 'trial-base-v2' but the baseline on 'cua-c1-base'");
  });

  it("refuses a Myco row on trial-base-v3 against C1, and v3 against v2 (separate families)", () => {
    expect(same({ 0: { snapshot: "trial-base-v3" } }, { 0: {} })).toContain(
      "index 0: Myco ran on 'trial-base-v3' but the baseline on 'cua-c1-base'",
    );
    expect(
      same({ 0: { snapshot: "trial-base-v3" } }, { 0: { snapshot: "trial-base-v2" } }),
    ).toContain("index 0: Myco ran on 'trial-base-v3'");
    expect(same({ 0: { snapshot: "trial-base-v3" } }, { 0: { snapshot: "trial-base-v3" } })).toBe(
      "ok",
    );
  });

  it("refuses an unknown Myco snapshot and an unknown baseline snapshot", () => {
    expect(same({ 0: { snapshot: "clean-base-live" } }, { 0: {} })).toContain(
      "index 0: Myco ran on",
    );
    expect(same({ 0: { snapshot: "clean-base" } }, { 0: { snapshot: "mystery" } })).toContain(
      "has no known base family",
    );
  });

  it("skips a null Myco snapshot (the reset never reached ready, no guest state)", () => {
    expect(same({ 0: { snapshot: null, status: "reset-failed" } }, { 0: {} })).toBe("ok");
  });

  it("would accept both arms on trial-base-v2 once a baseline derivative exists", () => {
    expect(same({ 0: { snapshot: "trial-base-v2" } }, { 0: { snapshot: "trial-base-v2" } })).toBe(
      "ok",
    );
  });

  it("compare() runs the check before pairing", () => {
    const src = readFileSync(join(__dirname, "..", "scripts", "row7-compare.py"), "utf8");
    const body = src.slice(src.indexOf("def compare("));
    expect(body.indexOf("check_same_base(v3, r6)")).toBeGreaterThan(0);
    expect(body.indexOf("check_same_base(v3, r6)")).toBeLessThan(body.indexOf("pairs = Counter()"));
  });
});

// #529 S1 and the TIF-98 cold-boot check at the join.
describe("row7-compare null snapshots and boot class", () => {
  const call = (fn: string, myco: Record<number, object>, baseline: Record<number, object> = {}) =>
    py(
      [
        `myco = {int(k): v for k, v in json.loads(${JSON.stringify(JSON.stringify(myco))}).items()}`,
        `base = {int(k): v for k, v in json.loads(${JSON.stringify(JSON.stringify(baseline))}).items()}`,
        "try:",
        fn === "same"
          ? "    print(json.dumps(row7.check_same_base(myco, base)))"
          : "    print(json.dumps(row7.check_boot_class(myco)))",
        "except SystemExit as e:",
        "    print(json.dumps(str(e)))",
      ].join("\n"),
    );

  it("counts null-snapshot rows instead of skipping them silently", () => {
    expect(
      call(
        "same",
        {
          0: { snapshot: null, status: "reset-failed" },
          1: { snapshot: "clean-base", status: "verified" },
        },
        { 0: {}, 1: {} },
      ),
    ).toEqual({ nullSnapshot: 1, nullSnapshotIndices: [0] });
  });

  it("refuses a verified row with a null snapshot", () => {
    expect(call("same", { 0: { snapshot: null, status: "verified" } }, { 0: {} })).toContain(
      "a verified Myco row with a null snapshot",
    );
  });

  it("refuses a fast-boot Myco row, and a verified row with no measured boot", () => {
    expect(call("boot", { 0: { resetBootClass: "fast", status: "refuted" } })).toContain(
      "'fast' boot, not a full cold boot",
    );
    expect(call("boot", { 0: { resetBootClass: null, status: "verified" } })).toContain(
      "no measured reset boot",
    );
  });

  it("accepts cold rows and null on an unverified row, and counts rows recorded before the check", () => {
    expect(
      call("boot", {
        0: { resetBootClass: "cold", resetGuestCpuFirstSshS: 280, status: "verified" },
        1: { resetBootClass: null, status: "reset-failed" },
        2: { status: "verified" },
        3: { status: "refuted" },
      }),
    ).toEqual({ bootClassUnrecorded: 2 });
  });

  it("compare() runs the boot check and reports both counts", () => {
    const src = readFileSync(join(__dirname, "..", "scripts", "row7-compare.py"), "utf8");
    const body = src.slice(src.indexOf("def compare("));
    expect(body).toContain("boots = check_boot_class(v3)");
    expect(body.indexOf("check_boot_class(v3)")).toBeLessThan(body.indexOf("pairs = Counter()"));
    expect(body).toContain("boot class unrecorded on {boots['bootClassUnrecorded']} Myco rows");
  });
});

// #546 round 1 D2: the join recomputes the class from the recorded CPU.
describe("row7-compare boot class recomputed from CPU", () => {
  const boot = (myco: Record<number, object>) =>
    py(
      [
        `myco = {int(k): v for k, v in json.loads(${JSON.stringify(JSON.stringify(myco))}).items()}`,
        "try:",
        "    print(json.dumps(row7.check_boot_class(myco)))",
        "except SystemExit as e:",
        "    print(json.dumps(str(e)))",
      ].join("\n"),
    );

  it("refuses a fast boot labelled cold, and a cold label with no CPU", () => {
    expect(
      boot({ 0: { resetBootClass: "cold", resetGuestCpuFirstSshS: 4, status: "verified" } }),
    ).toContain("labelled cold");
    expect(boot({ 0: { resetBootClass: "cold", status: "refuted" } })).toContain("labelled cold");
  });

  it("puts the floor at exactly 100 s", () => {
    expect(boot({ 0: { resetBootClass: "cold", resetGuestCpuFirstSshS: 100 } })).toEqual({
      bootClassUnrecorded: 0,
    });
    expect(boot({ 0: { resetBootClass: "cold", resetGuestCpuFirstSshS: 99 } })).toContain(
      "labelled cold",
    );
  });
});
