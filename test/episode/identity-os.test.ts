/**
 * The host identity is read from `os` at export time and ALWAYS merged into what the caller passes
 * (lead ruling 21:52Z; #553's rule), proven independently of the machine the suite runs on (#556
 * round 3, B3: on CI the account is the generic `runner`, so a real-value test skips there).
 * `node:os` is mocked with a non-generic account and a `<name>-MacBook-Pro.local` host; the
 * caller passes fake HostFacts and only a short and a generic extra name, so only the os values
 * can produce these results.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), username: ["qzmock", "acct"].join("") }),
    hostname: () => ["Qzmockbox", "-MacBook-Pro.local"].join(""),
  };
});

const { identityEntries } = await import("../../src/episode/identity.ts");
const { exportDataset, NO_FILTER } = await import("../../src/episode/export.ts");
const { EpisodeStore } = await import("../../src/episode/store.ts");
const { draft, HOST, scratch } = await import("./helpers.ts");

const ACCOUNT = ["qzmock", "acct"].join("");
const HOST_LABEL = ["Qzmockbox", "-MacBook-Pro"].join("");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = (p: string) => {
  const d = scratch(p);
  made.push(d);
  return d;
};

describe("the host identity comes from os and is always merged in", () => {
  it("identityEntries reads the account and the host name's FIRST DNS label, whatever the caller passes", () => {
    for (const options of [
      {},
      { users: ["ab", "root"] },
      { users: [] as string[], hosts: [] as string[] },
    ]) {
      const ids = identityEntries(options);
      expect(ids).toContainEqual(["username", ACCOUNT]);
      expect(ids).toContainEqual(["hostname", HOST_LABEL]);
      expect(ids.some(([, v]) => v.endsWith(".local"))).toBe(false);
    }
  });

  it("on the write path: the os account in an id is digested; the os host label in a closed field refuses; the filter too", () => {
    const store = (edit: (d: ReturnType<typeof draft>) => ReturnType<typeof draft>) => {
      const root = join(dir("os-store"), "s");
      EpisodeStore.open(root, { simulated: true, host: HOST }).record(
        draft(edit(draft())),
        new Map(),
      );
      return root;
    };
    for (const v of [ACCOUNT, ACCOUNT.toUpperCase(), `xx${ACCOUNT}9`]) {
      const root = store((d) => ({ ...d, task: { ...d.task, id: v } }));
      const out = join(dir("os-out"), "ds");
      const m = exportDataset({
        stores: [root],
        out,
        simulated: true,
        host: HOST,
        identity: { users: ["ab", "root"] },
      });
      expect(m.counts.episodes).toBe(1);
      const written = readdirSync(join(out, "episodes"))
        .map((f) => readFileSync(join(out, "episodes", f), "utf8"))
        .join("");
      expect(written.toLowerCase().includes(ACCOUNT)).toBe(false);
    }
    for (const v of [HOST_LABEL, HOST_LABEL.toLowerCase(), `x${HOST_LABEL}`]) {
      const root = store((d) => ({ ...d, task: { ...d.task, taskSetVersion: v } }));
      expect(() =>
        exportDataset({
          stores: [root],
          out: join(dir("os-out2"), "ds"),
          simulated: true,
          host: HOST,
        }),
      ).toThrow("(hostname at $.task.taskSetVersion)");
    }
    const root = store((d) => d);
    expect(() =>
      exportDataset({
        stores: [root],
        out: join(dir("os-out3"), "ds"),
        simulated: true,
        host: HOST,
        filter: { ...NO_FILTER, taskSetVersion: ACCOUNT.toUpperCase() },
      }),
    ).toThrow("(username at $.filter.taskSetVersion)");
  });
});
