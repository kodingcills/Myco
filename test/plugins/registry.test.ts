/**
 * Capability track T, registration: the R5 oracle mutation self-test must pass for every
 * claimed class (host-derived read corruptions included), an over-claiming plugin is
 * refused, only issued registrations run, edited plugins stop running, and every result is
 * labelled with plugin provenance and as not-R1-evidence.
 */
import { spawn } from "node:child_process";
import { appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  hostCorruptions,
  type PluginRegistration,
  registerPlugin,
  runPluginOracle,
  runPluginReader,
} from "../../src/plugins/host/registry.ts";
import { fsizeBlocks, fsizeUnit } from "../../src/plugins/host/sandbox.ts";
import { MAX_SELFTEST_OUTPUT_BYTES } from "../../src/plugins/sdk/protocol.ts";
import {
  cleanupPlugins,
  copyExample,
  EXAMPLE_DIR,
  makePlugin,
  utf8,
  watchDisk,
} from "./helpers.ts";

afterAll(cleanupPlugins);

const T = 60_000;

/** A .txt oracle over the intent "the file says done". `match` decides what verifies. */
function txtPlugin(opts: {
  match?: string;
  claims?: string[];
  extraCorruptions?: string;
  onMismatch?: string;
  ext?: string;
  kinds?: string[];
  source?: string;
}) {
  const ext = opts.ext ?? ".txt";
  const source =
    opts.source ??
    `
const dec = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);
export default {
  oracle(doc) {
    if (doc.bytes === null) return { status: "uncertain", code: "FILE_MISSING" };
    if (${opts.match ?? 'dec(doc.bytes) === "done-and-saved\\n"'}) return { status: "verified", code: "OK" };
    ${opts.onMismatch ?? 'return { status: "refuted", code: "NOT_DONE" };'}
  },
  reader(doc) {
    return doc.bytes === null
      ? { status: "uncertain", code: "FILE_MISSING" }
      : { status: "ok", code: "READ_OK", state: { kind: "text", text: dec(doc.bytes) } };
  },
  selftestCases() {
    const f = "t${ext}";
    return [{
      id: "c1",
      intent: {},
      correct: { fileName: f, bytes: enc("done-and-saved\\n") },
      corruptions: [
        { cls: "edit-missing", doc: { fileName: f, bytes: enc("todo-not-saved\\n") } },
        { cls: "missing-file", doc: { fileName: f, bytes: null } },
        ${opts.extraCorruptions ?? ""}
      ],
    }];
  },
};`;
  return makePlugin(source, {
    claims: opts.claims ?? ["edit-missing", "missing-file"],
    kinds: opts.kinds ?? ["oracle", "reader"],
  });
}

describe("registration requires the R5 self-test for every claimed class", () => {
  it(
    "an honest plugin registers, with its self-test and provenance",
    () => {
      const r = registerPlugin(txtPlugin({}).dir);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.registration.selftest?.pass).toBe(true);
      expect(r.registration.provenance).toMatchObject({
        source: "plugin",
        plugin: "hostile",
        spec: "myco.plugin/1",
      });
      expect(Object.isFrozen(r.registration)).toBe(true);
      // Host-derived read corruptions were run even though the plugin did not ask for them.
      expect(r.registration.selftest?.perClass.truncated.runs).toBe(3);
      expect(r.registration.selftest?.perClass["corrupt-byte"].runs).toBe(3);
      expect(r.registration.selftest?.perClass["missing-file"].runs).toBe(2);
    },
    T,
  );

  it(
    "a plugin that verifies everything is refused",
    () => {
      const r = registerPlugin(txtPlugin({ match: "true" }).dir);
      expect(r).toMatchObject({ ok: false, code: "SELFTEST_FAILED" });
    },
    T,
  );

  it(
    "over-claiming a class with no corruption run is refused",
    () => {
      const r = registerPlugin(
        txtPlugin({ claims: ["edit-missing", "missing-file", "collateral"] }).dir,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("SELFTEST_FAILED");
      expect(r.reasons).toContain("claims collateral but no collateral corruption was run");
    },
    T,
  );

  it(
    "over-claiming a read class is refused even when the plugin supplies an easy corruption",
    () => {
      // Verifies anything that starts with "done": catches its own flipped first byte, misses
      // the host's truncations and later flips.
      const r = registerPlugin(
        txtPlugin({
          match: 'dec(doc.bytes).startsWith("done")',
          claims: ["edit-missing", "missing-file", "corrupt-byte", "truncated"],
          extraCorruptions: `{ cls: "corrupt-byte", doc: { fileName: f, bytes: enc("Xone-and-saved\\n") } },
        { cls: "truncated", doc: { fileName: f, bytes: enc("do") } },`,
        }).dir,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("SELFTEST_FAILED");
      expect(r.reasons.some((x) => x.startsWith("corrupt-byte:"))).toBe(true);
      expect(r.reasons.some((x) => x.startsWith("truncated:"))).toBe(true);
    },
    T,
  );

  it(
    "crashing on corruptions is a harness fault, not a catch",
    () => {
      const r = registerPlugin(txtPlugin({ onMismatch: "process.exit(1);" }).dir);
      expect(r).toMatchObject({
        ok: false,
        code: "SELFTEST_HARNESS_FAULT",
        reasons: ["PLUGIN_CRASH"],
      });
    },
    T,
  );

  it(
    "a correct document that does not verify fails the control",
    () => {
      const r = registerPlugin(txtPlugin({ match: "false" }).dir);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reasons[0]).toMatch(/correct documents did not verify/);
    },
    T,
  );

  it(
    "self-test cases in an undeclared format are refused",
    () => {
      const r = registerPlugin(txtPlugin({ ext: ".md" }).dir);
      expect(r).toMatchObject({ ok: false, code: "SELFTEST_CASES_INVALID" });
    },
    T,
  );

  // E3 (verifier round 1 on #558): the registration self-test call runs under its own
  // ceiling (8 MiB), not the manifest's maxOutputBytes, so its on-disk bound is that ceiling
  // plus one shell block. A plugin with a 4096-byte cap that floods during selftest-cases gets
  // past the verdict cap's bound and is stopped at the self-test one, then refused.
  it(
    "a flood during selftest-cases is stopped at the self-test ceiling plus one block",
    async () => {
      const p = makePlugin(`import { Writable } from "node:stream";
const orig = Writable.prototype.write;
export default {
  oracle() { return { status: "verified", code: "OK" }; },
  selftestCases() {
    Writable.prototype.write = function (chunk, ...rest) {
      const big = Buffer.alloc(1024 * 1024, 65);
      for (let i = 0; i < 16; i++) orig.call(this, big);
      return orig.call(this, chunk, ...rest);
    };
    return [];
  },
};`);
      const unit = fsizeUnit() as number;
      expect([512, 1024]).toContain(unit);
      const w = await watchDisk(() => registerPlugin(p.dir));
      expect(w.result).toMatchObject({
        ok: false,
        code: "SELFTEST_CASES_FAULT",
        reasons: ["PLUGIN_OUTPUT_TOO_LARGE"],
      });
      expect(w.maxSize).toBeGreaterThan(4096 + 1024); // not the manifest cap's bound ...
      expect(w.maxSize).toBeGreaterThan(MAX_SELFTEST_OUTPUT_BYTES); // ... the self-test ceiling's
      expect(w.maxSize).toBeLessThanOrEqual(
        fsizeBlocks(MAX_SELFTEST_OUTPUT_BYTES, unit) * unit, // and no further than one block past it
      );
      expect(w.leftover).toEqual([]);
    },
    T,
  );

  it(
    "an oracle without self-test cases is refused",
    () => {
      const none = makePlugin(
        `export default { oracle() { return { status: "verified", code: "OK" }; } };`,
      );
      expect(registerPlugin(none.dir)).toMatchObject({
        ok: false,
        code: "SELFTEST_CASES_FAULT",
        reasons: ["PLUGIN_NO_HOOK"],
      });
      const empty = makePlugin(
        `export default { oracle() { return { status: "verified", code: "OK" }; }, selftestCases() { return []; } };`,
      );
      expect(registerPlugin(empty.dir)).toMatchObject({
        ok: false,
        code: "SELFTEST_CASES_INVALID",
      });
    },
    T,
  );

  it(
    "a manifest with an unknown key, or a symlink in the plugin, is refused before anything runs",
    () => {
      const p = makePlugin(`export default {};`, { network: true });
      expect(registerPlugin(p.dir)).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
      const q = txtPlugin({});
      symlinkSync("/etc/hostname", join(q.dir, "link"));
      expect(registerPlugin(q.dir)).toMatchObject({ ok: false, code: "PLUGIN_DIR_INVALID" });
      expect(registerPlugin(join(q.dir, "nope"))).toMatchObject({
        ok: false,
        code: "PLUGIN_DIR_INVALID",
      });
    },
    T,
  );

  it(
    "a reader-only plugin registers without a self-test and cannot be used as an oracle",
    () => {
      const p = txtPlugin({ kinds: ["reader"], claims: [] });
      const r = registerPlugin(p.dir);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.registration.selftest).toBeNull();
      const v = runPluginOracle(
        r.registration,
        { fileName: "t.txt", bytes: utf8("done-and-saved\n") },
        {},
      );
      expect(v).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_KIND_UNCLAIMED",
        codeSource: "host",
      });
      const read = runPluginReader(r.registration, { fileName: "t.txt", bytes: utf8("hello") });
      expect(read).toMatchObject({ status: "ok", state: { kind: "text", text: "hello" } });
    },
    T,
  );

  it("host corruptions always differ from the control", () => {
    for (const s of ["a", "ab", "hello world\n"]) {
      const correct = { fileName: "x.txt", bytes: utf8(s) };
      for (const c of hostCorruptions(correct)) {
        expect(
          c.doc.bytes === null ||
            Buffer.compare(Buffer.from(c.doc.bytes), Buffer.from(correct.bytes)) !== 0,
        ).toBe(true);
      }
    }
  });
});

describe("a plugin edited while it registers is refused (V3)", () => {
  // The self-test is slow on purpose (each oracle call spins ~300 ms), and another process
  // edits the plugin 1 s in, so the edit lands after the first tree hash and before the last.
  const SLOW = `
const dec = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);
const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
export default {
  oracle(doc) {
    spin(300);
    if (doc.bytes === null) return { status: "uncertain", code: "FILE_MISSING" };
    return dec(doc.bytes) === "done-and-saved\\n"
      ? { status: "verified", code: "OK" }
      : { status: "refuted", code: "NOT_DONE" };
  },
  selftestCases() {
    const f = "t.txt";
    return [{
      id: "c1",
      intent: {},
      correct: { fileName: f, bytes: enc("done-and-saved\\n") },
      corruptions: [
        { cls: "edit-missing", doc: { fileName: f, bytes: enc("todo-not-saved\\n") } },
        { cls: "missing-file", doc: { fileName: f, bytes: null } },
      ],
    }];
  },
};`;
  const slowPlugin = () =>
    makePlugin(SLOW, {
      claims: ["edit-missing", "missing-file"],
      kinds: ["oracle"],
      caps: { timeoutMs: 5000, memoryMb: 32, maxInputBytes: 65536, maxOutputBytes: 4096 },
    });

  it(
    "an edit landing mid-registration: PLUGIN_CHANGED",
    async () => {
      const p = slowPlugin();
      const editor = spawn(
        "/bin/sh",
        ["-c", 'sleep 1; printf "\\n// edited\\n" >> "$0"', join(p.dir, "plugin.mjs")],
        { stdio: "ignore" },
      );
      const exited = new Promise((r) => editor.on("exit", r));
      const t0 = Date.now();
      const r = registerPlugin(p.dir);
      // The edit must have landed inside the registration window for this test to mean anything.
      expect(Date.now() - t0).toBeGreaterThan(2000);
      await exited;
      expect(r).toMatchObject({
        ok: false,
        code: "PLUGIN_CHANGED",
        reasons: ["plugin directory changed during registration"],
      });
    },
    T,
  );

  it(
    "the same slow plugin registers when nothing edits it (control)",
    () => {
      expect(registerPlugin(slowPlugin().dir)).toMatchObject({ ok: true });
    },
    T,
  );
});

describe("the example plugin and its over-claiming variants", () => {
  it(
    "csv-ledger registers; its unclaimed corrupt-byte gap is visible in the report",
    () => {
      const r = registerPlugin(EXAMPLE_DIR);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const s = r.registration.selftest;
      expect(s?.claims).toEqual([
        "edit-missing",
        "wrong-value",
        "wrong-target",
        "truncated",
        "missing-file",
      ]);
      expect(s?.perClass["corrupt-byte"].claimed).toBe(false);
      expect(s?.perClass["corrupt-byte"].caught).toBeLessThan(
        s?.perClass["corrupt-byte"].runs ?? 0,
      );
    },
    T,
  );

  it.each([["corrupt-byte"], ["collateral"], ["partial-save"]])(
    "csv-ledger claiming %s is refused",
    (cls) => {
      const dir = copyExample({
        claims: ["edit-missing", "wrong-value", "wrong-target", "truncated", "missing-file", cls],
      });
      expect(registerPlugin(dir)).toMatchObject({ ok: false, code: "SELFTEST_FAILED" });
    },
    T,
  );
});

describe("only issued, unchanged registrations run; results are labelled", () => {
  const good = () => {
    const p = txtPlugin({});
    const r = registerPlugin(p.dir);
    if (!r.ok) throw new Error("setup: registration failed");
    return { dir: p.dir, reg: r.registration };
  };
  const done = { fileName: "/captures/trial-1/t.txt", bytes: utf8("done-and-saved\n") };

  it(
    "a registered oracle verifies with provenance, and the result is not R1 evidence",
    () => {
      const { reg } = good();
      const v = runPluginOracle(reg, done, {});
      expect(v).toEqual({
        status: "verified",
        code: "OK",
        codeSource: "plugin",
        provenance: reg.provenance,
        r1Evidence: false,
        evidenceClass: "plugin-experiment",
      });
      // Not a benchmark arm row: the R1 path cannot ingest it.
      expect(validateSchema(v, benchmarkArmRowSchema).length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "a forged registration (a copy of a real one) is refused",
    () => {
      const { reg } = good();
      const forged = { ...reg } as PluginRegistration;
      expect(runPluginOracle(forged, done, {})).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_NOT_REGISTERED",
        provenance: null,
      });
      expect(runPluginReader(forged, done)).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_NOT_REGISTERED",
      });
    },
    T,
  );

  it(
    "a plugin edited after registration stops running: PLUGIN_CHANGED",
    () => {
      const { dir, reg } = good();
      appendFileSync(join(dir, "plugin.mjs"), "\n// edited\n");
      expect(runPluginOracle(reg, done, {})).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_CHANGED",
      });
      writeFileSync(join(dir, "extra.mjs"), "export {};");
      expect(runPluginReader(reg, done)).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_CHANGED",
      });
    },
    T,
  );

  it(
    "a reader is never run on a format the manifest does not declare (V8)",
    () => {
      const { reg } = good();
      expect(runPluginReader(reg, { fileName: "t.xlsx", bytes: utf8("x") })).toEqual({
        status: "uncertain",
        code: "PLUGIN_FORMAT_UNCLAIMED",
        state: null,
        codeSource: "host",
        provenance: reg.provenance,
        r1Evidence: false,
        evidenceClass: "plugin-experiment",
      });
      // Control: the same reader answers on its declared format.
      expect(runPluginReader(reg, { fileName: "t.txt", bytes: utf8("x") })).toMatchObject({
        status: "ok",
        codeSource: "plugin",
      });
    },
    T,
  );

  it(
    "an undeclared format, an oversized document or a bad intent never reaches the plugin",
    () => {
      const { reg } = good();
      expect(runPluginOracle(reg, { fileName: "t.xlsx", bytes: utf8("x") }, {})).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_FORMAT_UNCLAIMED",
      });
      expect(
        runPluginOracle(reg, { fileName: "t.txt", bytes: new Uint8Array(70_000) }, {}),
      ).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_INPUT_TOO_LARGE",
      });
      expect(runPluginOracle(reg, done, { big: "x".repeat(70_000) })).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_INTENT_INVALID",
      });
      expect(
        runPluginOracle(reg, { fileName: "bad name.txt", bytes: utf8("x") }, {}),
      ).toMatchObject({
        status: "uncertain",
        code: "PLUGIN_FILENAME_INVALID",
      });
    },
    T,
  );

  it(
    "a missing file is uncertain, never verified",
    () => {
      const { reg } = good();
      expect(runPluginOracle(reg, { fileName: "t.txt", bytes: null }, {})).toMatchObject({
        status: "uncertain",
        codeSource: "plugin",
      });
    },
    T,
  );
});
