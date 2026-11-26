import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MARKER = "PLANTED_FAKE_MARKER";
/** A fake absolute host path (never exists); planted to prove paths do not reach the stream. */
export const FAKE_ABS_PATH = "/srv/planted-fake-host/operator/secret-vault/ground-truth.json";

export function tempDir(prefix = "myco-watch-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/**
 * One raw HTTP request (no URL normalisation, so `..` and `%2e` reach the server as sent).
 * `maxMs` cuts a streaming response (SSE) after that long.
 */
export function raw(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; maxMs?: number } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        };
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", finish);
        res.on("close", finish);
        if (opts.maxMs !== undefined)
          setTimeout(() => {
            finish();
            res.destroy();
          }, opts.maxMs);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** path -> size, mtime, mode and sha256 of every entry under `root` (symlinks not followed). */
export function treeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        out.set(path, `dir ${st.mode} ${st.mtimeMs}`);
        walk(path);
      } else if (st.isFile()) {
        const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
        out.set(path, `file ${st.size} ${st.mode} ${st.mtimeMs} ${sha}`);
      } else {
        out.set(path, `other ${st.mode} ${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

/** A 1x1 PNG. */
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
