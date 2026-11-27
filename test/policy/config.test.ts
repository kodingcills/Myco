/**
 * Track O host config: declared on the host, never in the agent's reach; pinned by SHA-256 at
 * load; missing refuses the trial; unparseable denies every action.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedNoBlock } from "../../src/policy/bounded-read.ts";
import { loadPolicyConfig, MAX_CONFIG_BYTES, parsePolicyConfig } from "../../src/policy/config.ts";
import { startPolicy } from "../../src/policy/guard.ts";
import { ALL_RULES, fixture, oneRule, POLICED_ARM_TOOLS, writeConfig } from "./helpers.ts";

const NONE = { writes: [], deletes: [], launches: [], credentialInput: false, destructive: 0 };

function start(f: ReturnType<typeof fixture>, configPath: string, extraRoots: string[] = []) {
  return startPolicy({
    configPath,
    scope: { originalDocument: f.original, documentDir: f.docDir },
    grantedTools: POLICED_ARM_TOOLS,
    agentRoots: extraRoots,
    screenSensor: () => false,
  });
}

describe("policy config: refuse to start rather than run unpoliced", () => {
  it("a missing config refuses the trial", () => {
    const f = fixture();
    expect(start(f, join(f.host, "absent.json"))).toEqual({
      ok: false,
      code: "POLICY_CONFIG_MISSING",
    });
  });

  it("a relative config path is refused (not a host path)", () => {
    const f = fixture();
    writeConfig(f, ALL_RULES);
    expect(start(f, "host/policy.json")).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_HOST" });
  });

  it("a config inside the document directory (agent-editable) is refused", () => {
    const f = fixture();
    const p = join(f.docDir, "policy.json");
    writeFileSync(p, JSON.stringify(ALL_RULES));
    expect(start(f, p)).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_HOST" });
  });

  it("a host-looking symlink that resolves into an agent root is refused", () => {
    const f = fixture();
    const inside = join(f.docDir, "real.json");
    writeFileSync(inside, JSON.stringify(ALL_RULES));
    const link = join(f.host, "link.json");
    symlinkSync(inside, link);
    expect(start(f, link)).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_HOST" });
  });

  it("a config inside any extra agent root (workspace, guest share) is refused", () => {
    const f = fixture();
    const share = join(f.root, "share");
    mkdirSync(share);
    const p = join(share, "policy.json");
    writeFileSync(p, JSON.stringify(ALL_RULES));
    expect(start(f, p, [share])).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_HOST" });
    expect(start(f, writeConfig(f, ALL_RULES), [join(f.root, "missing-root")])).toEqual({
      ok: false,
      code: "POLICY_CONFIG_NOT_HOST",
    });
  });

  it("a declared flagged-screen rule without a host screen sensor refuses the trial", () => {
    const f = fixture();
    const r = startPolicy({
      configPath: writeConfig(f, ALL_RULES),
      scope: { originalDocument: f.original, documentDir: f.docDir },
      grantedTools: POLICED_ARM_TOOLS,
    });
    expect(r).toEqual({ ok: false, code: "POLICY_SENSOR_MISSING" });
  });

  it("a scope that does not resolve refuses the trial", () => {
    const f = fixture();
    const r = startPolicy({
      configPath: writeConfig(f, ALL_RULES),
      scope: { originalDocument: f.outside, documentDir: f.docDir },
      grantedTools: POLICED_ARM_TOOLS,
      screenSensor: () => false,
    });
    expect(r).toEqual({ ok: false, code: "POLICY_SCOPE_INVALID" });
  });
});

describe.runIf(process.platform !== "win32")(
  "policy config: blocking and unbounded objects fail closed at once (child, hard timeout)",
  () => {
    const CHILD = join(import.meta.dirname, "config-child.ts");
    const run = (mode: string): unknown => {
      const started = Date.now();
      const child = spawnSync(process.execPath, ["--import", "tsx", CHILD, mode], {
        cwd: join(import.meta.dirname, "..", ".."),
        encoding: "utf8",
        timeout: 8_000,
        killSignal: "SIGKILL",
      });
      expect(child.signal, `${mode}: the loader blocked and was killed`).toBeNull();
      expect(Date.now() - started).toBeLessThan(8_000);
      return JSON.parse(child.stdout.trim());
    };

    it.each([
      ["fifo", { ok: false, code: "POLICY_CONFIG_NOT_REGULAR" }],
      ["fifo-in-root", { ok: false, code: "POLICY_CONFIG_NOT_HOST" }],
      ["swap-to-fifo", { ok: false, code: "not-regular" }],
    ])("%s", (mode, want) => expect(run(mode)).toEqual(want), 15_000);

    it.runIf(process.platform === "linux")(
      "dev-zero",
      () => expect(run("dev-zero")).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_REGULAR" }),
      15_000,
    );
  },
);

describe("policy config: pinned, closed, fail closed", () => {
  it("the recorded hash is the SHA-256 of the exact bytes read", () => {
    const f = fixture();
    const p = writeConfig(f, ALL_RULES);
    const loaded = loadPolicyConfig(p, { agentRoots: [f.docDir] });
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(loaded.sha256).toBe(createHash("sha256").update(readFileSync(p)).digest("hex"));
  });

  it("editing the config after the trial started changes nothing (read once)", () => {
    const f = fixture();
    const p = writeConfig(f, oneRule({ kind: "no-credential-input", effect: "deny" }));
    const r = start(f, p);
    if (!r.ok) throw new Error(r.code);
    const before = r.guard.configSha256;
    writeFileSync(p, JSON.stringify({ schema: "myco.policy-config/1", policies: [] }));
    expect(
      r.guard.decide("app-adapter.act", () => ({ ...NONE, credentialInput: true })),
    ).toMatchObject({ decision: "deny", code: "POLICY_CREDENTIAL_INPUT" });
    expect(r.guard.configSha256).toBe(before);
  });

  it.each([
    ["not JSON", "{"],
    ["wrong schema", JSON.stringify({ ...ALL_RULES, schema: "myco.policy-config/2" })],
    ["extra top-level key", JSON.stringify({ ...ALL_RULES, allowAll: true })],
    ["no policies", JSON.stringify({ schema: "myco.policy-config/1", policies: [] })],
    ["unknown kind", JSON.stringify(oneRule({ kind: "anything-goes", effect: "deny" }))],
    ["effect allow", JSON.stringify(oneRule({ kind: "write-scope", effect: "allow" }))],
    ["extra rule key", JSON.stringify(oneRule({ kind: "write-scope", effect: "deny", off: true }))],
    ["bad max", JSON.stringify(oneRule({ kind: "destructive-limit", effect: "deny", max: -1 }))],
    [
      "bad app id",
      JSON.stringify(oneRule({ kind: "app-allowlist", effect: "deny", apps: ["A B"] })),
    ],
    [
      "duplicate ids",
      JSON.stringify({
        schema: "myco.policy-config/1",
        policies: [
          { id: "x", kind: "write-scope", effect: "deny" },
          { id: "x", kind: "no-credential-input", effect: "deny" },
        ],
      }),
    ],
  ])("an unparseable config (%s) loads as invalid and denies every action", (_n, text) => {
    expect(parsePolicyConfig(text)).toBeNull();
    const f = fixture();
    const r = start(f, writeConfig(f, text));
    if (!r.ok) throw new Error(r.code);
    expect(r.guard.decide("app-adapter.act", () => NONE)).toMatchObject({
      decision: "deny",
      code: "POLICY_CONFIG_INVALID",
      agent: { code: "POLICY_DENIED" },
    });
    expect(r.guard.configSha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("a config of exactly MAX_CONFIG_BYTES loads; one byte more refuses the trial unread", () => {
    const f = fixture();
    const body = JSON.stringify(oneRule({ kind: "write-scope", effect: "deny" }));
    const exact = body + " ".repeat(MAX_CONFIG_BYTES - Buffer.byteLength(body));
    const p = writeConfig(f, exact);
    const loaded = loadPolicyConfig(p, { agentRoots: [f.docDir] });
    expect(loaded).toMatchObject({ ok: true, config: { schema: "myco.policy-config/1" } });
    writeFileSync(p, `${exact} `);
    expect(loadPolicyConfig(p, { agentRoots: [f.docDir] })).toEqual({
      ok: false,
      code: "POLICY_CONFIG_TOO_LARGE",
    });
    expect(start(f, p)).toEqual({ ok: false, code: "POLICY_CONFIG_TOO_LARGE" });
  });

  it("a symlink at the config's own name (to a host file) and a directory are not regular", () => {
    const f = fixture();
    const target = writeConfig(f, ALL_RULES);
    const link = join(f.host, "link.json");
    symlinkSync(target, link);
    expect(start(f, link)).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_REGULAR" });
    const dir = join(f.host, "dir.json");
    mkdirSync(dir);
    expect(start(f, dir)).toEqual({ ok: false, code: "POLICY_CONFIG_NOT_REGULAR" });
    // The target itself, named directly, still loads.
    expect(start(f, target)).toMatchObject({ ok: true });
  });

  it.runIf(process.platform === "linux")(
    "a file whose size lies (procfs reports 0) is caught by the bounded read, not read on",
    () => {
      const p = "/proc/self/status";
      expect(readBoundedNoBlock(p, 16, lstatSync(p))).toEqual({ ok: false, code: "too-large" });
      const loaded = loadPolicyConfig(p, { agentRoots: [] });
      // procfs reports size 0, so only the read's own bound can refuse it; the file is far
      // under 64 KiB, so it loads, as bytes that do not parse (deny-all).
      expect(loaded).toMatchObject({ ok: true, config: null });
    },
  );

  it("an inode swapped between the pre-check and the open is refused", () => {
    const f = fixture();
    const a = writeConfig(f, ALL_RULES, "a.json");
    const b = writeConfig(f, ALL_RULES, "b.json");
    expect(readBoundedNoBlock(a, MAX_CONFIG_BYTES, lstatSync(b))).toEqual({
      ok: false,
      code: "swapped",
    });
    expect(readBoundedNoBlock(a, MAX_CONFIG_BYTES, lstatSync(a))).toMatchObject({ ok: true });
  });

  it.runIf(process.platform !== "win32")(
    "a symlink swapped in at the last component is refused by the open, never followed",
    () => {
      const f = fixture();
      const target = writeConfig(f, ALL_RULES, "target.json");
      const link = join(f.host, "swapped.json");
      symlinkSync(target, link);
      // Even with the target's own inode as the expectation, O_NOFOLLOW refuses the link.
      expect(readBoundedNoBlock(link, MAX_CONFIG_BYTES, lstatSync(target))).toEqual({
        ok: false,
        code: "not-regular",
      });
    },
  );

  it("a parsed config is deeply frozen", () => {
    const c = parsePolicyConfig(JSON.stringify(ALL_RULES));
    expect(c).not.toBeNull();
    if (c === null) return;
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.policies)).toBe(true);
    expect(c.policies.every((r) => Object.isFrozen(r))).toBe(true);
  });
});
