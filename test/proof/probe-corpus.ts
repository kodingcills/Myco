/**
 * Track Q (replayable proof): every host-path / username probe the verifiers used on #533
 * and #548, in one corpus. Each entry is (name, value, user words that must never appear).
 * Every marker is assembled at run time from parts, so no tracked file carries a key-shaped
 * string or a real home path. Used by `probes.test.ts`.
 */
// biome-ignore-all lint/style/useTemplate: values are assembled from parts on purpose.

export const j = (...parts: string[]) => parts.join("");
// Planted markers (fake, low-entropy, assembled at run time).
export const SECRET_VALUE = j("PLANTED", "-SECRET-", "VALUE-0001");
export const ANT_KEY = j("sk-", "ant-", "PLANTEDPLANTED0002");
export const BEARER = j("Bearer ", "PLANTEDBEARERTOKEN0003");
export const VAULT_KEY = j("vault", "-mac-key-", "PLANTED0004");
export const USER = j("plantuser", "05");
export const MAC_HOME = j("/", "Users", "/", USER, "/");
export const LINUX_HOME = j("/", "home", "/", USER);
export const WIN_HOME = j("C:", "\\", "Users", "\\", USER, "\\Desktop\\a.csv");
export const PRIVATE_KEY = j(
  "-----BEGIN ",
  "OPENSSH PRIVATE KEY-----\nAAAA\n-----END ",
  "OPENSSH PRIVATE KEY-----",
);

export type Probe = readonly [name: string, value: string, words: readonly string[]];

/** #533 rounds 1-2 (D1, R2-D1): the leading-character and encoding bypasses. */
export const BYPASSES: ReadonlyArray<readonly [string, string]> = [
  ["P3: a tab before the path (JSON \\t in the file)", `see\t${MAC_HOME}secret.txt`],
  ["JSON-escaped slashes inside a value", `see ${MAC_HOME.replace(/\//g, "\\/")}secret.txt`],
  ["JSON \\u002f escapes inside a value", `see ${MAC_HOME.replace(/\//g, "\\u002f")}x`],
  ["percent-encoded path", `see ${MAC_HOME.replace(/\//g, "%2F")}x`],
  ["percent-encoded file: URL", `see file%3A%2F%2F%2Fetc%2Fhosts`],
  ["HTML-entity path", `see ${MAC_HOME.replace(/\//g, "&#47;")}x`],
  ["leading-character bypass: *", `*${LINUX_HOME}/x`],
  ["leading-character bypass: !", `!${LINUX_HOME}/x`],
  ["leading-character bypass: em dash", `\u2014${LINUX_HOME}/x`],
  ["leading-character bypass on a drive path", `x${WIN_HOME}`],
  ["leading-character bypass on a one-segment drive path", j("x", "D:", "\\", "PLANTEDdir")],
  ["drive path with forward slashes", `see ${WIN_HOME.replace(/\\/g, "/")}`],
  ["UNC path", j("see ", "\\\\", "fileserver", "\\", "share", "\\", USER, "\\x")],
  ["rootless backslash home", j("see ", "\\", "Users", "\\", USER, "\\x")],
  ["home-relative ~user path", `see ~${USER}/notes.txt`],
  ["leading-character bypass on a key shape", `id_${ANT_KEY}`],
  ["leading-character bypass on a key shape (digit)", j("1", "ghp_", "PLANTED0000000000")],
  ["key=value without a boundary", j("my", "secret=", "PLANTEDVALUE9")],
  // Verifier round 2, R2-D1: a home root after a character the POSIX lookbehind skips.
  // Probe A (exported through the library with no registered literals).
  ["R2-D1 A: home after '...'", j("Saving...", "/home/", USER, "/notes.txt")],
  ["R2-D1 A: Users after '../../'", j("cd ../../", "Users/", USER, "/Desktop")],
  ["R2-D1 A: Users after a digit and '/'", j("v2/", "Users/", USER, "/x")],
  ["R2-D1 A: home after '-'", j("build-", "/home/", USER, "/work/x")],
  ["R2-D1 A: drive-relative Users", j("dir=C:", "Users\\", USER, "\\x")],
  // Probe B (hand-edited, re-chained bundles).
  ["R2-D1 B: Users after '.../'", j("see.../", "Users/", USER, "/secret.txt")],
  ["R2-D1 B: Users after '-'", j("a-/", "Users/", USER, "/secret.txt")],
  ["R2-D1 B: home after a digit", j("2/", "home/", USER, "/x")],
  ["R2-D1 B: mixed separators", j("/", "Users\\", USER, "\\x")],
  ["R2-D1 B: drive-relative, bare", j("C:", "Users\\", USER, "\\x")],
  // The same shapes under other home roots and encodings.
  ["R2-D1: root home after a letter-adjacent '.'", j("x./", "root/", USER, "/x")],
  ["R2-D1: upper-case Windows home", j("v1/", "USERS\\", USER)],
  ["R2-D1: macOS per-user temp after '.'", j("x.", "/private/var/folders/", USER, "/T/a")],
  ["R2-D1: percent-encoded, after '...'", j("...", "%2Fhome%2F", USER, "%2Fx")],
];

export const FIRST = j("Plant", "first");
export const LAST = j("Zq", "PLANTEDlast");
export const GUEST = j("zq", "PLANTEDguest");
/** #533 round 3 (R3-D1) and #548 R2-D2: spaces, Documents and Settings, 8.3, UNC. */
export const SPACED: readonly Probe[] = [
  [
    "R3-D1 probe: the verifier's own string",
    j(
      "saved C:\\",
      "Users\\",
      FIRST,
      " ",
      LAST,
      "\\Desktop\\out.csv; old C:\\Documents and Settings\\",
      GUEST,
      "\\x",
    ),
    [FIRST, LAST, GUEST],
  ],
  ["space in a Windows user folder", j("C:\\", "Users\\", FIRST, " ", LAST, "\\x"), [FIRST, LAST]],
  [
    "space in a Windows user folder, forward slashes",
    j("C:/", "Users/", FIRST, " ", LAST, "/x"),
    [FIRST, LAST],
  ],
  [
    "space in a user folder at the end of the string",
    j("open C:\\", "Users\\", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  ["two spaces in a user folder", j("C:\\", "Users\\", FIRST, " de ", LAST, "\\x"), [FIRST, LAST]],
  [
    "apostrophe and space in a user folder",
    j("C:\\", "Users\\", FIRST, " O'", LAST, "\\x"),
    [FIRST, LAST],
  ],
  ["Documents and Settings", j("C:\\Documents and Settings\\", GUEST, "\\x"), [GUEST]],
  [
    "Documents and Settings with a spaced user",
    j("C:\\Documents and Settings\\", FIRST, " ", LAST, "\\Local Settings\\x"),
    [FIRST, LAST],
  ],
  ["Documents and Settings, lower case", j("c:/documents and settings/", GUEST, "/x"), [GUEST]],
  ["8.3 short name of Documents and Settings", j("C:\\DOCUME~1\\", GUEST, "\\x"), [GUEST]],
  [
    "8.3 short name of Documents and Settings with a spaced user",
    j("C:\\DOCUME~1\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  // #548 R2-D2: home roots with no drive letter, so the drive shape cannot mask them.
  [
    "Documents and Settings under a WSL mount, spaced user",
    j("/mnt/c/Documents and Settings/", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "rootless Documents and Settings, spaced user",
    j("cd \\Documents and Settings\\", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "rootless 8.3 Documents and Settings, spaced user",
    j("cd \\DOCUME~1\\", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "relative 8.3 Documents and Settings, spaced user",
    j("..\\DOCUME~1\\", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  ["8.3 short user folder", j("C:\\", "Users\\", "ZQPLAN~1", "\\x"), ["ZQPLAN~1"]],
  [
    "UNC share named after a spaced user",
    j("\\\\", "nas\\", FIRST, " ", LAST, "\\docs"),
    [FIRST, LAST],
  ],
  [
    "UNC homes share with a spaced user folder",
    j("see \\\\", "nas\\homes\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  [
    "UNC admin share into a spaced profile",
    j("\\\\", "pc\\c$\\", "Users\\", FIRST, " ", LAST, "\\x"),
    [FIRST, LAST],
  ],
  [
    "JSON \\u005c escapes around a spaced user (token-by-token rewrite would leak)",
    j("C:\\u005c", "Users\\u005c", FIRST, " ", LAST, "\\u005cx"),
    [FIRST, LAST],
  ],
  [
    "percent-encoded backslashes around a spaced user",
    j("C:%5C", "Users%5C", FIRST, " ", LAST, "%5Cx"),
    [FIRST, LAST],
  ],
  [
    "percent-encoded Documents and Settings",
    j("C:%5CDocuments%20and%20Settings%5C", GUEST, "%5Cx"),
    [GUEST],
  ],
  [
    "HTML-entity backslashes around a spaced user",
    j("C:&#92;", "Users&#92;", FIRST, " ", LAST, "&#92;x"),
    [FIRST, LAST],
  ],
];

export const BOB = j("Plant", "bob");
export const SMITH = j("Zq", "PLANTEDsmith");
export const BS = "\\";
/** #548 rounds 1-2 (D1-D3, R2-D1): the UNC class, encoded UNC, account-name forms. */
export const UNC_CLASS: readonly Probe[] = [
  [
    "D1 long-path UNC, spaced user",
    j(BS, BS, "?", BS, "UNC", BS, "nas", BS, "homes", BS, FIRST, " ", LAST, BS, "out"),
    [FIRST, LAST],
  ],
  [
    "D1 long-path UNC, plain user",
    j(BS, BS, "?", BS, "UNC", BS, "nas", BS, GUEST, BS, "x"),
    [GUEST],
  ],
  [
    "D1 device UNC, spaced user",
    j(BS, BS, ".", BS, "UNC", BS, "nas", BS, FIRST, " ", LAST, BS, "x"),
    [FIRST, LAST],
  ],
  [
    "D1 long-path drive into a spaced profile",
    j(BS, BS, "?", BS, "C:", BS, "Users", BS, FIRST, " ", LAST, BS, "x"),
    [FIRST, LAST],
  ],
  [
    "D1 long-path drive, spaced folder outside the home roots",
    j(BS, BS, "?", BS, "D:", BS, "Profiles", BS, FIRST, " ", LAST, BS, "x"),
    [FIRST, LAST],
  ],
  [
    "D1 mixed separators, spaced user",
    j("copy ", BS, BS, "nas/homes/", BOB, " ", SMITH, "/x.csv"),
    [BOB, SMITH],
  ],
  ["D1 mixed separators, plain user", j(BS, BS, "nas/", GUEST, "/x"), [GUEST]],
  ["D1 forward-slash UNC, spaced share", j("//nas/", FIRST, " ", LAST, "/x"), [FIRST, LAST]],
  ["D1 forward-slash UNC, homes share", j("//nas/homes/", FIRST, " ", LAST, "/x"), [FIRST, LAST]],
  ["D1 forward-slash UNC, plain user after a command", j("copy //nas/", GUEST, "/x.csv"), [GUEST]],
  [
    "D1 forward-slash UNC at the end of the string",
    j("open //nas/homes/", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "D1 double-escaped backslash UNC",
    j(BS, BS, BS, BS, "nas", BS, BS, "homes", BS, BS, FIRST, " ", LAST, BS, BS, "x"),
    [FIRST, LAST],
  ],
  ["D1 smb URL, plain user", j("smb://nas/homes/", GUEST, "/x"), [GUEST]],
  ["D1 smb URL, spaced user", j("open smb://nas/homes/", FIRST, " ", LAST, "/x"), [FIRST, LAST]],
  ["D1 afp URL, plain user", j("afp://mac.local/", GUEST), [GUEST]],
  // D2: encoded UNC with whitespace, once per decoder (and stacked), replaced whole.
  [
    "D2 JSON-escaped UNC",
    j("\\u005c\\u005cnas\\u005c", FIRST, " ", LAST, "\\u005cx"),
    [FIRST, LAST],
  ],
  ["D2 percent-encoded UNC", j("%5C%5Cnas%5C", FIRST, " ", LAST, "%5Cx"), [FIRST, LAST]],
  ["D2 entity-encoded UNC", j("&#92;&#92;nas&#92;homes&#92;", FIRST, " ", LAST), [FIRST, LAST]],
  [
    "D2 percent-encoded forward-slash UNC",
    j("%2F%2Fnas%2F", FIRST, " ", LAST, "%2Fx"),
    [FIRST, LAST],
  ],
  [
    "D2 JSON-escaped long-path UNC",
    j("\\u005c\\u005c?\\u005cUNC\\u005cnas\\u005c", FIRST, " ", LAST, "\\u005cx"),
    [FIRST, LAST],
  ],
  [
    "D2 stacked: entity over percent",
    j("&#37;5C&#37;5Cnas&#37;5C", FIRST, " ", LAST, "&#37;5Cx"),
    [FIRST, LAST],
  ],
  [
    "D2 percent-encoded smb URL, spaced user",
    j("smb:%2F%2Fnas%2Fhomes%2F", FIRST, " ", LAST, "%2Fx"),
    [FIRST, LAST],
  ],
  [
    "D1 long-path UNC, spaced user at the end of the string",
    j("open ", BS, BS, "?", BS, "UNC", BS, "nas", BS, "homes", BS, FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "D3 percent-encoded spaced drive path at the end of the string",
    j("cd D:%5CProfiles%5C", FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  // D3: spaced Windows drive paths outside the home roots.
  [
    "D3 spaced folder outside the home roots",
    j("D:", BS, "Profiles", BS, FIRST, " ", LAST, BS, "x"),
    [FIRST, LAST],
  ],
  [
    "D3 spaced folder outside the home roots, at the end",
    j("cd D:", BS, "Profiles", BS, FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "D3 percent-encoded spaced drive path",
    j("D:%5CProfiles%5C", FIRST, " ", LAST, "%5Cx"),
    [FIRST, LAST],
  ],
  // D3: account names as harnesses print them.
  ["D3 whoami DOMAIN\\user, spaced", j("desktop-7", BS, FIRST, " ", LAST), [FIRST, LAST]],
  ["D3 whoami DOMAIN\\user, plain", j("whoami: CORP", BS, GUEST), [GUEST]],
  ["D3 DNS domain\\user", j("corp.example", BS, GUEST, " logged on"), [GUEST]],
  ["D3 percent-encoded DOMAIN\\user, spaced", j("desktop-7%5C", FIRST, " ", LAST), [FIRST, LAST]],
  ["D3 user@host prompt", j(GUEST, "@DESKTOP-7 ~ %"), [GUEST]],
  ["D3 user@host:path from scp", j("scp a ", GUEST, "@nas.local:x"), [GUEST]],
  // #548 R2-D1 (a): a UNC path after PowerShell's provider qualifier `::` (Get-Location).
  [
    "R2-D1 PowerShell FileSystem:: provider path, spaced user",
    j(
      "Microsoft.PowerShell.Core",
      BS,
      "FileSystem::",
      BS,
      BS,
      "nas",
      BS,
      "homes",
      BS,
      FIRST,
      " ",
      LAST,
    ),
    [FIRST, LAST],
  ],
  [
    "R2-D1 PowerShell prompt on a UNC directory, spaced user",
    j("PS FileSystem::", BS, BS, "nas", BS, "homes", BS, FIRST, " ", LAST, BS, "x> dir"),
    [FIRST, LAST],
  ],
  [
    "R2-D1 UNC after a non-letter label and a colon",
    j("log 5:", BS, BS, "nas", BS, "homes", BS, FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  // #548 R2-D1 (b): the file:// URL form of a UNC path, and its spaced variants.
  [
    "R2-D1 file://server/share URL, spaced user",
    j("open file://nas/homes/", FIRST, " ", LAST, "/x"),
    [FIRST, LAST],
  ],
  [
    "R2-D1 file://///server/share URL (five slashes), spaced user",
    j("open file://///nas/homes/", FIRST, " ", LAST, "/x"),
    [FIRST, LAST],
  ],
  [
    "R2-D1 FILE:// in upper case with backslashes, spaced user",
    j("FILE:", BS, BS, "nas", BS, "homes", BS, FIRST, " ", LAST),
    [FIRST, LAST],
  ],
  [
    "R2-D1 percent-encoded file:// URL, spaced user",
    j("file://nas/homes/", FIRST, "%20", LAST, "/x"),
    [FIRST, LAST],
  ],
  // #548 round-2 nit, closed: a share or folder name may contain `,` (Last, First).
  [
    "UNC folder named Last, First",
    j(BS, BS, "nas", BS, "homes", BS, LAST, ", ", FIRST),
    [FIRST, LAST],
  ],
  [
    "smb URL folder named Last, First",
    j("smb://nas/homes/", LAST, ", ", FIRST, "/x"),
    [FIRST, LAST],
  ],
  [
    "drive folder named Last, First",
    j("cd D:", BS, "Profiles", BS, LAST, ", ", FIRST),
    [FIRST, LAST],
  ],
];

const SP = " ";
const QA = j("Qz", "PLANTEDalice");
const QL = j("Qz", "PLANTEDlast");
/**
 * #548 round 3 (final verdict, R3-D1): host-path forms that leaked a surname through the
 * pattern redactor, and the variants the verifier listed with them.
 */
export const ROUND3_548: readonly Probe[] = [
  [
    "a: NT-namespace UNC (fsutil)",
    j("Substitute Name: ", BS, "??", BS, "UNC", BS, "nas", BS, "homes", BS, QA, SP, QL),
    [QA, QL],
  ],
  [
    "b: \\Device\\Mup (Process Explorer)",
    j(BS, "Device", BS, "Mup", BS, "nas", BS, "homes", BS, QA, SP, QL),
    [QA, QL],
  ],
  [
    "c: cmd built-in glued to a UNC path",
    j("dir", BS, BS, "nas", BS, "homes", BS, QA, SP, QL),
    [QA, QL],
  ],
  ["d: Windows shared profile", j("cd C:", BS, "Users", BS, "Public", BS, QA, SP, QL), [QA, QL]],
  ["e: macOS shared folder", j("ls /", "Users", "/Shared/", QA, SP, QL), [QA, QL]],
  [
    "variant: bare UNC\\host\\share",
    j("UNC", BS, "nas", BS, "homes", BS, FIRST, SP, LAST),
    [FIRST, LAST],
  ],
  [
    "variant: bracketed NT UNC",
    j("[", BS, "??", BS, "UNC", BS, "nas", BS, FIRST, SP, LAST, "]"),
    [FIRST, LAST],
  ],
  ["variant: x\\\\nas", j("x", BS, BS, "nas", BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["variant: 5\\\\nas", j("5", BS, BS, "nas", BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["variant: a.b\\\\nas", j("a.b", BS, BS, "nas", BS, FIRST, SP, LAST), [FIRST, LAST]],
  [
    "variant: literal \\n before a UNC",
    j("log", BS, "n", BS, BS, "nas", BS, FIRST, SP, LAST),
    [FIRST, LAST],
  ],
  [
    "variant: Public\\..\\",
    j("C:", BS, "Users", BS, "Public", BS, "..", BS, FIRST, SP, LAST),
    [FIRST, LAST],
  ],
  [
    "variant: CI workspace with a spaced folder",
    j("/home/runner/work/", FIRST, SP, LAST, "/x"),
    [FIRST, LAST],
  ],
  ["nit: UNC host with a space", j(BS, BS, FIRST, SP, LAST, "-PC", BS, "share"), [FIRST, LAST]],
  [
    "nit: net use /user:CORP\\x",
    j("net use Z: ", BS, BS, "nas", BS, "s /user:CORP", BS, GUEST),
    [GUEST],
  ],
];

/**
 * Forms the earlier rounds listed as LIMITS of the pattern scanner (not caught by it). Under
 * the allowlist they never reach a bundle either; the scanner is not asserted on them.
 */
export const LIMITS: readonly Probe[] = [
  ["#548 r2 limit: user@IP", j(GUEST, "@10.0.0.5"), [GUEST]],
  ["#548 r2 limit: runas /user:CORP\\x", j("runas /user:CORP", BS, GUEST, " cmd"), [GUEST]],
  ["#548 r2 limit: User Name: x", j("User Name: ", GUEST), [GUEST]],
  ["#548 r2 limit: USERNAME=x", j("USERNAME=", GUEST), [GUEST]],
  ["#548 r2 limit: /Volumes spaced folder", j("/Volumes/", FIRST, SP, LAST, "/x"), [FIRST, LAST]],
  [
    "#548 r1 limit: tab inside Documents and Settings",
    j("C:", BS, "Documents\tand Settings", BS, GUEST),
    [GUEST],
  ],
  ["#548 r1 limit: unlisted URL scheme", j("dest://nas/homes/", FIRST, SP, LAST), [FIRST, LAST]],
  [
    "#548 r1 limit: POSIX spaced folder outside home roots",
    j("/srv/", FIRST, SP, LAST, "/x"),
    [FIRST, LAST],
  ],
  ["#533 r3 nit: soft hyphen inside Users", j("C:", BS, "Us\u00ader", "s", BS, GUEST), [GUEST]],
  ["#533 r3 nit: fullwidth solidus", j("/Users\uff0f", GUEST, "\uff0fx"), [GUEST]],
  ["#533 r3 nit: run.../tmp", j("run.../tmp/", GUEST, "/y"), [GUEST]],
  ["#533 r3 nit: .../workspace", j(".../workspace/", GUEST, "/x"), [GUEST]],
  ["#533 r3 nit: Synology homes", j(".../homes/", GUEST), [GUEST]],
];

/** #548 round 1: the verifier's "all clean" probes, kept as tests. */
export const ROUND1_548_CLEAN: readonly Probe[] = [
  ["double-escaped backslashes", j("C:", BS, BS, "Users", BS, BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["\\u0020 space", j("C:", BS, "Users", BS, FIRST, "\\u0020", LAST), [FIRST, LAST]],
  ["%20 space", j("C:", BS, "Users", BS, FIRST, "%20", LAST), [FIRST, LAST]],
  ["%2520 space", j("C:", BS, "Users", BS, FIRST, "%2520", LAST), [FIRST, LAST]],
  ["%252520 space", j("C:", BS, "Users", BS, FIRST, "%252520", LAST), [FIRST, LAST]],
  ["&bsol; entity", j("C:&bsol;Users&bsol;", FIRST, SP, LAST), [FIRST, LAST]],
  ["file:///C:/Users spaced", j("file:///C:/Users/", FIRST, SP, LAST, "/x"), [FIRST, LAST]],
  ["file:///C:/Users %20", j("file:///C:/Users/", FIRST, "%20", LAST, "/x"), [FIRST, LAST]],
  ["WSL mount", j("/mnt/c/Users/", FIRST, SP, LAST), [FIRST, LAST]],
  ["PowerShell prompt", j("PS C:", BS, "Users", BS, FIRST, SP, LAST, "> ls"), [FIRST, LAST]],
  ["quoted path", j('"C:', BS, "Users", BS, FIRST, SP, LAST, '"'), [FIRST, LAST]],
  [
    "\\\\?\\C: long path",
    j(BS, BS, "?", BS, "C:", BS, "Users", BS, FIRST, SP, LAST),
    [FIRST, LAST],
  ],
  ["NBSP", j("C:", BS, "Users", BS, FIRST, "\u00a0", LAST), [FIRST, LAST]],
  ["ideographic space", j("C:", BS, "Users", BS, FIRST, "\u3000", LAST), [FIRST, LAST]],
  ["USERPROFILE=", j("USERPROFILE=C:", BS, "Users", BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["docume~1 lower case", j("c:", BS, "docume~1", BS, GUEST), [GUEST]],
  ["macOS spaced home", j("/Users/", FIRST, SP, LAST, "/x"), [FIRST, LAST]],
  ["\\\\.\\UNC", j(BS, BS, ".", BS, "UNC", BS, "nas", BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["UNC by IP", j(BS, BS, "10.0.0.5", BS, "homes", BS, FIRST, SP, LAST), [FIRST, LAST]],
  ["homes$ share", j(BS, BS, "nas", BS, "homes$", BS, GUEST), [GUEST]],
  [
    "WebDAV @SSL@port",
    j(BS, BS, "nas.example@SSL@443", BS, "dav", BS, FIRST, SP, LAST),
    [FIRST, LAST],
  ],
  ["IPv6 literal UNC", j(BS, BS, "fe80--1.ipv6-literal.net", BS, "s", BS, GUEST), [GUEST]],
  ["admin share", j(BS, BS, "pc", BS, "c$", BS, "Users", BS, GUEST), [GUEST]],
  [
    "quoted net use",
    j('net use Z: "', BS, BS, "nas", BS, "homes", BS, FIRST, SP, LAST, '"'),
    [FIRST, LAST],
  ],
];
