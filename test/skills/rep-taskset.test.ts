/**
 * rep-v1, track M's measurement task set (capability-spec §2 M "Task set (new)"): the
 * committed manifest is exactly what the pre-registered build seed derives from fc-v1, and it
 * holds the spec's splits. Every rule `repManifestProblems` checks is shown to bite.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepTaskSet,
  REP_LEARN_N,
  type RepManifest,
  repManifestProblems,
  repManifestSha256,
} from "../../src/skills/rep-taskset.ts";
import { ROOT, TASKS, taskById } from "./helpers.ts";

const PREREG = JSON.parse(
  readFileSync(join(ROOT, "docs/product/capability-prereg/m-v1/prereg.json"), "utf8"),
);
const COMMITTED = JSON.parse(
  readFileSync(join(ROOT, PREREG.taskSet.manifest), "utf8"),
) as RepManifest;

describe("rep-v1 task set", () => {
  it("the committed manifest is what the pre-registered build seed derives", () => {
    expect(buildRepTaskSet(PREREG.seeds.taskBuild)).toEqual(COMMITTED);
    expect(repManifestSha256(COMMITTED)).toBe(PREREG.taskSet.manifestSha256);
  });

  it("is deterministic and depends on the seed", () => {
    expect(buildRepTaskSet("seed-aaaa-1111")).toEqual(buildRepTaskSet("seed-aaaa-1111"));
    expect(repManifestSha256(buildRepTaskSet("seed-bbbb-2222"))).not.toBe(
      repManifestSha256(COMMITTED),
    );
  });

  it("holds the ruled splits: 30 learn, 30 repeat, 30 similar, all rules", () => {
    expect(repManifestProblems(COMMITTED)).toEqual([]);
    expect(COMMITTED.learn).toHaveLength(REP_LEARN_N);
    expect(COMMITTED.test.filter((u) => u.kind === "repeat")).toHaveLength(30);
    expect(COMMITTED.test.filter((u) => u.kind === "similar")).toHaveLength(30);
    const learnSeeds = new Set(COMMITTED.learn.map((l) => l.fixtureSeed));
    for (const u of COMMITTED.test) {
      const t = taskById(u.taskId);
      expect(t.faultClass).toBe("none");
      expect(t.satisfiable).toBe(true);
      expect(t.family).toBe("calc-record-edit");
      if (u.kind === "repeat") expect(u.taskId).toBe(u.learnTaskId);
      else {
        const l = taskById(u.learnTaskId);
        expect(learnSeeds.has(t.fixtureSeed)).toBe(false);
        expect(t.intent.rowKey).not.toBe(l.intent.rowKey);
        expect(t.intent.column).not.toBe(l.intent.column);
        expect(COMMITTED.learn.some((x) => x.taskId === u.taskId)).toBe(false);
      }
    }
  });

  const mutate = (f: (m: { -readonly [K in keyof RepManifest]: RepManifest[K] }) => void) => {
    const m = structuredClone(COMMITTED) as { -readonly [K in keyof RepManifest]: RepManifest[K] };
    f(m);
    return repManifestProblems(m);
  };
  const similarIdx = COMMITTED.test.findIndex((u) => u.kind === "similar");

  it.each([
    ["a learn task dropped", (m: RepManifest) => (m.learn as unknown[]).pop(), "learn has 29"],
    [
      "a similar task from the learn split",
      (m: RepManifest) => {
        const u = m.test[similarIdx] as { taskId: string };
        const l = m.learn[0] as RepManifest["learn"][number];
        Object.assign(u, { ...l, taskId: l.taskId });
      },
      "similar task is in the learn split",
    ],
    [
      "a similar task sharing a learn fixture",
      (m: RepManifest) => {
        // At 30 learn tasks every task on a learn fixture seed is itself a learn task, so the
        // planted similar unit claims a learn task's fixture seed directly.
        Object.assign(m.test[similarIdx] as object, {
          fixtureSeed: (m.learn[0] as RepManifest["learn"][number]).fixtureSeed,
        });
      },
      "similar shares a learn fixture",
    ],
    [
      "a repeat that is not its learn task",
      (m: RepManifest) => {
        Object.assign(m.test[0] as object, {
          learnTaskId: (m.learn[1] as { taskId: string }).taskId,
        });
      },
      "a repeat is not its learn task",
    ],
    [
      "a fixture digest that is not the published one",
      (m: RepManifest) => Object.assign(m.learn[0] as object, { fixtureSha256: "0".repeat(64) }),
      "does not match the published task",
    ],
    [
      "a fault task",
      (m: RepManifest) => {
        const t = TASKS.find((x) => x.faultClass !== "none") as (typeof TASKS)[number];
        Object.assign(m.learn[0] as object, { taskId: t.taskId });
      },
      "not a no-fault satisfiable fc-v1 task",
    ],
  ])("refuses %s", (_name, f, expected) => {
    expect(mutate(f).join("\n")).toContain(expected);
  });

  it("refuses a similar task that keeps its learn task's column", () => {
    const u = COMMITTED.test[similarIdx] as RepManifest["test"][number];
    const l = taskById(u.learnTaskId);
    const sameCol = TASKS.find(
      (t) =>
        t.faultClass === "none" &&
        t.satisfiable &&
        t.intent.column === l.intent.column &&
        t.taskId !== l.taskId &&
        !COMMITTED.learn.some((x) => x.fixtureSeed === t.fixtureSeed || x.taskId === t.taskId),
    );
    expect(sameCol).toBeDefined();
    const t = sameCol as NonNullable<typeof sameCol>;
    expect(
      mutate((m) =>
        Object.assign(m.test[similarIdx] as object, {
          taskId: t.taskId,
          fixtureSeed: t.fixtureSeed,
          fixtureSha256: t.fixtureSha256,
          instructionSha256: t.instructionSha256,
        }),
      ).join("\n"),
    ).toContain("keeps its learn task's record or column");
  });
});
