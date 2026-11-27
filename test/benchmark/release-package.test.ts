/**
 * Track G (#613, #612 N2): the release packager. Each claim of the PR is one block here:
 * allowlist and import closure, built from the commit not the working tree, datasets only
 * from a `dataset`/`ds` directory of plain text files, the leak scan (host paths, identity
 * strings incl. joined forms and single words, never echoing the match), the archive (plain
 * ustar, no extended headers, no owner names, deterministic), SHA-256 of every file, and the
 * grader reproduced from the archive alone by `scripts/benchmark-release-repro.sh`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReleaseArchive } from "../../src/benchmark/release/archive-check.ts";
import {
  type BuildResult,
  buildRelease,
  CODE_HOST_PATH_EXEMPT_LINES,
  type CommitReader,
  GENERATED,
  gitReader,
  graderClosure,
  identityEntries,
  RELEASE_ROOT,
  ReleaseRefusal,
  type ReproCase,
  readDataset,
  regradeFindings,
  repoFiles,
  scanFile,
  ustarArchive,
} from "../../src/benchmark/release/package.ts";
import { PLANTED_MARKER } from "../../src/dataset/hygiene.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const REPRO = join(ROOT, "scripts", "benchmark-release-repro.sh");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmp: string[] = [];
const newDir = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `release-${tag}-`));
  tmp.push(d);
  return d;
};
/** A planted absolute home path, joined at run time so this file never holds one (TIF-241). */
const homePath = (root: string, ...rest: string[]) => ["", root, "zelphine", ...rest].join("/");
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo holding exactly the allowlisted files of this repo's HEAD. */
function fixtureRepo(edit?: (dir: string) => void): string {
  const dir = newDir("repo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        GIT_AUTHOR_DATE: "2026-11-27T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-27T00:00:00Z",
      },
    });
  git("init", "-q");
  for (const f of repoFiles(gitReader(ROOT, "HEAD"))) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.bytes);
  }
  writeFileSync(join(dir, "NOT-ALLOWLISTED.md"), "never published\n");
  edit?.(dir);
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReleaseRefusal) return e.message;
    throw e;
  }
  throw new Error("expected a ReleaseRefusal");
}

interface TarEntry {
  name: string;
  header: Buffer;
  bytes: Buffer;
}
function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, n: number) =>
      h
        .subarray(a, a + n)
        .toString("ascii")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12), 8);
    const prefix = field(345, 155);
    const name = prefix === "" ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    out.push({ name, header: Buffer.from(h), bytes: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A ustar header block: name, typeflag, size and mode/uid/gid/owner fields as given. */
function header(
  name: string,
  type: string,
  size: number,
  o: { mode?: string; uid?: string; gid?: string; uname?: string; magic?: string } = {},
): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "ascii");
  h.write(`${o.mode ?? "0000644"}\0`, 100, "ascii");
  h.write(`${o.uid ?? "0000000"}\0`, 108, "ascii");
  h.write(`${o.gid ?? "0000000"}\0`, 116, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write(o.magic ?? "ustar\u000000", 257, 8, "ascii");
  if (o.uname !== undefined) h.write(o.uname, 265, 32, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}
const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512, 0)]);

/** `archive` with a pax `x` header carrying an xattr record put before its first entry. */
function withPaxXattr(archive: Buffer, type = "x"): Buffer {
  const body = " SCHILY.xattr.com.apple.provenance=AQAA\n";
  let len = body.length + 2;
  if (String(len).length + body.length !== len) len = String(len + 1).length + body.length;
  const record = Buffer.from(`${len}${body}`, "ascii");
  const pax = header(`${RELEASE_ROOT}/PaxHeaders/LICENSE`, type, record.length);
  return Buffer.concat([pax, padded(record), archive]);
}

let repo: string;
let outA: string;
let built: BuildResult;
let tree: string;
let tar: Buffer;
let entries: TarEntry[];

beforeAll(() => {
  repo = fixtureRepo();
  // A dirty working tree must not reach the bundle: it is built from the commit.
  writeFileSync(
    join(repo, "docs/benchmark/public/README.md"),
    `working-tree edit ${homePath("Users", "y")}\n`,
  );
  outA = join(newDir("out"), "a");
  built = buildRelease({ repoDir: repo, ref: "HEAD", outDir: outA });
  tree = join(outA, RELEASE_ROOT);
  tar = readFileSync(join(outA, built.archive));
  entries = readTar(tar);
}, 60_000);

describe("allowlist and grader closure", () => {
  it("publishes exactly the allowlisted repo files, the closure and the generated files", () => {
    const names = entries.map((e) => e.name.replace(`${RELEASE_ROOT}/`, ""));
    const repoPaths = names.filter(
      (n) => !n.startsWith(GENERATED.docsDir) && !Object.values(GENERATED).includes(n as never),
    );
    const allowed = (n: string) =>
      n === "LICENSE" ||
      [
        "docs/benchmark/public/README.md",
        "docs/benchmark/public/grading-protocol.md",
        "docs/benchmark/public/task-set-card.md",
      ].includes(n) ||
      n.startsWith("benchmark/false-completion/fc-v1/") ||
      [
        "scripts/benchmark-grade.ts",
        "scripts/benchmark-verify-bundle.ts",
        "schemas/benchmark-ledger.ts",
        "schemas/validate.ts",
        "src/benchmark/grade/grade.ts",
        "src/benchmark/grade/row.ts",
        "src/benchmark/grade/sheet.ts",
        "src/benchmark/grade/zip.ts",
      ].includes(n);
    expect(repoPaths.filter((n) => !allowed(n))).toEqual([]);
    expect(names).not.toContain("NOT-ALLOWLISTED.md");
    expect(names).not.toContain("docs/benchmark/public/reproduce-linux.md");
    expect(names).not.toContain("src/benchmark/grade/cross-app.ts");
    expect(names.filter((n) => n.startsWith("benchmark/false-completion/fc-v1/"))).toHaveLength(43);
  });

  it("takes every file from the commit, not the working tree", () => {
    const readme = entries.find((e) => e.name.endsWith("docs/benchmark/public/README.md"));
    expect(readme?.bytes.equals(readFileSync(join(ROOT, "docs/benchmark/public/README.md")))).toBe(
      true,
    );
    expect(built.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  const reader = (files: Record<string, string>): Pick<CommitReader, "list" | "read"> => ({
    list: (p) => (p in files ? [p] : []),
    read: (p) => new TextEncoder().encode(files[p] as string),
  });

  it("refuses a grader import outside the allowlisted trees", () => {
    const msg = refusal(() =>
      graderClosure(
        reader({
          "scripts/benchmark-grade.ts": `import { x } from "../src/gate/verdict.ts";\n`,
          "src/gate/verdict.ts": "export const x = 1;\n",
        }),
        ["scripts/benchmark-grade.ts"],
      ),
    );
    expect(msg).toContain("src/gate/verdict.ts: grader import outside the allowlisted trees");
  });

  it("refuses a package import, a dynamic import and require", () => {
    for (const src of [
      `import { z } from "zod";\n`,
      `const m = await import("./x.ts");\n`,
      `const m = require("./x.ts");\n`,
    ]) {
      const msg = refusal(() =>
        graderClosure(reader({ "scripts/benchmark-grade.ts": src }), [
          "scripts/benchmark-grade.ts",
        ]),
      );
      expect(msg).toMatch(/imports a package|dynamic import or require/);
    }
  });

  it("follows type-only imports and re-exports", () => {
    const files = graderClosure(
      reader({
        "scripts/a.ts": `import type { T } from "../schemas/t.ts";\nexport { u } from "../schemas/u.ts";\n`,
        "schemas/t.ts": "export type T = 1;\n",
        "schemas/u.ts": "export const u = 1;\n",
      }),
      ["scripts/a.ts"],
    );
    expect(files).toEqual(["schemas/t.ts", "schemas/u.ts", "scripts/a.ts"]);
  });

  it("refuses a symlink in an allowlisted tree of the commit", () => {
    const dir = fixtureRepo((d) =>
      symlinkSync("README.md", join(d, "benchmark/false-completion/fc-v1/link.md")),
    );
    const msg = refusal(() => repoFiles(gitReader(dir, "HEAD")));
    expect(msg).toContain("benchmark/false-completion/fc-v1/link.md: not a regular file");
  });
});

describe("leak scan", () => {
  it("refuses a committed host path, naming file, line and kind but not the text", () => {
    const dir = fixtureRepo((d) => {
      const p = join(d, "docs/benchmark/public/task-set-card.md");
      writeFileSync(
        p,
        `${readFileSync(p, "utf8")}\nsaved under ${homePath("Users", "runs", "x")}\n`,
      );
    });
    const msg = refusal(() =>
      buildRelease({ repoDir: dir, ref: "HEAD", outDir: join(newDir("o"), "x") }),
    );
    expect(msg).toMatch(/docs\/benchmark\/public\/task-set-card\.md:\d+ host-path/);
    expect(msg).not.toContain("zelphine");
  });

  const idFile = () => {
    const p = join(newDir("id"), "identities.txt");
    writeFileSync(p, "# configured identities\nQuintessa Vbramble\nzorblax-mbp\n");
    return p;
  };
  const scan = (text: string, path = "datasets/x/a.json") => {
    const hygiene = { identityFile: idFile() };
    const ids = [
      ["identity", "Quintessa Vbramble"],
      ["identity", "zorblax-mbp"],
    ] as const;
    return scanFile({ path, bytes: new TextEncoder().encode(text) }, ids, { hygiene });
  };

  it("refuses a configured identity, joined forms and single words included", () => {
    for (const text of [
      `{"who":"Quintessa Vbramble"}`,
      `{"who":"quintessa.vbramble"}`,
      `{"who":"QUINTESSA_VBRAMBLE"}`,
      `{"run":"vbramble2-trial"}`,
      `{"host":"zorblax-mbp.local"}`,
    ]) {
      const found = scan(text);
      expect(found, text).toEqual(["datasets/x/a.json:1 identity"]);
    }
    expect(scan(`{"ok":"fc-v1-001"}`)).toEqual([]);
  });

  it("hides a file name that leaks", () => {
    expect(scan("{}", "datasets/x/quintessa.json")).toEqual(["<path> identity (in the file name)"]);
  });

  it("exempts the listed grader lines from host-path only, only in .ts files", () => {
    const line = [...CODE_HOST_PATH_EXEMPT_LINES][4] as string;
    expect(scan(`  ${line}`, "scripts/x.ts")).toEqual([]);
    expect(scan(line, "datasets/x/a.json")).toEqual(["datasets/x/a.json:1 host-path"]);
    expect(scan(`${line} // quintessa`, "scripts/x.ts")).toContain("scripts/x.ts:1 identity");
  });

  it("never exempts an identity finding inside an unmodified exempt line", () => {
    const line = "return /[yYdD]/.test(stripped);";
    expect(CODE_HOST_PATH_EXEMPT_LINES.has(line)).toBe(true);
    const file = {
      path: "src/benchmark/grade/x.ts",
      bytes: new TextEncoder().encode(`    ${line}\n`),
    };
    // The line is exempt from host-path (no finding without an identity configured) ...
    expect(scanFile(file, [], { hygiene: { hostIdentity: false } })).toEqual([]);
    // ... but an identity string inside the very same, unedited line still refuses.
    expect(
      scanFile(file, [["identity", "stripped"]], { hygiene: { hostIdentity: false } }),
    ).toEqual(["src/benchmark/grade/x.ts:1 identity"]);
  });

  it("refuses secret-shaped strings, the canary, forbidden strings and this machine's names", () => {
    const secret = ["sk", "ant", "api03", "Zq7Xw2Lr9Tk4Vb8Nm1"].join("-");
    const machine = { user: "qorvanuser", host: "qorvanhost-mbp.local" };
    const hygiene = { identity: machine, forbiddenStrings: ["PROJECT-NOVA-9"] };
    const opts = { hygiene };
    const ids = identityEntries(opts);
    const one = (text: string) =>
      scanFile({ path: "datasets/x/a.json", bytes: new TextEncoder().encode(text) }, ids, opts);
    expect(one(`{"key":"${secret}"}`)).toContain("datasets/x/a.json:1 secret-shaped");
    expect(one(`{"note":"${PLANTED_MARKER}"}`)).toContain("datasets/x/a.json:1 planted-marker");
    expect(one(`{"tag":"PROJECT-NOVA-9"}`)).toContain("datasets/x/a.json:1 forbidden-string");
    expect(one(`{"by":"qorvanuser"}`)).toContain("datasets/x/a.json:1 username");
    expect(one(`{"on":"qorvanhost-mbp"}`)).toContain("datasets/x/a.json:1 hostname");
  });

  it("refuses the release when a dataset holds any of them, never echoing the text", () => {
    const d = join(newDir("leak2"), "dataset");
    mkdirSync(d);
    const secret = ["sk", "ant", "api03", "Zq7Xw2Lr9Tk4Vb8Nm1"].join("-");
    writeFileSync(join(d, "a.json"), `{"key":"${secret}"}\n`);
    writeFileSync(join(d, "b.json"), `{"note":"${PLANTED_MARKER}"}\n`);
    writeFileSync(join(d, "c.json"), `{"by":"qorvanuser"}\n`);
    writeFileSync(join(d, "d.json"), `{"on":"qorvanhost-mbp"}\n`);
    const out = join(newDir("o"), "x");
    const msg = refusal(() =>
      buildRelease({
        repoDir: repo,
        ref: "HEAD",
        outDir: out,
        datasets: [{ name: "leaky", dir: d }],
        scan: { hygiene: { identity: { user: "qorvanuser", host: "qorvanhost-mbp.local" } } },
      }),
    );
    expect(msg).toContain("datasets/leaky/a.json:1 secret-shaped");
    expect(msg).toContain("datasets/leaky/b.json:1 planted-marker");
    expect(msg).toContain("datasets/leaky/c.json:1 username");
    expect(msg).toContain("datasets/leaky/d.json:1 hostname");
    expect(msg).not.toMatch(/Zq7Xw2|qorvan|PLANTED/);
    expect(existsSync(out)).toBe(false);
  });

  it("scans the generated reproduce-expected.jsonl, release-manifest.json and SHA256SUMS", () => {
    // The applied document's hash appears only in what the build generates after grading:
    // the grade row (persistedSha256), the manifest and SHA256SUMS.
    const doc = `${GENERATED.docsDir}repro-fc-v1-001-applied.csv`;
    const digest = sha(readFileSync(join(tree, doc)));
    for (const f of entries.filter((e) => !e.name.endsWith(GENERATED.expected)))
      if (![GENERATED.manifest, GENERATED.sums].some((g) => f.name.endsWith(`/${g}`)))
        expect(f.bytes.toString("latin1").includes(digest), f.name).toBe(false);
    const out = join(newDir("o"), "x");
    const msg = refusal(() =>
      buildRelease({
        repoDir: repo,
        ref: "HEAD",
        outDir: out,
        scan: { hygiene: { forbiddenStrings: [digest] } },
      }),
    );
    expect(msg).toMatch(/reproduce-expected\.jsonl:1 forbidden-string/);
    expect(msg).toMatch(/release-manifest\.json:\d+ forbidden-string/);
    expect(msg).toMatch(/SHA256SUMS:\d+ forbidden-string/);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("every exempt line is still a line of the bundled grader (no stale exemption)", () => {
    const code = entries
      .filter((e) => e.name.endsWith(".ts"))
      .flatMap((e) =>
        e.bytes
          .toString("utf8")
          .split("\n")
          .map((l) => l.trim()),
      );
    for (const line of CODE_HOST_PATH_EXEMPT_LINES) expect(code, line).toContain(line);
  });
});

describe("datasets (#612 N2)", () => {
  const dataset = (parent: string, name = "dataset") => {
    const d = join(newDir(parent), "run-542", name);
    mkdirSync(join(d, "episodes"), { recursive: true });
    writeFileSync(join(d, "manifest.json"), `{"schema":"x","episodes":1}\n`);
    writeFileSync(join(d, "episodes", "e1.json"), `{"id":"h-${"a".repeat(60)}"}\n`);
    writeFileSync(join(dirname(d), "run.log"), `wrote ${homePath("Users", "myco", "run-542")}\n`);
    return d;
  };

  it("publishes a cleared dataset under datasets/<name>/ and never the run log beside it", () => {
    const out = join(newDir("o"), "x");
    const r = buildRelease({
      repoDir: repo,
      ref: "HEAD",
      outDir: out,
      datasets: [{ name: "episode-542", dir: dataset("ds") }],
    });
    expect(r.datasets).toEqual(["episode-542"]);
    const names = readTar(readFileSync(join(out, r.archive))).map((e) => e.name);
    expect(names).toContain(`${RELEASE_ROOT}/datasets/episode-542/episodes/e1.json`);
    expect(names).toContain(`${RELEASE_ROOT}/datasets/episode-542/manifest.json`);
    expect(names.some((n) => n.includes("run.log"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, RELEASE_ROOT, GENERATED.manifest), "utf8"));
    expect(manifest.datasets).toEqual(["episode-542"]);
    const want = sha(new TextEncoder().encode(`{"schema":"x","episodes":1}\n`));
    expect(manifest.files["datasets/episode-542/manifest.json"]).toBe(want);
    expect(readFileSync(join(out, RELEASE_ROOT, GENERATED.sums), "utf8")).toContain(
      `${want}  datasets/episode-542/manifest.json\n`,
    );
  }, 60_000);

  it("refuses a directory not named dataset or ds (a run directory with its logs)", () => {
    const d = dataset("ds");
    expect(refusal(() => readDataset("episode-542", dirname(d)))).toContain(
      "datasets/episode-542: the directory must be named dataset or ds",
    );
    expect(readDataset("c531", dataset("ds2", "ds")).length).toBe(2);
  });

  it("refuses symlinks, binaries, hidden files and a bad name, all at once", () => {
    const d = dataset("bad");
    symlinkSync(join(d, "manifest.json"), join(d, "link.json"));
    writeFileSync(join(d, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    writeFileSync(join(d, ".DS_Store"), "x");
    writeFileSync(join(d, "._manifest.json"), "x");
    const msg = refusal(() => readDataset("Bad Name", d));
    expect(msg).toContain("dataset name must match");
    expect(msg).toContain("datasets/<name>/link.json: not a regular file");
    expect(msg).toContain("datasets/<name>/blob.bin: not UTF-8 text");
    expect(msg.match(/hidden or unsupported file name/g)).toHaveLength(2);
  });

  it("refuses a dataset holding a host path or a configured identity", () => {
    const d = dataset("leak");
    writeFileSync(join(d, "episodes", "e2.json"), `{"cwd":"${homePath("home", "x")}"}\n`);
    writeFileSync(join(d, "episodes", "e3.json"), `{"by":"Quintessa.Vbramble"}\n`);
    const ids = join(newDir("id"), "ids.txt");
    writeFileSync(ids, "Quintessa Vbramble\n");
    const msg = refusal(() =>
      buildRelease({
        repoDir: repo,
        ref: "HEAD",
        outDir: join(newDir("o"), "x"),
        datasets: [{ name: "episode-542", dir: d }],
        scan: { hygiene: { identityFile: ids } },
      }),
    );
    expect(msg).toContain("datasets/episode-542/episodes/e2.json:1 host-path");
    expect(msg).toContain("datasets/episode-542/episodes/e3.json:1 identity");
    expect(msg).not.toMatch(/zelphine|Quintessa|Vbramble/);
  });
});

describe("archive", () => {
  it("is plain ustar: regular files only, mode 0644, uid/gid 0, no owner names, no ext headers", () => {
    expect(entries.length).toBe(built.fileCount);
    for (const e of entries) {
      const h = e.header;
      expect(String.fromCharCode(h[156] as number), e.name).toBe("0");
      expect(h.subarray(100, 107).toString("ascii")).toBe("0000644");
      expect(h.subarray(108, 115).toString("ascii")).toBe("0000000");
      expect(h.subarray(116, 123).toString("ascii")).toBe("0000000");
      expect(
        h.subarray(265, 329).every((b) => b === 0),
        `${e.name} owner names`,
      ).toBe(true);
      expect(h.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    }
    expect(tar.length % 10240).toBe(0);
  });

  it("GNU or BSD tar reads it back: same names, 0/0 owners, same bytes", () => {
    const list = execFileSync("tar", ["-tvf", join(outA, built.archive)])
      .toString("utf8")
      .trim()
      .split("\n");
    expect(list).toHaveLength(entries.length);
    // GNU tar: `-rw-r--r-- 0/0 ...`; bsdtar: `-rw-r--r--  0 0 0 ...` (links, uid, gid).
    for (const line of list) expect(line).toMatch(/^-rw-r--r-- +(0\/0|\d+ +0 +0) /);
    const x = newDir("x");
    execFileSync("tar", ["-xf", join(outA, built.archive), "-C", x]);
    for (const e of entries)
      expect(readFileSync(join(x, e.name)).equals(e.bytes), e.name).toBe(true);
  });

  it("is byte-identical when built again from the same commit", () => {
    const outB = join(newDir("out"), "b");
    const again = buildRelease({ repoDir: repo, ref: "HEAD", outDir: outB });
    expect(readFileSync(join(outB, again.archive)).equals(tar)).toBe(true);
    expect(again.archiveSha256).toBe(built.archiveSha256);
    expect(readFileSync(join(outB, `${again.archive}.sha256`), "utf8")).toBe(
      `${built.archiveSha256}  ${built.archive}\n`,
    );
  }, 60_000);

  it("stamps every entry with the commit's committer time as its mtime", () => {
    const ct = Number(execFileSync("git", ["-C", repo, "show", "-s", "--format=%ct", "HEAD"]));
    expect(ct).toBe(Date.parse("2026-11-27T00:00:00Z") / 1000);
    for (const e of entries) {
      const mtime = Number.parseInt(e.header.subarray(136, 147).toString("ascii"), 8);
      expect(mtime, e.name).toBe(ct);
    }
  });

  it("splits a long path into ustar prefix and name, and refuses one that cannot fit", () => {
    const long = `${"d".repeat(120)}/${"f".repeat(90)}.csv`;
    const [e] = readTar(ustarArchive("r", [{ path: long, bytes: new Uint8Array([1]) }], 0));
    expect(e?.name).toBe(`r/${long}`);
    expect(() =>
      ustarArchive("r", [{ path: "f".repeat(120), bytes: new Uint8Array() }], 0),
    ).toThrow(ReleaseRefusal);
  });
});

describe("raw-header archive check (checkReleaseArchive)", () => {
  const file = (path: string, bytes: Buffer, o: Parameters<typeof header>[3] = {}) =>
    Buffer.concat([header(`${RELEASE_ROOT}/${path}`, "0", bytes.length, o), padded(bytes)]);
  /** One file `a.txt` and SHA256SUMS listing it, with `extra` blocks before them. */
  const archive = (extra: Buffer[] = [], o: Parameters<typeof header>[3] = {}) => {
    const a = Buffer.from("a\n");
    const sums = Buffer.from(`${sha(a)}  a.txt\n`);
    return Buffer.concat([
      ...extra,
      file("a.txt", a, o),
      file("SHA256SUMS", sums),
      Buffer.alloc(1024, 0),
    ]);
  };

  it("passes the built archive and a minimal clean one", () => {
    expect(checkReleaseArchive(tar, RELEASE_ROOT)).toEqual([]);
    expect(checkReleaseArchive(archive(), RELEASE_ROOT)).toEqual([]);
  });

  it("refuses every non-regular typeflag: pax x/g, GNU L/K, directory, links", () => {
    for (const type of ["x", "g", "L", "K", "5", "1", "2", "\0"]) {
      const extra = header(`${RELEASE_ROOT}/meta`, type, 0);
      const found = checkReleaseArchive(archive([extra]), RELEASE_ROOT);
      expect(found, JSON.stringify(type)).toContain(
        `entry 1: typeflag ${JSON.stringify(type)} is not a regular file`,
      );
    }
    expect(checkReleaseArchive(withPaxXattr(tar, "g"), RELEASE_ROOT)).toContain(
      'entry 1: typeflag "g" is not a regular file',
    );
  });

  it("refuses a mode, uid or owner name other than the release's", () => {
    expect(checkReleaseArchive(archive([], { mode: "0000755" }), RELEASE_ROOT)).toContain(
      "entry 1: mode is not 0644",
    );
    expect(checkReleaseArchive(archive([], { uid: "0000765" }), RELEASE_ROOT)).toContain(
      "entry 1: uid is not 0",
    );
    expect(checkReleaseArchive(archive([], { gid: "0000024" }), RELEASE_ROOT)).toContain(
      "entry 1: gid is not 0",
    );
    expect(checkReleaseArchive(archive([], { uname: "someone" }), RELEASE_ROOT)).toContain(
      "entry 1: has an owner or group name",
    );
    // Old GNU format (`ustar  \0` magic, what `tar --format=gnu` writes) is not plain ustar.
    expect(checkReleaseArchive(archive([], { magic: "ustar  \0" }), RELEASE_ROOT)).toContain(
      "entry 1: not a plain ustar header",
    );
  });

  it("refuses a .. path and a duplicate path", () => {
    const up = header(`${RELEASE_ROOT}/../evil`, "0", 0);
    expect(checkReleaseArchive(archive([up]), RELEASE_ROOT)).toContain(
      `entry 1: path outside ${RELEASE_ROOT}/`,
    );
    const a = Buffer.from("a\n");
    const twice = Buffer.concat([
      file("a.txt", a),
      file("a.txt", a),
      file("SHA256SUMS", Buffer.from(`${sha(a)}  a.txt\n`)),
      Buffer.alloc(1024, 0),
    ]);
    expect(checkReleaseArchive(twice, RELEASE_ROOT)).toEqual(["entry 2: duplicate path"]);
  });

  it("refuses a bad checksum, a path outside the root and data after the end", () => {
    const bad = archive();
    bad.write("b", 0, "ascii");
    expect(checkReleaseArchive(bad, RELEASE_ROOT)).toContain("entry 1: bad header checksum");
    const outside = Buffer.concat([padded(header("elsewhere/x", "0", 0)), archive()]);
    expect(checkReleaseArchive(outside, RELEASE_ROOT)).toContain(
      `entry 1: path outside ${RELEASE_ROOT}/`,
    );
    expect(
      checkReleaseArchive(Buffer.concat([archive(), Buffer.from("junk")]), RELEASE_ROOT),
    ).toContain("archive has data after the end-of-archive block");
  });

  it("requires the entries to equal the files SHA256SUMS lists", () => {
    const extra = file("b.txt", Buffer.from("b\n"));
    expect(checkReleaseArchive(archive([extra]), RELEASE_ROOT)).toEqual([
      "b.txt: in the archive but not in SHA256SUMS",
    ]);
    const a = Buffer.from("a\n");
    const missing = Buffer.concat([
      file("a.txt", a),
      file("SHA256SUMS", Buffer.from(`${sha(a)}  a.txt\n${sha(a)}  gone.txt\n`)),
      Buffer.alloc(1024, 0),
    ]);
    expect(checkReleaseArchive(missing, RELEASE_ROOT)).toEqual([
      "gone.txt: in SHA256SUMS but not in the archive",
    ]);
    const changed = Buffer.concat([
      file("a.txt", Buffer.from("A\n")),
      file("SHA256SUMS", Buffer.from(`${sha(a)}  a.txt\n`)),
      Buffer.alloc(1024, 0),
    ]);
    expect(checkReleaseArchive(changed, RELEASE_ROOT)).toEqual([
      "a.txt: does not match SHA256SUMS",
    ]);
    const noSums = Buffer.concat([file("a.txt", a), Buffer.alloc(1024, 0)]);
    expect(checkReleaseArchive(noSums, RELEASE_ROOT)).toEqual(["no SHA256SUMS entry"]);
  });
});

describe("SHA-256 of every file", () => {
  it("SHA256SUMS lists every other file of the archive with its hash", () => {
    const sums = readFileSync(join(tree, GENERATED.sums), "utf8").trim().split("\n");
    const listed = new Map(sums.map((l) => [l.slice(66), l.slice(0, 64)]));
    const files = entries.map((e) => ({ path: e.name.replace(`${RELEASE_ROOT}/`, ""), e }));
    expect(listed.size).toBe(files.length - 1);
    for (const { path, e } of files) {
      if (path === GENERATED.sums) continue;
      expect(listed.get(path), path).toBe(sha(e.bytes));
    }
  });

  it("release-manifest.json records every file but itself and SHA256SUMS, and the commit", () => {
    const m = JSON.parse(readFileSync(join(tree, GENERATED.manifest), "utf8"));
    expect(m.schema).toBe("myco.benchmark.release/1");
    expect(m.sourceCommit).toBe(built.commit);
    expect(Object.keys(m.files)).toHaveLength(entries.length - 2);
    expect(JSON.stringify(m)).not.toMatch(/rank|leaderboard|score/i);
  });
});

describe("grader reproduced from the archive alone", () => {
  it("covers every task: 90 pass, 100 fail, 5 ungradable, as constructed", () => {
    const rows = readFileSync(join(tree, GENERATED.expected), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { trialKey: string; status: string });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    expect([count("pass"), count("fail"), count("ungradable")]).toEqual([90, 100, 5]);
    for (const r of rows) {
      const want = r.trialKey.endsWith("-applied")
        ? "pass"
        : r.trialKey.endsWith("-missing")
          ? "ungradable"
          : "fail";
      expect(r.status, r.trialKey).toBe(want);
    }
  });

  describe("refuses unless the grader reproduces the construction (regradeFindings)", () => {
    const VERSION = "false-completion-grader/1";
    const c = (trialKey: string, expectStatus: ReproCase["expectStatus"]): ReproCase => ({
      request: { trialKey },
      expectStatus,
      document: null,
    });
    const cases = [c("k1", "pass"), c("k2", "fail"), c("k3", "ungradable")];
    const rows = (over: Array<Record<string, unknown>> = []) =>
      cases
        .map((x, i) => ({
          trialKey: x.request.trialKey,
          status: x.expectStatus,
          graderVersion: VERSION,
          ...over[i],
        }))
        .map((r) => `${JSON.stringify(r)}\n`)
        .join("");

    it("passes rows that match", () => {
      expect(regradeFindings(cases, rows(), VERSION)).toEqual([]);
    });

    it("refuses a status other than the constructed one", () => {
      expect(regradeFindings(cases, rows([{}, { status: "pass" }]), VERSION)).toEqual([
        "k2: grader gave pass (construction: fail)",
      ]);
      expect(regradeFindings(cases, rows([{ status: "ungradable" }]), VERSION)).toEqual([
        "k1: grader gave ungradable (construction: pass)",
      ]);
    });

    it("refuses a grader version other than the task set's", () => {
      expect(
        regradeFindings(
          cases,
          rows([{}, {}, { graderVersion: "false-completion-grader/2" }]),
          VERSION,
        ),
      ).toEqual(["k3: grader version differs from the task set's"]);
    });

    it("refuses a missing, extra or reordered row", () => {
      const lines = rows().split("\n");
      expect(regradeFindings(cases, lines.slice(0, 2).join("\n"), VERSION)).toEqual([
        "grader wrote 2 rows for 3 requests",
        "k3: no grade row in request order",
      ]);
      expect(regradeFindings(cases, `${rows()}${lines[0]}\n`, VERSION)).toEqual([
        "grader wrote 4 rows for 3 requests",
      ]);
      const swapped = [lines[1], lines[0], lines[2]].join("\n");
      expect(regradeFindings(cases, swapped, VERSION)).toEqual([
        "k1: no grade row in request order",
        "k2: no grade row in request order",
      ]);
    });

    it("a build whose bundled grader reports another version is refused, outDir untouched", () => {
      const dir = fixtureRepo((d) => {
        const p = join(d, "src/benchmark/grade/grade.ts");
        const src = readFileSync(p, "utf8");
        expect(src).toContain(`"${VERSION}"`);
        writeFileSync(p, src.replace(`"${VERSION}"`, '"false-completion-grader/9"'));
      });
      const out = join(newDir("o"), "x");
      const msg = refusal(() => buildRelease({ repoDir: dir, ref: "HEAD", outDir: out }));
      expect(msg).toContain("repro-fc-v1-001-applied: grader version differs from the task set's");
      expect(existsSync(out)).toBe(false);
    }, 60_000);
  });

  it("the repro script exits 0 on the archive", () => {
    const r = spawnSync("bash", [REPRO, join(outA, built.archive)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("release reproduces: 195 grade rows identical");
  }, 60_000);

  it("the repro script refuses an archive whose entry carries an owner name", () => {
    const bad = Buffer.from(tar);
    bad.write("someone", 265, "ascii");
    bad.write("        ", 148, "ascii");
    let sum = 0;
    for (const b of bad.subarray(0, 512)) sum += b;
    bad.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const p = join(newDir("t"), "owned.tar");
    writeFileSync(p, bad);
    const r = spawnSync("bash", [REPRO, p], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("entry 1: has an owner or group name");
    expect(r.stdout).not.toContain("release reproduces");
  });

  it("the repro script refuses a pax xattr header that tar -tv does not show (#612 N2)", () => {
    // `com.apple.provenance` as GNU tar writes it on a Mac checkout: a typeflag-`x` header
    // before the file. Owner fields 0/0, mode 0644, so a listing looks clean.
    const p = join(newDir("t"), "pax.tar");
    writeFileSync(p, withPaxXattr(tar));
    const listing = spawnSync("tar", ["-tvf", p], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    for (const line of listing.stdout.trim().split("\n"))
      expect(line).toMatch(/^-rw-r--r-- +(0\/0|\d+ +0 +0) /);
    const r = spawnSync("bash", [REPRO, p], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('entry 1: typeflag "x" is not a regular file');
    expect(r.stdout).not.toContain("release reproduces");
  });

  it("the repro script refuses an archive entry SHA256SUMS does not list", () => {
    const files = entries.map((e) => ({
      path: e.name.replace(`${RELEASE_ROOT}/`, ""),
      bytes: new Uint8Array(e.bytes),
    }));
    files.push({ path: "scripts/unlisted-extra.ts", bytes: new TextEncoder().encode("x;\n") });
    const p = join(newDir("t"), "extra.tar");
    writeFileSync(p, ustarArchive(RELEASE_ROOT, files, 0));
    const r = spawnSync("bash", [REPRO, p], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scripts/unlisted-extra.ts: in the archive but not in SHA256SUMS");
    expect(r.stdout).not.toContain("release reproduces");
  });

  it("the repro script runs the bundled verifier (a task-set file re-summed still fails)", () => {
    // SHA256SUMS rewritten to match, the grader never reads the task README: only the
    // bundled verifier, checking the task set against its own manifest, can catch it.
    const r = rebuilt("benchmark/false-completion/fc-v1/README.md", (s) => `${s}x\n`, true);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("README.md");
    expect(r.stdout).not.toContain("release reproduces");
  }, 60_000);

  /** The archive rebuilt with one file changed; `resum` also rewrites its SHA256SUMS line. */
  const rebuilt = (suffix: string, change: (s: string) => string, resum: boolean) => {
    const files = entries.map((e) => ({
      path: e.name.replace(`${RELEASE_ROOT}/`, ""),
      bytes: new Uint8Array(e.bytes),
    }));
    const target = files.find((f) => f.path === suffix) as { path: string; bytes: Uint8Array };
    const before = sha(target.bytes);
    target.bytes = new TextEncoder().encode(change(new TextDecoder().decode(target.bytes)));
    expect(sha(target.bytes)).not.toBe(before);
    if (resum) {
      const sums = files.find((f) => f.path === GENERATED.sums) as { bytes: Uint8Array };
      sums.bytes = new TextEncoder().encode(
        new TextDecoder().decode(sums.bytes).replace(before, sha(target.bytes)),
      );
    }
    const p = join(newDir("t"), "bad.tar");
    writeFileSync(p, ustarArchive(RELEASE_ROOT, files, 0));
    return spawnSync("bash", [REPRO, p], { encoding: "utf8" });
  };

  it("the repro script fails when a file no longer matches SHA256SUMS", () => {
    const r = rebuilt("RELEASE.md", (s) => `${s}tampered\n`, false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("release reproduces");
  }, 60_000);

  it("the repro script fails when the regraded rows differ from the expected rows", () => {
    // SHA256SUMS rewritten to match, so only the grader comparison can catch it.
    const r = rebuilt(
      GENERATED.expected,
      (s) => s.replace('"status":"pass"', '"status":"fail"'),
      true,
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("release reproduces");
  }, 60_000);
});
