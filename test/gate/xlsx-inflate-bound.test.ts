/**
 * Round 3, D7 (V5): inflation is bounded by the entry's declared size. A lying entry that
 * declares 1000 bytes but inflates to 5 MiB must be stopped at the bound, not inflated in
 * full and only then compared. The outcome code is the same either way
 * (`XLSX_INFLATE_FAILED`), so this file watches the inflater itself: `node:zlib` is wrapped
 * (in this file only) to record each call's `maxOutputLength` and how many bytes it
 * actually produced. Removing the bound makes the recorded output 5 MiB and fails here.
 */
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readZipEntries, type XlsxErrorCode } from "../../src/gate/xlsx-document.ts";
import { writeZip } from "../../src/tasks/writer-docgen.ts";

interface InflateCall {
  readonly maxOutputLength: number | undefined;
  readonly produced: number | "threw";
}
const calls: InflateCall[] = [];

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    inflateRawSync: (input: zlib.InputType, options?: zlib.ZlibOptions) => {
      try {
        const out = actual.inflateRawSync(input, options);
        calls.push({ maxOutputLength: options?.maxOutputLength, produced: out.length });
        return out;
      } catch (error) {
        calls.push({ maxOutputLength: options?.maxOutputLength, produced: "threw" });
        throw error;
      }
    },
  };
});

afterEach(() => {
  calls.length = 0;
});

const DECLARED = 1000;
const ACTUAL = 5 * 1024 * 1024;

function codeOf(fn: () => unknown): XlsxErrorCode | "no error" {
  try {
    fn();
    return "no error";
  } catch (error) {
    return (error as { code: XlsxErrorCode }).code;
  }
}

describe("V5: inflation is bounded by the declared size (maxOutputLength)", () => {
  it("a lying entry (declares 1000 B, inflates to 5 MiB) is stopped at 1000 B", () => {
    const zeros = new Uint8Array(ACTUAL);
    const body = zlib.deflateRawSync(zeros);
    // Under the ratio grace and every cap: only the bound stops the inflater early.
    expect(body.length).toBeLessThan(DECLARED * 10);
    const bytes = writeZip([
      {
        name: "xl/lying.bin",
        data: new Uint8Array(),
        deflated: { body, crc: zlib.crc32(zeros.subarray(0, DECLARED)) >>> 0, size: DECLARED },
      },
    ]);
    expect(codeOf(() => readZipEntries(bytes))).toBe("XLSX_INFLATE_FAILED");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxOutputLength).toBe(DECLARED);
    // The bound stopped it: nothing near 5 MiB was ever produced.
    const produced = calls[0]?.produced ?? Number.POSITIVE_INFINITY;
    expect(produced === "threw" || produced <= DECLARED).toBe(true);
  });

  it("an honest entry inflates with the bound set to exactly its declared size", () => {
    const data = new TextEncoder().encode("x".repeat(4096));
    const bytes = writeZip([{ name: "xl/honest.xml", data }]);
    expect(new Uint8Array(readZipEntries(bytes).get("xl/honest.xml") ?? [])).toEqual(data);
    expect(calls).toEqual([{ maxOutputLength: data.length, produced: data.length }]);
  });
});
