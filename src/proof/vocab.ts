/**
 * Track Q (replayable proof): CLOSED VOCABULARIES for agent-produced names (#562, lead
 * ruling F1, 22:18Z / 22:27Z).
 *
 * The ruling: agent-produced key names and app ids go out verbatim only when the value is in
 * a closed vocabulary (known key names; registered app ids). Anything else is hashed
 * (`h-<64hex>`). Why: a closed id GRAMMAR keeps any identifier-shaped value verbatim, for
 * example a foreign account name (`jsmith`), `Users.jsmith.Documents` or `com.apple.Safari`.
 * The identity guard (`identity.ts`) cannot catch those, because it only knows THIS
 * machine's identity strings. A vocabulary is a list of constants of this code, so nothing an
 * agent types can widen it.
 *
 * The fields it governs (`closed.ts`, `FIELD_TREATMENT`):
 *  - `action.keys`: a key sequence. Verbatim only when it is spelled from `KEY_NAMES` and
 *    `KEY_MODIFIERS` in the grammar below; else hashed.
 *  - `action.app`: an app id. Verbatim only when it is a member of `REGISTERED_APPS`; else
 *    hashed.
 *  - `action.tool`: the tool the agent (or harness) called. Verbatim only when it is a member
 *    of `TOOL_NAMES`; else hashed (#553's final verifier showed `com.apple.Safari` and
 *    `Users.jsmith.Documents` there verbatim).
 *  - `policy.subject`: the tool or app a policy decided on. Verbatim only when it is a member
 *    of `TOOL_NAMES` or `REGISTERED_APPS`; else hashed.
 *
 * Matching is EXACT (case and spelling): a near miss (`Retrun`, `CTRL+s`, `Calc`,
 * `typetextglobal`) is not a member and is hashed. Adding a member is a reviewed change
 * (`test/proof/vocab.test.ts` pins each list).
 *
 * Key grammar: a sequence of 1 to `MAX_KEY_CHORDS` chords separated by single spaces. A chord
 * is either a NAMED key (`Return`, `Tab`, `F5`, ...) with optional modifiers (`shift+Tab`),
 * or a single lower-case letter or digit with at least one modifier (`ctrl+s`). A bare letter
 * or digit is not a chord, so a sequence cannot spell a word letter by letter (`j s m i t h`
 * is hashed), and the chord limit bounds how many characters any sequence can carry.
 */
import { hashedId } from "./closed.ts";

/** Named keys (X keysym spellings, as the runtime's `keyPress` and #542's `key` action use). */
export const KEY_NAMES = [
  "Return",
  "Enter",
  "Tab",
  "Escape",
  "BackSpace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "Page_Up",
  "Page_Down",
  "Up",
  "Down",
  "Left",
  "Right",
  "space",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

/** Modifiers a chord may carry, joined by `+` before the key. */
export const KEY_MODIFIERS = ["ctrl", "shift", "alt", "super", "meta", "cmd"] as const;

/** The most chords one key sequence may hold verbatim. */
export const MAX_KEY_CHORDS = 4;

/**
 * App ids a launch may name verbatim: the apps this repo's tasks drive (LibreOffice Calc and
 * Writer on the Linux and Windows paths, the S0 to-do app). A command line (`soffice calc`,
 * `localc a.csv`) is not an app id and is hashed.
 */
export const REGISTERED_APPS = [
  "calc",
  "writer",
  "libreoffice-calc",
  "libreoffice-writer",
  "localc",
  "lowriter",
  "soffice",
  "myco-todo",
] as const;

/**
 * Tool names an action may carry verbatim: #542's episode action kinds, the runtime desktop
 * actions (`src/discovery/live-runner.ts`), the Calc router's request kinds
 * (`src/actions/router.ts`), the fast-path tools (`src/actions/arm.ts`), the Windows guest
 * agent's ops (`src/integrity/surface.ts`) and the gate's MCP tool.
 */
export const TOOL_NAMES = [
  // #542 episode action kinds.
  "click",
  "type",
  "key",
  "scroll",
  "launch",
  "wait",
  "shell",
  "gate-check",
  "observe",
  // Runtime desktop actions.
  "typeTextGlobal",
  "clickAt",
  "keyPress",
  // Calc router request kinds.
  "calc.set-cell",
  "doc.export-csv",
  "shell.run",
  // Fast-path tools.
  "act",
  "act_script",
  // Windows guest agent ops.
  "ping",
  "session_info",
  "uia_tree",
  "uia_invoke",
  "screenshot",
  "read_file",
  "write_file",
  "kill",
  "uno_eval",
  // The gate's MCP tool.
  "myco_gate_check",
] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const alt = (list: readonly string[]): string => list.map(escapeRe).join("|");
const HASHED = "h-[0-9a-f]{64}";

const MOD = `(?:${alt(KEY_MODIFIERS)})\\+`;
const CHORD = `(?:(?:${MOD})*(?:${alt(KEY_NAMES)})|(?:${MOD})+[a-z0-9])`;
const KEYS_BODY = `${CHORD}(?: ${CHORD}){0,${MAX_KEY_CHORDS - 1}}`;
const KEYS_RE = new RegExp(`^${KEYS_BODY}$`);

/** Schema pattern of `action.keys`: a closed key sequence, or the hashed form. */
export const KEYS_SOURCE = `^(?:${KEYS_BODY}|${HASHED})$`;
/** Schema pattern of `action.app`. */
export const APP_SOURCE = `^(?:${alt(REGISTERED_APPS)}|${HASHED})$`;
/** Schema pattern of `action.tool`. */
export const TOOL_SOURCE = `^(?:${alt(TOOL_NAMES)}|${HASHED})$`;
/** Schema pattern of `policy.subject`. */
export const SUBJECT_SOURCE = `^(?:${alt([...TOOL_NAMES, ...REGISTERED_APPS])}|${HASHED})$`;

/** Whether `raw` is a key sequence spelled only from the key vocabulary. */
export function isClosedKeys(raw: string): boolean {
  return KEYS_RE.test(raw);
}

const isIn = (list: readonly string[], raw: string): boolean => list.includes(raw);

/** A tool name: as is when it is in `TOOL_NAMES`, else hashed. */
export function closedTool(raw: string): string {
  return isIn(TOOL_NAMES, raw) ? raw : hashedId(raw);
}

/** An app id: as is when it is in `REGISTERED_APPS`, else hashed. */
export function closedApp(raw: string): string {
  return isIn(REGISTERED_APPS, raw) ? raw : hashedId(raw);
}

/** A policy subject: as is when it is a known tool or a registered app, else hashed. */
export function closedSubject(raw: string): string {
  return isIn(TOOL_NAMES, raw) || isIn(REGISTERED_APPS, raw) ? raw : hashedId(raw);
}

/** A key sequence: as is when it is spelled from the key vocabulary, else hashed. */
export function closedKeys(raw: string): string {
  return isClosedKeys(raw) ? raw : hashedId(raw);
}

/** Every single vocabulary member: constants of this code, skipped by the identity scan. */
export const VOCAB_CONSTANTS: readonly string[] = [...TOOL_NAMES, ...REGISTERED_APPS, ...KEY_NAMES];
