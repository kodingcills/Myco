/**
 * Track O: classify a key chord the way the guest delivers it, failing closed.
 *
 * The guest agent (`runtime/crates/myco-rt-agent/src/act.rs`, `parse_chord`) splits a chord on
 * `+`, trims each part with Rust's `str::trim` (Unicode White_Space), drops empty parts, maps
 * the leading parts to modifiers (repeats collapse to one held key), and reads the last part as
 * the key: a named key, `f<n>` (n a u8, leading zeros allowed), or one character (an ASCII
 * capital adds Shift). `parseGuestChord` reproduces that exactly, so `ctrl++s`, `ctrl+s+`,
 * `+ctrl+s`, `ctrl+ctrl+s`, ` CTRL + S ` and `super+s` reduce to what the guest really presses.
 *
 * `chordEffect` then names the chord's file effect:
 * - `save`: exactly Ctrl+S or Meta+S (Super and Cmd are Meta), which saves over the open
 *   document;
 * - `none`: a chord on the closed allow-list below, which cannot write a file by itself;
 * - `unknown`: everything else, denied as `POLICY_ACTION_UNRECOGNISED`. That covers Save As
 *   (Ctrl+Shift+S, F12), every Alt chord (menu accelerators such as Alt+F, then S), F10 (the
 *   menu bar), close and quit chords whose dialog defaults to Save (Ctrl+W, Ctrl+Q), export and
 *   print chords, and any chord the guest itself would refuse to parse.
 *
 * The allow-list is the fail-closed direction: an app binding nobody listed is `unknown`, never
 * an allow. Plain keys (no modifier, or Shift only) act inside whatever has focus, so they can
 * also act on a menu or dialog that an earlier action opened. Every chord that opens a menu or
 * a Save dialog is `unknown`, but a CLICK can open one too: a click on the File menu followed by
 * a plain `s` (the menu mnemonic) saves, and a click on a Save button saves outright. Clicks are
 * the known limit documented in `./actuators.ts`.
 */

export type Modifier = "ctrl" | "shift" | "alt" | "meta";

export interface GuestChord {
  /** The held modifiers, each once. */
  readonly mods: ReadonlySet<Modifier>;
  /** A named key (`enter`, `pagedown`, ...), `f<n>`, or `char:<c>` for one character. */
  readonly key: string;
}

export type ChordEffect = "none" | "save" | "unknown";

// Rust's `char::is_whitespace` (Unicode White_Space), which `str::trim` strips. JS `trim` differs
// (it strips U+FEFF and keeps U+0085), so it is not used.
const WS =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEAD = new RegExp(`^[${WS}]+`);
const TRAIL = new RegExp(`[${WS}]+$`);

function rustTrim(s: string): string {
  return s.replace(LEAD, "").replace(TRAIL, "");
}

/** Rust's `to_ascii_lowercase`: only A-Z change. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const MODIFIERS: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  super: "meta",
};

const NAMED: Readonly<Record<string, string>> = {
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  backspace: "backspace",
  tab: "tab",
  space: "space",
  delete: "delete",
  insert: "insert",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

/** The guest's parse of `spec`, or null where the guest would refuse it. */
export function parseGuestChord(spec: string): GuestChord | null {
  const parts = spec
    .split("+")
    .map(rustTrim)
    .filter((p) => p.length > 0);
  const last = parts.pop();
  if (last === undefined) return null;
  const mods = new Set<Modifier>();
  for (const m of parts) {
    const name = asciiLower(m);
    if (!Object.hasOwn(MODIFIERS, name)) return null;
    mods.add(MODIFIERS[name] as Modifier);
  }
  const lower = asciiLower(last);
  if (Object.hasOwn(NAMED, lower)) return { mods, key: NAMED[lower] as string };
  const f = /^f([0-9]+)$/.exec(lower);
  if (f !== null && Number(f[1]) <= 255) return { mods, key: `f${Number(f[1])}` };
  const chars = [...last];
  if (chars.length !== 1) return null;
  const c = chars[0] as string;
  if (c >= "A" && c <= "Z") {
    mods.add("shift");
    return { mods, key: `char:${asciiLower(c)}` };
  }
  return { mods, key: `char:${c}` };
}

const NAV = ["home", "end", "left", "right", "up", "down"];
/** With Ctrl or Meta alone: clipboard, undo/redo, select all, formatting, navigation. */
const SAFE_WITH_COMMAND = new Set([
  ...["c", "x", "v", "z", "y", "a", "b", "i", "u"].map((c) => `char:${c}`),
  ...NAV,
  "backspace",
  "delete",
  "pageup",
  "pagedown",
]);
/** With Ctrl or Meta plus Shift: redo and extend-selection navigation. */
const SAFE_WITH_COMMAND_SHIFT = new Set(["char:z", ...NAV]);
/** F-keys allowed with no modifier (F2: edit the cell). Every other F-key is unknown. */
const SAFE_F_KEYS = new Set(["f2"]);

function only(mods: ReadonlySet<Modifier>, ...want: Modifier[]): boolean {
  return mods.size === want.length && want.every((m) => mods.has(m));
}

/** The chord's file effect. Never throws; anything not understood is `unknown`. */
export function chordEffect(spec: unknown): ChordEffect {
  if (typeof spec !== "string" || spec.length > 256) return "unknown";
  const chord = parseGuestChord(spec);
  if (chord === null) return "unknown";
  const { mods, key } = chord;
  if (mods.has("alt")) return "unknown";
  if (/^f[0-9]+$/.test(key)) return mods.size === 0 && SAFE_F_KEYS.has(key) ? "none" : "unknown";
  const command = mods.has("ctrl") || mods.has("meta");
  if (!command) return "none"; // no modifier, or Shift only
  for (const cmd of ["ctrl", "meta"] as const) {
    if (only(mods, cmd)) {
      if (key === "char:s") return "save";
      return SAFE_WITH_COMMAND.has(key) ? "none" : "unknown";
    }
    if (only(mods, cmd, "shift")) return SAFE_WITH_COMMAND_SHIFT.has(key) ? "none" : "unknown";
  }
  return "unknown"; // Ctrl and Meta together
}
