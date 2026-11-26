/**
 * Plugin author SDK, `myco.plugin/1` (capability track T).
 *
 * A plugin is a directory with a closed manifest (`myco-plugin.json`, see `protocol.ts`) and
 * an entry module that default-exports `definePlugin({...})`. The plugin never touches stdin,
 * stdout, files or the network: Myco's sandboxed child (`child.ts`) hands it the captured
 * bytes and writes its answer. See `docs/plugins/byoa.md`.
 *
 * Contract for authors:
 *  - `oracle(doc, intent)` returns `{ status, code }`; `code` matches `CODE` (codes only).
 *    Say `uncertain` whenever you cannot read the document in full; never guess `verified`.
 *  - `reader(doc)` returns typed state (`PluginState`), or `uncertain` with a code.
 *  - `selftestCases()` returns the cases the R5 mutation self-test runs: for every class the
 *    manifest claims, at least one seeded corruption. Myco adds its own read corruptions
 *    (truncations, flipped bytes, a missing file) to every case, so claim a read class only
 *    if your oracle catches ANY such damage, not just the cases you wrote.
 *  - Throwing, hanging, printing, or exceeding a cap is never a pass: the host records it as
 *    `uncertain` with a `PLUGIN_*` code, and during registration it refuses the plugin.
 *
 * This file and `protocol.ts` import nothing else: they load inside the sandbox.
 */
import type { OracleStatus, PluginCorruptionClass, PluginState } from "./protocol.ts";

export type {
  CellValue,
  OracleStatus,
  PluginCaps,
  PluginCorruptionClass,
  PluginFormat,
  PluginKind,
  PluginManifest,
  PluginState,
  StateCell,
  StateField,
} from "./protocol.ts";
export { CODE, PLUGIN_CORRUPTION_CLASSES, PLUGIN_SPEC } from "./protocol.ts";

/** A saved document as a plugin sees it: a basename and the bytes (null: nothing saved). */
export interface PluginDocument {
  readonly fileName: string;
  readonly bytes: Uint8Array | null;
}

export interface OracleAnswer {
  readonly status: OracleStatus;
  readonly code: string;
}

export type ReaderAnswer =
  | { readonly status: "ok"; readonly code: string; readonly state: PluginState }
  | { readonly status: "uncertain"; readonly code: string };

export interface PluginSelfTestCase<Intent> {
  readonly id: string;
  readonly intent: Intent;
  readonly correct: { readonly fileName: string; readonly bytes: Uint8Array };
  readonly corruptions: readonly {
    readonly cls: PluginCorruptionClass;
    readonly doc: PluginDocument;
  }[];
}

export interface PluginModule<Intent = unknown> {
  readonly oracle?: (doc: PluginDocument, intent: Intent) => OracleAnswer | Promise<OracleAnswer>;
  readonly reader?: (doc: PluginDocument) => ReaderAnswer | Promise<ReaderAnswer>;
  readonly selftestCases?: () =>
    | readonly PluginSelfTestCase<Intent>[]
    | Promise<readonly PluginSelfTestCase<Intent>[]>;
}

/** Identity, for typing: `export default definePlugin<MyIntent>({ oracle, selftestCases })`. */
export function definePlugin<Intent>(plugin: PluginModule<Intent>): PluginModule<Intent> {
  return plugin;
}
