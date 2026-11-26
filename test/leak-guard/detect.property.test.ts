/**
 * Property tests for the shared leak detector (TIF-98, part 1). A seeded generator builds
 * arbitrary leak strings for every listed form, wraps each in arbitrary context and an
 * arbitrary encoding, and the detector must flag every one with the right class. A second
 * generator builds safe look-alikes (relative paths, web URLs, placeholders) that must stay
 * clean, so the detector cannot pass by flagging everything.
 *
 * No real identity is used: every account, host and key is generated here. Key-shaped
 * strings are assembled at runtime so no key-shaped literal is committed (gitleaks).
 */
import { describe, expect, it } from "vitest";
import {
  classesIn,
  type DetectOptions,
  type Identity,
  type LeakClass,
  scanText,
} from "../../src/leak-guard/detect.ts";

const RUNS = 400;

/** mulberry32: a small deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  const str = (alphabet: string, min: number, max: number) => {
    const n = min + int(max - min + 1);
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[int(alphabet.length)];
    return s;
  };
  return { next, int, pick, str };
}
type Rng = ReturnType<typeof rng>;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = `${LOWER}${LOWER.toUpperCase()}0123456789`;
const UNICODE = "éöñçøåßЖжλ李ü";
const NOBODY: Identity = { users: [], hosts: [], paths: [] };
/** Planted paths are assembled at runtime so this file holds no home-path literal. */
const posix = (...parts: string[]) => ["", ...parts].join("/");
const win = (...parts: string[]) => ["C:", ...parts].join("\\");
/** Generated names are prefixed `zq` so they never equal an allowlisted or generic name. */
const zq = (r: Rng, extra = "") => `zq${r.str(ALNUM + extra, 2, 10)}`;

/** An arbitrary account segment: ASCII, Unicode, dotted, dashed, spaced or 8.3-shortened. */
function account(r: Rng): string {
  switch (r.int(6)) {
    case 0:
      return zq(r);
    case 1:
      return `${zq(r)}${r.str(UNICODE, 1, 3)}`;
    case 2:
      return `${zq(r)}.${r.str(LOWER, 1, 6)}`;
    case 3:
      return `${zq(r)} ${r.pick(["Doe", "van Dijk", "O-Neil", r.str(LOWER, 2, 8)])}`;
    case 4:
      return `${zq(r).toUpperCase().slice(0, 6)}~${1 + r.int(9)}`;
    default:
      return `${zq(r)}-${r.str(ALNUM, 1, 5)}_${r.int(99)}`;
  }
}

const drive = (r: Rng) => r.pick(["C", "D", "c", "Z"]);
const users = (r: Rng) => r.pick(["Users", "users", "USERS"]);

/** Every listed home-path form, raw (before encoding). */
const HOME_FORMS: ReadonlyArray<[string, (r: Rng, a: string) => string]> = [
  ["posix /Users", (_r, a) => `/Users/${a}`],
  ["posix /home", (_r, a) => `/home/${a}`],
  ["posix /var/home", (_r, a) => `/var/home/${a}`],
  ["windows drive", (r, a) => `${drive(r)}:\\${users(r)}\\${a}`],
  ["windows forward slashes", (r, a) => `${drive(r)}:/${users(r)}/${a}`],
  ["mixed separators", (r, a) => `${drive(r)}:\\${users(r)}/${a}`],
  ["doubled backslashes", (r, a) => `${drive(r)}:\\\\${users(r)}\\\\${a}`],
  ["Documents and Settings", (r, a) => `${drive(r)}:\\Documents and Settings\\${a}`],
  ["8.3 DOCUME~1", (r, a) => `${drive(r)}:\\DOCUME~1\\${a}`],
  ["UNC admin share", (r, a) => `\\\\${r.str(LOWER, 3, 8)}\\c$\\${users(r)}\\${a}`],
  ["UNC share", (r, a) => `\\\\${r.str(LOWER, 3, 8)}\\share\\${users(r)}\\${a}`],
  ["extended-length \\\\?\\", (r, a) => `\\\\?\\${drive(r)}:\\${users(r)}\\${a}`],
  ["extended UNC \\\\?\\UNC", (r, a) => `\\\\?\\UNC\\srv\\share\\${users(r)}\\${a}`],
  ["file URL posix", (_r, a) => `file:///Users/${a}`],
  ["file URL windows", (r, a) => `file:///${drive(r)}:/${users(r)}/${a}`],
];

const TAILS = ["", "/", "\\", "/Documents/run.log", "\\AppData\\Local\\x.json", "/Library/a b"];

/** Encodings a writer, logger or template might apply. Each is decoded by the detector. */
const ENCODINGS: ReadonlyArray<[string, (s: string) => string]> = [
  ["raw", (s) => s],
  ["json", (s) => JSON.stringify(s).slice(1, -1)],
  ["json escaped slash", (s) => JSON.stringify(s).slice(1, -1).replaceAll("/", "\\/")],
  ["double json", (s) => JSON.stringify(JSON.stringify(s)).slice(1, -1)],
  ["url component", (s) => encodeURIComponent(s)],
  ["url (spaces only)", (s) => s.replaceAll(" ", "%20")],
  ["html named", (s) => s.replaceAll("/", "&sol;").replaceAll("\\", "&bsol;")],
  ["html decimal", (s) => s.replaceAll("/", "&#47;").replaceAll("\\", "&#92;")],
  ["html hex", (s) => s.replaceAll("/", "&#x2F;").replaceAll("\\", "&#x5c;")],
  [
    "json unicode separators",
    (s) => s.replaceAll("/", "\\u002f").replaceAll("\\", "\\u005c").replaceAll("\\u005cu", "\\u"),
  ],
  ["zero-width split", (s) => s.replace(/([A-Za-z])/, "$1\u200b")],
];

const CONTEXTS: ReadonlyArray<(s: string) => string> = [
  (s) => s,
  (s) => `"${s}"`,
  (s) => `'${s}'`,
  (s) => `path=${s}`,
  (s) => `{"cwd":"${s}","ok":true}`,
  (s) => `<td>${s}</td>`,
  (s) => `error: cannot open ${s}\nnext line`,
  (s) => `(${s})`,
  (s) => `\`${s}\``,
];

function check(
  r: Rng,
  form: string,
  raw: string,
  want: LeakClass,
  opts: DetectOptions,
  failures: string[],
) {
  const [encName, enc] = r.pick(ENCODINGS);
  const text = r.pick(CONTEXTS)(enc(raw));
  if (!classesIn(text, opts).includes(want)) failures.push(`${form} / ${encName}: ${text}`);
}

describe("leak detector: every listed form is caught under arbitrary encodings (property)", () => {
  for (const [name, make] of HOME_FORMS) {
    it(`home-path: ${name}`, () => {
      const r = rng(name.length * 7919);
      const failures: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const raw = make(r, account(r)) + r.pick(TAILS);
        check(r, name, raw, "home-path", { identity: NOBODY }, failures);
      }
      // Generated values only (never a real one), so printing a failing case is safe here.
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }

  it("home-path: every form x every encoding x every context, exhaustively (one account each)", () => {
    const r = rng(42);
    const misses: string[] = [];
    for (const [form, make] of HOME_FORMS)
      for (const [encName, enc] of ENCODINGS)
        for (const ctx of CONTEXTS) {
          const text = ctx(enc(make(r, account(r))));
          if (!classesIn(text, { identity: NOBODY }).includes("home-path"))
            misses.push(`${form} / ${encName}: ${text}`);
        }
    expect(misses.slice(0, 5)).toEqual([]);
  });

  it("home-path: this machine's own home and repo paths are caught even without a home root", () => {
    const r = rng(7);
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const p = `/${r.str(LOWER, 3, 8)}/${zq(r)}/${r.str(LOWER, 2, 8)}`;
      check(
        r,
        "machine path",
        `${p}/x`,
        "home-path",
        { identity: { ...NOBODY, paths: [p] } },
        failures,
      );
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("username: a planted account name as a word, in any context and encoding", () => {
    const r = rng(11);
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const u = zq(r, "._-").replace(/[._-]+$/, "x");
      const raw = r.pick([
        `owner ${u}`,
        `${u}@${r.str(LOWER, 3, 8)}`,
        `"user":"${u}"`,
        `/opt/${u}/bin`,
        `by ${u}.`,
        `${u}`,
      ]);
      check(r, "username", raw, "username", { identity: { ...NOBODY, users: [u] } }, failures);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("hostname: a planted host name (any case, any domain) and the generic Mac shapes", () => {
    const r = rng(13);
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const h = `${zq(r)}-${r.str(LOWER, 2, 6)}`;
      const raw = r.pick([`ssh ${h}`, `${h}.local`, `${h.toUpperCase()}.lan`, `host=${h}`]);
      check(
        r,
        "hostname",
        raw,
        "hostname",
        { identity: { ...NOBODY, hosts: [`${h}.example`] } },
        failures,
      );
      const mac = `${zq(r)}${r.pick(["", "s"])}-${r.pick(["MacBook", "MacBook-Pro", "MacBook-Air", "iMac", "Mac-mini", "Mac-Studio"])}`;
      check(
        r,
        "mac host",
        r.pick([mac, `${mac}.local`, `on ${mac}:`]),
        "hostname",
        { identity: NOBODY },
        failures,
      );
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("key-shaped: every provider prefix, private-key header and JWT", () => {
    const r = rng(17);
    const B64 = `${ALNUM}_-`;
    const j = (...p: string[]) => p.join("");
    const shapes: ReadonlyArray<[string, () => string]> = [
      ["anthropic", () => j("sk", "-ant-", "api03-", r.str(B64, 20, 40))],
      ["openai", () => j("sk", "-", r.pick(["", "proj-"]), r.str(ALNUM, 24, 48))],
      ["stripe", () => j("sk", "_", r.pick(["live", "test"]), "_", r.str(ALNUM, 12, 30))],
      ["github", () => j("gh", r.pick(["p", "o", "u", "s", "r"]), "_", r.str(ALNUM, 30, 40))],
      ["github pat", () => j("github", "_pat_", r.str(`${ALNUM}_`, 30, 60))],
      ["gitlab", () => j("gl", "pat-", r.str(B64, 20, 26))],
      ["aws", () => j("AK", "IA", r.str("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16, 16))],
      ["google", () => j("AI", "za", r.str(B64, 35, 35))],
      ["slack", () => j("xo", "x", r.pick(["b", "p", "a"]), "-", r.str(`${ALNUM}-`, 12, 40))],
      [
        "private key",
        () => j("-----BEGIN ", r.pick(["", "RSA ", "OPENSSH ", "EC "]), "PRI", "VATE KEY-----"),
      ],
      [
        "jwt",
        () =>
          j("ey", "J", r.str(B64, 12, 30), ".ey", "J", r.str(B64, 12, 30), ".", r.str(B64, 10, 30)),
      ],
    ];
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const [name, make] = r.pick(shapes);
      const opts = { identity: NOBODY };
      const [encName, enc] = r.pick(ENCODINGS.filter(([n]) => !n.startsWith("zero-width")));
      const text = r.pick(CONTEXTS)(enc(make()));
      // A generated key is not a real secret, but it is key-shaped: report the shape only.
      if (!classesIn(text, opts).includes("key-shaped")) failures.push(`${name} / ${encName}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe("leak detector: safe look-alikes stay clean (no pass-by-flagging-everything)", () => {
  it("relative paths, web URLs, placeholders and env spellings are not home paths", () => {
    const r = rng(23);
    const safe = (a: string) => [
      `docs/home/${a}`,
      `my-home/${a}`,
      `src/users/${a}.ts`,
      `https://example.com/home/${a}`,
      `https://github.com/Users/${a}`,
      "/Users/<you>/Projects",
      "/home/$USER/x",
      ["", "home", "$", "{USER}", "x"].join("/").replace("$/", "$"),
      "C:\\Users\\%USERNAME%\\x",
      "/Users/.../x",
      "/Users/…/x",
      "/home/",
      "~/Projects/x",
      "$HOME/VMs/x",
      "the Home/End keys",
    ];
    const flagged: string[] = [];
    for (let i = 0; i < 50; i++)
      for (const s of safe(r.str(LOWER, 2, 8)))
        if (classesIn(s, { identity: NOBODY }).includes("home-path")) flagged.push(s);
    expect(flagged).toEqual([]);
  });

  it("a planted name glued inside a longer word is not that account (word boundaries)", () => {
    const opts = { identity: { ...NOBODY, users: ["zqalice"], hosts: ["zqhost"] } };
    expect(classesIn("xzqalicey and zqhostname", opts)).toEqual([]);
    expect(classesIn("by zqalice.", opts)).toEqual(["username"]);
  });

  it("generic account names are never matched as bare words (only their home paths)", () => {
    const opts = { identity: { ...NOBODY, users: ["root", "runner", "user"] } };
    expect(classesIn("run as root by the runner user", opts)).toEqual([]);
    expect(classesIn(posix("home", "runner", "work"), opts)).toEqual(["home-path"]);
  });

  it("the allowlist excuses a placeholder account and nothing else", () => {
    const allowedAccounts = new Set(["myco"]);
    expect(classesIn("C:\\Users\\myco\\agent", { identity: NOBODY, allowedAccounts })).toEqual([]);
    expect(classesIn("/home/myco is the guest", { identity: NOBODY, allowedAccounts })).toEqual([]);
    expect(
      classesIn(win("Users", "zqbob", "agent"), { identity: NOBODY, allowedAccounts }),
    ).toEqual(["home-path"]);
  });
});

describe("leak detector: findings carry a location and a class, never a value", () => {
  it("scanText reports line and class only", () => {
    const text = ["ok", `cd ${posix("Users", "zqleaker", "x")}`, "ok", "owner zqleaker"].join("\n");
    const hits = scanText(text, { identity: { ...NOBODY, users: ["zqleaker"] } });
    expect(hits).toEqual([
      { line: 2, class: "username" },
      { line: 2, class: "home-path" },
      { line: 4, class: "username" },
    ]);
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(["class", "line"]);
  });
});
