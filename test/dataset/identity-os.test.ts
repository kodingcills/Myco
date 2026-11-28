/**
 * The host identity is read from `os` at export time (lead ruling 21:52Z), proven independently of
 * the machine the suite runs on (#556 round 3, B3: on CI the account is the generic `runner`, so a
 * real-value test skips there). `node:os` is mocked with a non-generic account and a
 * `<name>-MacBook-Pro.local` host; the caller passes a different, planted identity, so only the
 * os values can produce these results.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), username: ["qzmock", "acct"].join("") }),
    hostname: () => ["Qzmockbox", "-MacBook-Pro.local"].join(""),
  };
});

const { identityStrings } = await import("../../src/dataset/hygiene.ts");
const { attempt, candidate } = await import("./identity-fixture.ts");

const ACCOUNT = ["qzmock", "acct"].join("");
const HOST_LABEL = ["Qzmockbox", "-MacBook-Pro"].join("");
const OTHER = { identity: { user: "nobody-u", host: "nohost-u" } };

describe("the host identity comes from os, whatever the caller passes", () => {
  it("identityStrings reads the account and the host name's FIRST DNS label from os", () => {
    const ids = identityStrings(OTHER);
    expect(ids).toContainEqual(["username", ACCOUNT]);
    expect(ids).toContainEqual(["hostname", HOST_LABEL]);
    expect(ids.some(([, v]) => v.endsWith(".local"))).toBe(false);
  });

  it("the os account in an id is digested; in a closed field it refuses", () => {
    for (const v of [ACCOUNT, ACCOUNT.toUpperCase(), `${ACCOUNT}2`]) {
      const id = attempt(candidate({}, { taskId: v }), OTHER);
      expect(id.refused !== null || !id.written.toLowerCase().includes(ACCOUNT)).toBe(true);
      const closed = attempt(
        candidate({ task: { ...candidate().episode.task, taskSetVersion: v } }),
        OTHER,
      );
      expect(closed.refused?.code === "LEAK" && closed.refused?.detail === "username").toBe(true);
    }
  });

  it("the os host label (not the .local suffix) refuses in a closed field, in any case", () => {
    for (const v of [HOST_LABEL, HOST_LABEL.toLowerCase(), `x${HOST_LABEL}`]) {
      const r = attempt(
        candidate({ task: { ...candidate().episode.task, taskSetVersion: v } }),
        OTHER,
      );
      expect(r.refused?.code === "LEAK" && r.refused?.detail === "hostname").toBe(true);
    }
    // `local` alone is not the host.
    const local = attempt(
      candidate({ task: { ...candidate().episode.task, taskSetVersion: "fc.local" } }),
      OTHER,
    );
    expect(local.refused).toBeNull();
  });

  it("the host identity is ALWAYS merged (#553): fake facts, an empty identity or hostIdentity:false never switch it off", () => {
    for (const hygiene of [
      {},
      { hostIdentity: false },
      { identity: { user: "", host: "" } },
      { identity: { user: "nobody-u", host: "nohost-u" }, hostIdentity: false },
    ]) {
      const ids = identityStrings(hygiene);
      expect(ids).toContainEqual(["username", ACCOUNT]);
      expect(ids).toContainEqual(["hostname", HOST_LABEL]);
      // On the write path: a joined form of the os account is digested out of an id, and the
      // os host label refuses in a closed field; and on the self-verify path, validateContainer.
      const id = attempt(candidate({}, { taskId: `xx${ACCOUNT}9` }), hygiene);
      expect(id.refused === null && !id.written.toLowerCase().includes(ACCOUNT)).toBe(true);
      expect(id.valid).toEqual([]);
      const closed = attempt(
        candidate({ task: { ...candidate().episode.task, taskSetVersion: `x${HOST_LABEL}` } }),
        hygiene,
      );
      expect(closed.refused?.code === "LEAK" && closed.refused?.detail === "hostname").toBe(true);
    }
  });
});
