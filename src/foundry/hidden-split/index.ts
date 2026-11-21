import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FaultSpec } from "../faults/index.ts";
import { TODO_FIXTURE_SPECS, todoFixture } from "../tasks/todo.ts";
import type { FixtureManifest, TaskIntent } from "../types.ts";

export const hiddenSplitVersion = 1;
export class HiddenSplitError extends Error {
  constructor(readonly code: "unset" | "in-tree" | "permissions" | "seed" | "missing" | "owner") {
    super(`Hidden split: ${code}`);
  }
}
function outsideTree(dir: string) {
  let path = realpathSync(dir);
  for (;;) {
    if (existsSync(join(path, ".git"))) throw new HiddenSplitError("in-tree");
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}
export function initHiddenSplit(dir: string): void {
  let ancestor = resolve(dir);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  outsideTree(ancestor);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  outsideTree(dir);
  if (typeof process.getuid === "function" && statSync(dir).uid !== process.getuid())
    throw new HiddenSplitError("owner");
  if ((statSync(dir).mode & 0o077) !== 0) throw new HiddenSplitError("permissions");
  writeFileSync(join(dir, "seed"), randomBytes(32), { mode: 0o600, flag: "wx" });
}
export function loadHiddenSplit(dir = process.env.MYCO_FOUNDRY_HIDDEN_DIR): Uint8Array {
  if (!dir) throw new HiddenSplitError("unset");
  const path = resolve(dir);
  if (!existsSync(path)) throw new HiddenSplitError("missing");
  outsideTree(path);
  if (typeof process.getuid === "function" && statSync(path).uid !== process.getuid())
    throw new HiddenSplitError("owner");
  if ((statSync(path).mode & 0o077) !== 0) throw new HiddenSplitError("permissions");
  const file = join(path, "seed");
  if (!existsSync(file) || (statSync(file).mode & 0o077) !== 0) throw new HiddenSplitError("seed");
  const seed = readFileSync(file);
  if (seed.length < 32) throw new HiddenSplitError("seed");
  return seed;
}
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export interface HiddenFixture {
  readonly fixture: FixtureManifest;
  readonly intent: TaskIntent;
  readonly fault: FaultSpec;
}
export function generateHiddenFixtures(seed: Uint8Array, n: number): HiddenFixture[] {
  if (seed.length < 32 || !Number.isSafeInteger(n) || n < 0)
    throw new Error("Invalid generator input");
  let counter = 0;
  const next = () => createHash("sha256").update(seed).update(String(counter++)).digest("hex");
  const text = () => `item ${next().slice(0, 24)}`;
  const faults = [
    "stale-ui",
    "interrupted-write",
    "partial-persistence",
    "crash-mid-save",
    "permission-denied",
  ] as const;
  return Array.from({ length: n }, (_, i) =>
    TODO_FIXTURE_SPECS.map((base) => {
      const id = next();
      const items = base.seedItems.map((item) => ({ ...item, text: text() }));
      const target = text();
      let intent: TaskIntent;
      if (base.defect === "silent-drop")
        intent = { kind: "todo.add-items", items: [`BUG: ${target}`, text()] };
      else if (base.defect === "wrong-value")
        intent = { kind: "todo.add-items", items: [`Release: ${target}`] };
      else if (base.defect === "stale-row")
        intent = { kind: "todo.rename-item", from: items[0]!.text, to: target };
      else intent = { kind: "todo.delete-items", items: [items[0]!.text] };
      const claims =
        intent.kind === "todo.rename-item"
          ? [intent.to]
          : intent.kind === "todo.add-items"
            ? [...intent.items]
            : items.slice(1).map((item) => item.text);
      const fixture = todoFixture(
        { ...base, fixtureId: id, seedItems: items, screenClaimsToTrap: claims },
        1,
      );
      return {
        fixture,
        intent,
        fault: {
          fault: faults[i % faults.length]!,
          version: 1,
          seed: Number.parseInt(next().slice(0, 12), 16),
        },
      };
    }),
  ).flat();
}
function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return canonical(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const fixtureHash = (fixture: HiddenFixture) => hash(canonical(fixture));
export function commitment(fixtures: readonly HiddenFixture[]) {
  const perFixtureHash = fixtures.map(fixtureHash).sort();
  return {
    hiddenSplitVersion,
    count: fixtures.length,
    rootHash: hash(JSON.stringify(perFixtureHash)),
    perFixtureHash,
  };
}
export function verifyCommitment(
  fixtures: readonly HiddenFixture[],
  expected: ReturnType<typeof commitment>,
): boolean {
  return JSON.stringify(commitment(fixtures)) === JSON.stringify(expected);
}
