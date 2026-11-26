/**
 * A file that shrinks while it is captured is refused (`CAPTURE_CHANGED`), never captured
 * partially (src/desktops/local-process.ts). The shrink is simulated by making `readSync`
 * report end-of-file early, which is what a concurrent truncation looks like to the reader.
 * Mutation-proved by scripts/desktops-mutation-proof.sh (d13).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const shrink = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readSync = ((...args: Parameters<typeof real.readSync>) => {
    if (shrink.on) {
      // Hand back half of what was asked for, then report end-of-file.
      const [fd, buffer, offset, length, position] = args as unknown as [
        number,
        Uint8Array,
        number,
        number,
        number,
      ];
      if (position > 0) return 0;
      return real.readSync(fd, buffer, offset, Math.floor(length / 2), position);
    }
    return (real.readSync as (...a: unknown[]) => number)(...args);
  }) as typeof real.readSync;
  return { ...real, default: { ...real, readSync }, readSync };
});

const { LocalProcessBackend } = await import("../../src/desktops/local-process.ts");

describe("capture of a file that changes mid-read", () => {
  it("is refused with CAPTURE_CHANGED, not captured partially", async () => {
    const backend = new LocalProcessBackend({
      baseDir: mkdtempSync(join(tmpdir(), "myco-u-short-")),
    });
    const h = await backend.create({
      trialKey: "t:1",
      image: "myco-linux-desktop/1",
      network: "off",
      seed: [{ path: "doc.csv", bytes: Buffer.from("id,qty\nEMP-0001,42\n") }],
    });
    // Control: an unchanged file is captured whole.
    expect((await backend.capture(h, "doc.csv"))?.size).toBe(19);
    shrink.on = true;
    try {
      await expect(backend.capture(h, "doc.csv")).rejects.toMatchObject({
        code: "CAPTURE_CHANGED",
      });
    } finally {
      shrink.on = false;
    }
    await backend.destroy(h);
  });
});
