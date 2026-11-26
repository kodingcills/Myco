/**
 * Capability track T, the closed `myco.plugin/1` contract: manifests and responses are parsed
 * closed (unknown keys, out-of-range caps, free-text codes are refused), and the SDK's class
 * list is the R5 self-test's.
 */
import { describe, expect, it } from "vitest";
import { CORRUPTION_CLASSES } from "../../src/oracle-selftest/types.ts";
import {
  CAP_CEILINGS,
  PLUGIN_CORRUPTION_CLASSES,
  PLUGIN_SPEC,
  parseManifest,
  parseRequest,
  parseResponse,
} from "../../src/plugins/sdk/protocol.ts";
import { BASE_MANIFEST } from "./helpers.ts";

describe("myco.plugin/1 manifest is closed", () => {
  it("the SDK's corruption classes are exactly the R5 self-test's", () => {
    expect([...PLUGIN_CORRUPTION_CLASSES]).toEqual([...CORRUPTION_CLASSES]);
  });

  it("accepts the base manifest and canonicalises claim order", () => {
    const m = parseManifest({ ...BASE_MANIFEST, claims: ["missing-file", "edit-missing"] });
    expect(m.claims).toEqual(["edit-missing", "missing-file"]);
  });

  it.each([
    ["an unknown top-level key (a network capability)", { network: true }],
    ["an unknown caps key", { caps: { ...BASE_MANIFEST.caps, network: "any" } }],
    ["a filesystem capability", { caps: { ...BASE_MANIFEST.caps, fsRead: ["/"] } }],
    ["a cap above the host ceiling", { caps: { ...BASE_MANIFEST.caps, timeoutMs: 10_001 } }],
    ["memory above the ceiling", { caps: { ...BASE_MANIFEST.caps, memoryMb: 4096 } }],
    ["a non-integer cap", { caps: { ...BASE_MANIFEST.caps, memoryMb: 32.5 } }],
    ["another spec version", { spec: "myco.plugin/2" }],
    ["an oracle with no claims", { claims: [] }],
    ["claims on a reader-only plugin", { kinds: ["reader"] }],
    ["an unknown claim", { claims: ["everything"] }],
    ["duplicate claims", { claims: ["missing-file", "missing-file"] }],
    ["an unknown kind", { kinds: ["oracle", "writer"] }],
    ["no formats", { formats: [] }],
    [
      "a format with an extra key",
      { formats: [{ ext: ".txt", mediaType: "text/plain", exec: true }] },
    ],
    ["an entry escaping the directory", { entry: "../x.mjs" }],
    ["an absolute entry", { entry: "/tmp/x.mjs" }],
    ["a non-module entry", { entry: "plugin.sh" }],
    ["a bad name", { name: "Bad Name" }],
    ["a bad version", { version: "1.0" }],
  ])("refuses %s", (_label, patch) => {
    expect(() => parseManifest({ ...BASE_MANIFEST, ...patch })).toThrow();
  });

  it("the host ceilings are pinned", () => {
    expect(CAP_CEILINGS).toEqual({
      timeoutMs: 10_000,
      memoryMb: 256,
      maxInputBytes: 16 * 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
    });
    expect(() =>
      parseManifest({
        ...BASE_MANIFEST,
        caps: { ...BASE_MANIFEST.caps, maxOutputBytes: 1024 * 1024 + 1 },
      }),
    ).toThrow();
  });

  it("refuses a missing key", () => {
    const { caps: _caps, ...rest } = BASE_MANIFEST;
    expect(() => parseManifest(rest)).toThrow(/MISSING_KEY/);
  });
});

describe("myco.plugin/1 wire is closed", () => {
  const verified = { spec: PLUGIN_SPEC, op: "verify", status: "verified", code: "OK" };

  it("accepts a well-formed verify response", () => {
    expect(parseResponse(verified, "verify")).toEqual(verified);
  });

  it.each([
    ["an extra key", { ...verified, evidence: true }],
    ["a free-text code", { ...verified, code: "/home/user/secret path" }],
    ["a lowercase code", { ...verified, code: "ok" }],
    ["an over-long code", { ...verified, code: `A${"B".repeat(64)}` }],
    ["an unknown status", { ...verified, status: "pass" }],
    ["another spec", { ...verified, spec: "myco.plugin/0" }],
    ["a missing code", { spec: PLUGIN_SPEC, op: "verify", status: "verified" }],
  ])("refuses a verify response with %s", (_label, v) => {
    expect(() => parseResponse(v, "verify")).toThrow();
  });

  it("refuses a response for another op", () => {
    expect(() => parseResponse(verified, "read")).toThrow(/WRONG_OP/);
  });

  it("a read response carries state exactly when ok, and cell values match their kind", () => {
    const ok = {
      spec: PLUGIN_SPEC,
      op: "read",
      status: "ok",
      code: "READ_OK",
      state: {
        kind: "cells",
        cells: [{ ref: "A1", value: 3, valueKind: "number", formula: false }],
      },
    };
    expect(parseResponse(ok, "read")).toEqual(ok);
    expect(() => parseResponse({ ...ok, state: null }, "read")).toThrow();
    expect(() => parseResponse({ ...ok, status: "uncertain" }, "read")).toThrow();
    expect(() =>
      parseResponse(
        {
          ...ok,
          state: {
            kind: "cells",
            cells: [{ ref: "A1", value: "3", valueKind: "number", formula: false }],
          },
        },
        "read",
      ),
    ).toThrow();
    expect(() =>
      parseResponse({ ...ok, state: { kind: "text", text: "x", cells: [] } }, "read"),
    ).toThrow(/UNKNOWN_KEY/);
  });

  it("self-test cases are bounded, unique and closed", () => {
    const doc = { fileName: "a.txt", bytesB64: "YQ==" };
    const c = {
      id: "c1",
      intent: {},
      correct: doc,
      corruptions: [{ cls: "missing-file", doc: { ...doc, bytesB64: null } }],
    };
    const ok = { spec: PLUGIN_SPEC, op: "selftest-cases", cases: [c] };
    expect(parseResponse(ok, "selftest-cases")).toEqual(ok);
    expect(() => parseResponse({ ...ok, cases: [c, c] }, "selftest-cases")).toThrow(/duplicates/);
    expect(() =>
      parseResponse(
        { ...ok, cases: [{ ...c, correct: { ...doc, bytesB64: null } }] },
        "selftest-cases",
      ),
    ).toThrow();
    expect(() =>
      parseResponse(
        { ...ok, cases: [{ ...c, correct: { ...doc, fileName: "../a.txt" } }] },
        "selftest-cases",
      ),
    ).toThrow();
    expect(() =>
      parseResponse(
        { ...ok, cases: [{ ...c, correct: { ...doc, bytesB64: "not base64!" } }] },
        "selftest-cases",
      ),
    ).toThrow();
  });

  it("a request carries a basename and bounded intent only", () => {
    const req = {
      spec: PLUGIN_SPEC,
      op: "verify",
      doc: { fileName: "a.txt", bytesB64: null },
      intent: {},
    };
    expect(parseRequest(req)).toEqual(req);
    expect(() => parseRequest({ ...req, doc: { fileName: "/x/a.txt", bytesB64: null } })).toThrow();
    expect(() => parseRequest({ ...req, intent: { big: "x".repeat(70_000) } })).toThrow(
      /INTENT_TOO_LARGE/,
    );
    expect(() => parseRequest({ ...req, path: "/x" })).toThrow(/UNKNOWN_KEY/);
  });
});
