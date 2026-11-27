/**
 * Copied verbatim from #553 (`test/proof/path-fuzz.ts`, Track Q) for the episode export's allowlist
 * tests (TIF-265). TO FILE: share one copy once #553 merges.
 *
 * Track Q test helper: a seeded generator of arbitrary host-path strings, for the property
 * test in `allowlist.test.ts`. Deterministic (mulberry32), so a failure names a case index
 * that reproduces.
 *
 * Every variable part (user, server, share, domain, folder) is a planted word: "Qz" plus 4-9
 * letters from g-z, so no word can ever appear inside a sha256 hex digest or inside the
 * bundle's fixed vocabulary by chance. The generator returns the words with the path.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FuzzPath {
  readonly value: string;
  /** Every planted word in the value (user, host, share, domain and folder names). */
  readonly words: readonly string[];
  /** Which template and encoding produced it (for a failure message). */
  readonly shape: string;
}

const LETTERS = "ghijklmnopqrstuvwxyz";
/** Assembled so no tracked line holds a literal macOS home path (TIF-241). */
const USERS = ["Us", "ers"].join("");

export function makePathFuzzer(seed: number): () => FuzzPath {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  return () => {
    const words: string[] = [];
    const word = () => {
      let w = "Qz";
      const n = 4 + int(6);
      for (let i = 0; i < n; i++) {
        const c = LETTERS[int(LETTERS.length)] as string;
        w += rnd() < 0.3 ? c.toUpperCase() : c;
      }
      words.push(w);
      return w;
    };
    // A user folder: plain, spaced, apostrophe, "Last, First", 8.3 short, or with unicode
    // (RTL override, RTL mark, combining accent, NBSP, ideographic space, emoji).
    const user = () => {
      switch (int(9)) {
        case 0:
          return word();
        case 1:
          return `${word()} ${word()}`;
        case 2:
          return `${word()} O'${word()}`;
        case 3:
          return `${word()}, ${word()}`;
        case 4: {
          // An 8.3 short name keeps only a 6-letter stem: that stem is the planted word.
          const stem = word().slice(0, 6);
          words.pop();
          words.push(stem);
          return `${stem.toUpperCase()}~${1 + int(9)}`;
        }
        case 5:
          return `${word()}\u202e${word()}`;
        case 6:
          return `${word()}\u200f\u0301 ${word()}`;
        case 7:
          return `${word()}${pick(["\u00a0", "\u3000", "\u2003"])}${word()}`;
        default:
          return `${word()} \u{1F600} ${word()}`;
      }
    };
    const sepOne = () => pick(["\\", "/", "\\\\", "//", "\\/", "/\\"]);
    const tail = () => {
      const parts: string[] = [];
      const n = int(4);
      for (let i = 0; i < n; i++)
        parts.push(pick([word(), "Desktop", "out.csv", "AppData", "x y"]));
      return parts.join(sepOne());
    };
    const s = sepOne;
    const srv = () => pick([word(), `${word()}.local`, "10.0.0.5", `${word()}@SSL@443`]);
    const templates: ReadonlyArray<readonly [string, () => string]> = [
      ["drive Users", () => `C:${s()}Users${s()}${user()}${s()}${tail()}`],
      ["drive users lower", () => `c:${s()}users${s()}${user()}`],
      [
        "Documents and Settings",
        () => `C:${s()}Documents and Settings${s()}${user()}${s()}${tail()}`,
      ],
      ["DOCUME~1", () => `C:${s()}DOCUME~1${s()}${user()}`],
      ["drive-relative", () => `C:Users${s()}${user()}`],
      ["shared profile", () => `D:${s()}Users${s()}Public${s()}${user()}`],
      ["non-home drive folder", () => `E:${s()}Profiles${s()}${user()}${s()}${tail()}`],
      ["UNC", () => `\\\\${srv()}\\${word()}\\${user()}\\${tail()}`],
      ["UNC homes$", () => `\\\\${srv()}\\homes$\\${user()}`],
      ["forward UNC", () => `//${srv()}/${word()}/${user()}`],
      ["mixed UNC", () => `\\\\${srv()}/${word()}\\${user()}`],
      ["long-path UNC", () => `\\\\?\\UNC\\${srv()}\\${word()}\\${user()}`],
      ["long-path drive", () => `\\\\?\\C:\\Users\\${user()}\\${tail()}`],
      ["device UNC", () => `\\\\.\\UNC\\${srv()}\\${user()}`],
      ["NT UNC", () => `\\??\\UNC\\${srv()}\\${word()}\\${user()}`],
      ["Device Mup", () => `\\Device\\Mup\\${srv()}\\${word()}\\${user()}`],
      ["GLOBALROOT", () => `\\\\?\\GLOBALROOT\\Device\\Mup\\${srv()}\\${user()}`],
      ["bare UNC", () => `UNC\\${srv()}\\${word()}\\${user()}`],
      ["POSIX home", () => `/home/${user()}/${tail()}`],
      ["macOS Users", () => `/${USERS}/${user()}/${tail()}`],
      ["macOS Shared", () => `/${USERS}/Shared/${user()}`],
      ["WSL", () => `/mnt/c/Users/${user()}`],
      ["root", () => `/root/${word()}`],
      ["CI workspace", () => `/home/runner/work/${user()}/x`],
      ["Volumes", () => `/Volumes/${user()}/x`],
      ["var folders", () => `/private/var/folders/${word()}/T/x`],
      ["tilde user", () => `~${word()}`],
      ["tilde user path", () => `~${word()}/${tail()}`],
      ["file URL drive", () => `file:///C:/${USERS}/${user()}/x`],
      ["file URL host", () => `file://${srv()}/${word()}/${user()}`],
      ["file URL five slashes", () => `file://///${srv()}/${user()}`],
      ["smb URL", () => `smb://${srv()}/homes/${user()}`],
      ["DOMAIN\\user", () => `${word()}\\${user()}`],
      ["user@host", () => `${word()}@${word()}.local`],
      ["runas", () => `runas /user:${word()}\\${user()} cmd`],
      [
        "PowerShell provider",
        () => `Microsoft.PowerShell.Core\\FileSystem::\\\\${srv()}\\${user()}`,
      ],
      ["env assignment", () => `USERPROFILE=C:\\Users\\${user()}`],
    ];
    const [tName, make] = pick(templates);
    let value = make();
    const prefix = pick([
      "",
      "",
      "cd ",
      "dir",
      "PS ",
      "Substitute Name: ",
      "x",
      "5",
      "a.b",
      "...",
      "-",
      "\t",
      '"',
      "error: ",
      "log\\n",
      "[",
      "*",
      "\u2014",
    ]);
    const suffix = pick(["", "", ">", '"', " ; ok", "\n", "]", "\r\n"]);
    value = `${prefix}${value}${suffix}`;
    // An encoding (the whole value, or only its separators and spaces), sometimes stacked.
    const encodings: ReadonlyArray<readonly [string, (v: string) => string]> = [
      ["plain", (v) => v],
      ["plain", (v) => v],
      ["percent", (v) => encodeURIComponent(v)],
      ["percent seps", (v) => v.replace(/\\/g, "%5C").replace(/\//g, "%2F").replace(/ /g, "%20")],
      ["double percent", (v) => encodeURIComponent(encodeURIComponent(v))],
      ["json", (v) => JSON.stringify(v).slice(1, -1)],
      ["json u005c", (v) => v.replace(/\\/g, "\\u005c").replace(/\//g, "\\u002f")],
      ["json \\/", (v) => v.replace(/\//g, "\\/")],
      [
        "html entity",
        (v) => v.replace(/\\/g, "&#92;").replace(/\//g, "&#x2F;").replace(/ /g, "&#32;"),
      ],
      ["named entity", (v) => v.replace(/\\/g, "&bsol;").replace(/\//g, "&sol;")],
      ["url plus", (v) => v.replace(/ /g, "+")],
      ["upper", (v) => v.toUpperCase()],
    ];
    const [eName, enc] = pick(encodings);
    value = enc(value);
    // Sometimes very long: the path repeated, or buried deep in filler.
    const long = rnd() < 0.08;
    if (long)
      value = `${"filler ".repeat(500 + int(1500))}${value}${` ${value}`.repeat(1 + int(20))}`;
    return {
      value,
      words: [...new Set(words)],
      shape: `${tName} / ${eName}${long ? " / long" : ""}`,
    };
  };
}
