/**
 * Live watch view: frame sources. A frame is one image of the agent's desktop.
 *
 * Two layouts, both operator-side and both read-only:
 *  - `per-run`: `<root>/<runId>/<image>` (a frame directory a harness or the mock demo fills);
 *  - `sealed`:  `<vaultRoot>/<runId>/captured/**` (the evidence images TIF-266's vault
 *    captured after the agent stopped; `captured/persisted/` is the oracle's input and is
 *    never listed, and nothing outside `captured/` is ever opened: not the seal, the ground
 *    truth, the fixtures or any manifest).
 *
 * Path safety: a frame is addressed by (listed run id, index), never by a name or a path from
 * the request. The run id must be one the operator listed and match the safe-id alphabet;
 * the index selects from the listing this module built itself. File names never leave this
 * module. Every component is `lstat`ed (no symlinks, regular files only) and the file is
 * opened `O_RDONLY | O_NOFOLLOW`, so a symlink swapped in cannot redirect the read.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { isSafeId } from "../gate/api.ts";

/**
 * File-backed frames are PNG only (round 2, D1). JPEG/GIF/WebP carry metadata this view does
 * not rebuild, and SVG is text that can carry anything; none of them is ever listed. SVG is
 * served only from the in-process demo renderer (`renderedFrameSource`).
 */
export const FRAME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
};
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_FRAMES_PER_RUN = 10_000;
const MAX_DEPTH = 4;

export interface Frame {
  readonly bytes: Buffer;
  readonly contentType: string;
  /**
   * Where the bytes came from: `file` (operator-side files, never trusted as they are) or
   * `rendered` (drawn in this process by `render-frame.ts`). Only `rendered` SVG is served.
   */
  readonly provenance: "file" | "rendered";
}

export interface FrameSource {
  /** How many frames the run has right now (0 for an unlisted or unknown run). */
  count(runId: string): number;
  /** Frame `index` of the run, or null. */
  read(runId: string, index: number): Frame | null;
}

export type FrameLayout = "per-run" | "sealed";

function typeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : FRAME_TYPES[name.slice(dot).toLowerCase()];
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Image files under `dir` (relative names, sorted), skipping symlinks and `skip` subtrees. */
function listImages(dir: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (out.length >= MAX_FRAMES_PER_RUN) return;
    let names: string[];
    try {
      names = readdirSync(rel === "" ? dir : join(dir, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (skip.has(childRel)) continue;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(join(dir, childRel));
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < MAX_DEPTH) walk(childRel, depth + 1);
      } else if (stat.isFile() && typeOf(name) !== undefined) {
        out.push(childRel);
        if (out.length >= MAX_FRAMES_PER_RUN) return;
      }
    }
  };
  walk("", 0);
  return out.sort();
}

/** Read a regular file, refusing a symlink at the last component (O_NOFOLLOW) or a non-file. */
export function readRegular(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FRAME_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < stat.size) {
      const got = readSync(fd, bytes, at, stat.size - at, at);
      if (got <= 0) break;
      at += got;
    }
    return at === stat.size ? bytes : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Join a listed relative name onto `dir`, re-checking every component: nothing may have
 * become a symlink since the listing. Null if any component is a symlink or is missing.
 */
export function resolveListed(dir: string, name: string): string | null {
  let path = dir;
  for (const segment of name.split("/")) {
    path = join(path, segment);
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  return path;
}

/**
 * Frames from a directory tree. `runs` is the operator's list; any other run id has no
 * frames. The listing is rebuilt on every call, so frames appear as they land.
 */
export function directoryFrameSource(
  root: string,
  layout: FrameLayout,
  runs: ReadonlySet<string>,
): FrameSource {
  const runDir = (runId: string): string | null => {
    if (!isSafeId(runId) || !runs.has(runId)) return null;
    if (!isDir(root) || !isDir(join(root, runId))) return null;
    if (layout === "per-run") return join(root, runId);
    const captured = join(root, runId, "captured");
    return isDir(captured) ? captured : null;
  };
  const skip: ReadonlySet<string> = new Set(layout === "sealed" ? ["persisted"] : []);
  const list = (runId: string): { dir: string; names: string[] } | null => {
    const dir = runDir(runId);
    return dir === null ? null : { dir, names: listImages(dir, skip) };
  };
  return {
    count(runId) {
      return list(runId)?.names.length ?? 0;
    },
    read(runId, index) {
      if (!Number.isInteger(index) || index < 0) return null;
      const listed = list(runId);
      const name = listed?.names[index];
      if (listed === null || name === undefined) return null;
      const path = resolveListed(listed.dir, name);
      const contentType = typeOf(name);
      const bytes = contentType === undefined || path === null ? null : readRegular(path);
      return bytes === null || contentType === undefined
        ? null
        : { bytes, contentType, provenance: "file" };
    },
  };
}

export interface RenderedFrameSource extends FrameSource {
  /** Add one frame drawn in this process (`render-frame.ts`) for a listed run. */
  push(runId: string, svg: string): void;
}

/**
 * Frames rendered in this process (the demo): held in memory, never read from disk, so the
 * only SVG the view serves is SVG it drew itself. Unlisted runs get nothing.
 */
export function renderedFrameSource(runs: ReadonlySet<string>): RenderedFrameSource {
  const frames = new Map<string, Buffer[]>();
  return {
    push(runId, svg) {
      if (!runs.has(runId)) return;
      const list = frames.get(runId) ?? [];
      if (list.length >= MAX_FRAMES_PER_RUN) return;
      list.push(Buffer.from(svg, "utf8"));
      frames.set(runId, list);
    },
    count(runId) {
      return runs.has(runId) ? (frames.get(runId)?.length ?? 0) : 0;
    },
    read(runId, index) {
      if (!runs.has(runId) || !Number.isInteger(index) || index < 0) return null;
      const bytes = frames.get(runId)?.[index];
      return bytes === undefined
        ? null
        : { bytes, contentType: "image/svg+xml", provenance: "rendered" };
    },
  };
}
