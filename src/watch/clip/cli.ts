/**
 * `myco clip` (spec #589 build PR B5, issue #666): export a MOCK-watermarked preview GIF of a
 * recorded run's frame span, and refuse to verify a clip that has no sidecar.
 *
 *   myco clip export --run <runId> --task <taskId> --from <i> --to <j> --decision-log <file>
 *                    (--frames <dir> | --sealed-capture <vaultRoot>) --out <path.gif>
 *                    [--width <px>] [--identity-file <file>] [--user-file <file>] [--json]
 *   myco clip verify <clip.gif> --sidecar <clip.myco.json> --decision-log <file> [--json]
 *
 * Export reads the run read-only (frames and manifest `O_RDONLY | O_NOFOLLOW`, through the
 * watch view's frame source and redaction) and writes exactly one file, `--out`, created with
 * `O_CREAT | O_EXCL | O_NOFOLLOW` (an existing path is refused). Every exported frame carries
 * the MOCK watermark and the band `MOCK · NOT EVIDENCE`; no flag turns it off, and no flag
 * marks a run real. The summary it prints is machine-marked `"mock": true`. Paths and identity
 * file contents are never printed. Refusals are codes only.
 *
 * Verify: a mock preview has no sidecar, so it is refused with CLIP_NO_SIDECAR (exit 1). This
 * PR accepts no sidecar at all (the evidence clip and its sidecar are build PR B6), so any
 * sidecar is refused with CLIP_SCHEMA. Nothing here ever exits 0 from verify.
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import type { Writable } from "node:stream";
import { isSafeId } from "../../gate/api.ts";
import { guardWithHost, readIdentityLines } from "../../proof/identity.ts";
import { directoryFrameSource, readRegular } from "../frames.ts";
import { MOCK_BAND } from "../run-trust.ts";
import { hostNeedles } from "../sanitize-frame.ts";
import { joinTimeline, readManifest } from "../timeline.ts";
import { type ClipCode, exportMockPreview } from "./mock-preview.ts";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 3;

export const CLIP_USAGE = `usage:
  myco clip export --run <runId> --task <taskId> --from <i> --to <j> --decision-log <file>
                   (--frames <dir> | --sealed-capture <vaultRoot>) --out <path.gif>
                   [--width <px>] [--identity-file <file>] [--user-file <file>] [--json]
  myco clip verify <clip.gif> --sidecar <clip.myco.json> --decision-log <file> [--json]

export writes one MOCK-watermarked preview GIF to --out (never overwritten) and nothing else.
verify refuses a clip without a sidecar (CLIP_NO_SIDECAR); a mock preview never has one.
exit: 0 exported, 1 refused (a CLIP_* code), ${EXIT_USAGE} usage
`;

/** Every flag `myco clip export` accepts. None marks a run real or drops the watermark. */
export const EXPORT_FLAGS: readonly string[] = [
  "--run",
  "--task",
  "--from",
  "--to",
  "--decision-log",
  "--frames",
  "--sealed-capture",
  "--out",
  "--width",
  "--identity-file",
  "--user-file",
];
export const VERIFY_FLAGS: readonly string[] = [
  "--sidecar",
  "--decision-log",
  "--expect-log-sha256",
];

class UsageError extends Error {}

function parseFlags(argv: readonly string[], allowed: readonly string[]) {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.includes(arg)) throw new UsageError(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    if (values.has(arg)) throw new UsageError(`${arg} given twice`);
    values.set(arg, value);
    i += 1;
  }
  return { values, positional, json };
}

const ORDINAL = /^(0|[1-9]\d{0,5})$/;

/** Create `path` exclusively and write `bytes`; false if it exists or cannot be created. */
function writeExclusive(path: string, bytes: Buffer): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch {
    return false;
  }
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    return true;
  } finally {
    closeSync(fd);
  }
}

function refuse(io: { stdout: Writable; stderr: Writable }, json: boolean, code: ClipCode): number {
  if (json) io.stdout.write(`${JSON.stringify({ ok: false, code })}\n`);
  else io.stderr.write(`myco clip: refused: ${code}\n`);
  return EXIT_REFUSED;
}

function runExport(argv: readonly string[], io: { stdout: Writable; stderr: Writable }): number {
  const { values, positional, json } = parseFlags(argv, EXPORT_FLAGS);
  if (positional.length > 0) throw new UsageError("export takes no positional argument");
  const need = (flag: string) => {
    const v = values.get(flag);
    if (v === undefined) throw new UsageError(`${flag} is required`);
    return v;
  };
  const runId = need("--run");
  const taskId = need("--task");
  if (!isSafeId(runId) || !isSafeId(taskId))
    throw new UsageError("--run and --task must be safe ids");
  const fromText = need("--from");
  const toText = need("--to");
  if (!ORDINAL.test(fromText) || !ORDINAL.test(toText))
    throw new UsageError("--from and --to are frame ordinals");
  const widthText = values.get("--width");
  if (widthText !== undefined && !/^\d{1,4}$/.test(widthText))
    throw new UsageError("--width is a pixel count");
  const logPath = need("--decision-log");
  const out = need("--out");
  const framesDir = values.get("--frames");
  const sealed = values.get("--sealed-capture");
  if ((framesDir === undefined) === (sealed === undefined))
    throw new UsageError("give --frames or --sealed-capture (exactly one)");
  const source = directoryFrameSource(
    (framesDir ?? sealed) as string,
    framesDir !== undefined ? "per-run" : "sealed",
    new Set([runId]),
  );
  const manifestPath = source.timelineFile?.(runId) ?? null;
  const join = joinTimeline({
    binding: { taskId, runId },
    listedRuns: new Set([runId]),
    manifest: manifestPath === null ? { kind: "absent" } : readManifest(manifestPath),
    frameCount: source.count(runId),
    frameBytes: (index) => source.read(runId, index)?.bytes ?? null,
    log: readRegular(logPath) ?? Buffer.alloc(0),
  });
  const guard = guardWithHost({
    names: [
      ...readIdentityLines(values.get("--identity-file")),
      ...readIdentityLines(values.get("--user-file")),
    ],
    homes: [],
  });
  const preview = exportMockPreview({
    runId,
    taskId,
    from: Number(fromText),
    to: Number(toText),
    join,
    frame: (index) => source.read(runId, index),
    needles: hostNeedles(),
    guard,
    ...(widthText === undefined ? {} : { width: Number(widthText) }),
  });
  if (!preview.ok) return refuse(io, json, preview.code);
  if (!writeExclusive(out, preview.gif)) {
    io.stderr.write("myco clip: refused: --out exists or cannot be created (nothing written)\n");
    return EXIT_REFUSED;
  }
  const summary = {
    schema: "myco.clip-export/1",
    ok: true,
    mock: true,
    watermark: MOCK_BAND,
    evidence: false,
    frames: preview.frames,
    width: preview.width,
    height: preview.height,
    bytes: preview.gif.length,
  };
  io.stdout.write(
    json
      ? `${JSON.stringify(summary)}\n`
      : `wrote a MOCK preview (not evidence): ${preview.frames} frame(s), ${preview.gif.length} bytes\n`,
  );
  return EXIT_OK;
}

function runVerify(argv: readonly string[], io: { stdout: Writable; stderr: Writable }): number {
  const { values, positional, json } = parseFlags(argv, VERIFY_FLAGS);
  if (positional.length !== 1) throw new UsageError("verify takes one clip path");
  const sidecar = values.get("--sidecar");
  if (sidecar === undefined || values.get("--decision-log") === undefined)
    throw new UsageError("--sidecar and --decision-log are required");
  // A mock preview has no sidecar: it is never evidence and never verifies.
  if (readRegular(sidecar) === null) return refuse(io, json, "CLIP_NO_SIDECAR");
  // No sidecar schema is accepted until the evidence clip lands (build PR B6).
  return refuse(io, json, "CLIP_SCHEMA");
}

export function clipMain(
  argv: readonly string[],
  io: { readonly stdout: Writable; readonly stderr: Writable },
): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout.write(CLIP_USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  try {
    if (command === "export") return runExport(rest, io);
    if (command === "verify") return runVerify(rest, io);
    throw new UsageError(`unknown command ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`myco clip: ${error.message}\n${CLIP_USAGE}`);
      return EXIT_USAGE;
    }
    io.stderr.write("myco clip: refused: CLIP_FRAME_REFUSED\n");
    return EXIT_REFUSED;
  }
}
