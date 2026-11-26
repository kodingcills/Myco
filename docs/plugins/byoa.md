# Bring your own app: plugin spec and SDK (`myco.plugin/1`)

**Track:** capability T (M2 scope, Tier 2). **Status:** built and tested at $0 with fakes; not
measured. Plugins are not wired into the gate (`myco.gate/v1`) and their results are never R1
evidence unless the lead rules otherwise.

Myco reads Calc and Writer documents itself. A plugin lets someone outside the repo add another
app: a **state reader** that turns the app's saved document into typed state, and/or an
**oracle** that gives a three-valued verdict over the saved bytes. The oracle is only accepted
after it passes the same R5 mutation self-test as Myco's own oracles
(`src/oracle-selftest`), for every corruption class it claims.

- Spec and parsers: `src/plugins/sdk/protocol.ts`
- Author SDK: `src/plugins/sdk/index.ts`
- Sandbox child and guard: `src/plugins/sdk/child.ts`, `src/plugins/sdk/guard.ts`
- Host (registration, invocation): `src/plugins/host/registry.ts`, `src/plugins/host/sandbox.ts`
- Example: `examples/plugins/csv-ledger/` (a simple text/CSV "ledger" app)
- Security model: `docs/security/plugin-sandbox.md`
- Proposed measurement bar: `docs/product/capability-t-byoa.md`

## 1. A plugin is a directory

```
my-plugin/
  myco-plugin.json   the closed manifest
  plugin.ts          the entry (.ts, .mjs or .js), default-exporting the plugin
```

The directory must be self-contained: no symlinks, no special files, at most 256 files and
16 MiB. Only builtins on the sandbox allowlist resolve (`assert`, `buffer`, `crypto`,
`events`, `path`, `querystring`, `stream`, `string_decoder`, `timers`, `url`, `util`, `zlib`).
npm packages are not resolved, so bundle any dependency into the directory. A `.ts` entry runs
with Node's type stripping, so use erasable TypeScript only: no enums, namespaces or
parameter properties.

### 1.1 The manifest (closed)

```json
{
  "spec": "myco.plugin/1",
  "name": "csv-ledger",
  "version": "1.0.0",
  "app": "ledger-csv",
  "kinds": ["oracle", "reader"],
  "formats": [{ "ext": ".csv", "mediaType": "text/csv" }],
  "claims": ["edit-missing", "wrong-value", "wrong-target", "truncated", "missing-file"],
  "caps": { "timeoutMs": 5000, "memoryMb": 64, "maxInputBytes": 1048576, "maxOutputBytes": 262144 },
  "entry": "plugin.ts"
}
```

| Key | Rule |
|---|---|
| `spec` | exactly `myco.plugin/1`; a new version of this spec is a new string |
| `name`, `app` | `[a-z0-9][a-z0-9-]{0,63}` |
| `version` | `MAJOR.MINOR.PATCH` |
| `kinds` | non-empty subset of `oracle`, `reader` |
| `formats` | 1 to 8 `{ext, mediaType}`; a document whose extension is not listed never reaches the plugin |
| `claims` | the corruption classes the oracle claims (below); at least one for an oracle, none for a reader-only plugin |
| `caps` | `timeoutMs` 100 to 10,000; `memoryMb` 16 to 256; `maxInputBytes` up to 16 MiB; `maxOutputBytes` 256 B to 1 MiB |
| `entry` | a relative module path inside the directory, no `..` |

Any other key, anywhere, is refused. In particular there is **no** network, filesystem,
process or environment capability to ask for: a plugin gets none of them.

### 1.2 The entry module

```ts
import type { PluginModule } from "myco/plugins/sdk"; // src/plugins/sdk/index.ts in this repo

const plugin: PluginModule<MyIntent> = {
  oracle(doc, intent) { /* -> { status: "verified" | "refuted" | "uncertain", code } */ },
  reader(doc) { /* -> { status: "ok", code, state } | { status: "uncertain", code } */ },
  selftestCases() { /* -> the R5 cases, see §3 */ },
};
export default plugin;
```

`definePlugin` in the SDK is the same thing with inferred types. `doc` is
`{ fileName, bytes }`: the basename of the captured file and its bytes (`null` when nothing
was saved). That is all the plugin sees of the trial.

- **Codes only.** `code` must match `^[A-Z][A-Z0-9_]{0,63}$`. A plugin cannot put prose, a
  path or a value into a verdict.
- **Never guess.** Return `uncertain` whenever the document cannot be read in full.
- **Never print.** The answer goes through the SDK; any stray output makes the response
  malformed, which is `uncertain`.

### 1.3 Reader state

A reader returns one of the typed shapes capability-spec §I proposes for track I's live-app
tools (`state_cells`, `state_fields`, `state_text`), so an agent sees the same shape whether
state came from the live app (lands with track I) or from a plugin over a saved document:

```ts
{ kind: "cells", cells: [{ ref: "B3", value: 455, valueKind: "number", formula: false }] }
{ kind: "fields", fields: [{ label: "Payee", value: "Rent" }] }
{ kind: "text", text: "..." }
```

At most 10,000 items, strings at most 4,096 characters; a value must match its `valueKind`.
A reader reports what the document holds. It never says whether that is right.

## 2. What happens on each call

One request, one sandboxed child process, one response line:

1. The host checks the registration (issued by `registerPlugin`, not a look-alike), re-hashes
   the plugin directory (an edited plugin is `PLUGIN_CHANGED`), checks the kind, the file
   extension, the input size and the intent size (64 KiB).
2. It starts `node --permission` with reads allowed only for the SDK and the plugin
   directory, an empty environment, the heap cap, and the sandbox guard preloaded.
3. It sends `{fileName (basename), bytesB64, intent}` on stdin.
4. It parses exactly one response line with the closed parser.

Any failure is `uncertain` with a host code (`codeSource: "host"`):

| Code | Cause |
|---|---|
| `PLUGIN_NOT_REGISTERED` | not a registration the host issued |
| `PLUGIN_CHANGED` | plugin files differ from the registered tree hash |
| `PLUGIN_KIND_UNCLAIMED` | oracle asked of a reader-only plugin, or the reverse |
| `PLUGIN_FORMAT_UNCLAIMED` | extension not in `formats` |
| `PLUGIN_FILENAME_INVALID` | basename outside `[A-Za-z0-9._-]{1,128}` |
| `PLUGIN_INPUT_TOO_LARGE` | document over `maxInputBytes` |
| `PLUGIN_INTENT_INVALID` | intent not JSON or over 64 KiB |
| `PLUGIN_TIMEOUT` | wall clock over `timeoutMs` (SIGKILL) |
| `PLUGIN_MEMORY_EXCEEDED` | heap over `memoryMb`, or resident memory over `memoryMb` + 128 MiB runtime allowance |
| `PLUGIN_OUTPUT_TOO_LARGE` | stdout over `maxOutputBytes` (child killed) |
| `PLUGIN_NO_HOOK` | the module lacks the hook, or has no default export |
| `PLUGIN_THREW` | the hook or the module threw |
| `PLUGIN_CRASH` | any other non-zero exit or signal |
| `PLUGIN_MALFORMED_OUTPUT` | not exactly one closed `myco.plugin/1` response line |
| `PLUGIN_SPAWN_FAILED` | the child could not start |

Every result is labelled:

```ts
{
  status, code,
  codeSource: "plugin" | "host",
  provenance: { source: "plugin", spec, plugin, version, app, manifestSha256, treeSha256 },
  r1Evidence: false,
  evidenceClass: "plugin-experiment",
}
```

It is not a `myco.benchmark.arm-row/1` row (a test pins that the schema refuses it), so the
R1 path (`src/benchmark/taskset-binding.ts`, `src/m2/evidence.ts`) cannot ingest it.

## 3. Registration and the R5 mutation self-test

`registerPlugin(dir)` returns a frozen registration or a refusal with a code and
operator-facing reasons. For an oracle plugin:

1. The plugin's `selftestCases()` supplies up to 64 cases: an intent, a correct saved
   document, and seeded corruptions labelled with their class (up to 64 per case).
2. **The host adds its own read corruptions to every case:** three truncations
   (`n-1`, `n/2`, `n/4` bytes), three single-byte flips (`n/3`, `2n/3`, `n-1`), and a missing
   file. A plugin cannot choose only the damage it happens to catch.
3. `runSelfTest` (`src/oracle-selftest/run.ts`, unchanged) runs every document through the
   sandboxed oracle. The bar: every correct document verifies, and for **every claimed
   class** at least one corruption ran and none verified.
4. The sandbox must answer every self-test document itself. A timeout or crash on a
   corruption counts as `uncertain` at run time (fail closed), but at registration it is
   `SELFTEST_HARNESS_FAULT`: a catch the sandbox made is not a catch the plugin made.

| Refusal | Cause |
|---|---|
| `PLUGIN_DIR_INVALID` | missing directory, symlink, special file, size bound |
| `MANIFEST_INVALID` | missing, oversized or not a closed `myco.plugin/1` manifest; entry not a file |
| `SELFTEST_CASES_FAULT` | `selftestCases()` failed in the sandbox |
| `SELFTEST_CASES_INVALID` | no cases, or a correct document in an undeclared format |
| `SELFTEST_FAILED` | a control did not verify, or a claimed class was not run or not fully caught (an over-claim) |
| `SELFTEST_HARNESS_FAULT` | the sandbox, not the plugin, answered some self-test document |
| `PLUGIN_CHANGED` | the directory changed during registration |

Unclaimed classes are run and reported but do not count; the report is how a gap is made
visible. The example plugin claims five classes; its report shows `corrupt-byte` caught on
only some of the host's flips, which is exactly why it does not claim it. Claiming it is
refused (`test/plugins/registry.test.ts`).

### Corruption classes

From `src/oracle-selftest/types.ts`: value classes `edit-missing`, `wrong-value`,
`wrong-target`, `collateral` (expected `refuted`), and read classes `truncated`,
`corrupt-byte`, `partial-save`, `missing-main-part`, `missing-file` (expected `uncertain`).
Any status other than `verified` is a catch.

## 4. What this is not

- **Not a gate input.** `myco.gate/v1` still takes only `taskId`, `runId` and `claim`; no gate
  module imports plugin code (`test/plugins/sdk-boundary.test.ts`). Using a plugin oracle in the
  gate needs its own scoped, reviewed change.
- **Not R1 evidence.** Plugin verdicts are experiment results, labelled as such.
- **Not the grader.** Plugins never share code with `src/benchmark/grade/`, in either direction
  (`test/benchmark/independence.test.ts`). A measured app family needs its own grader entry,
  written independently of the plugin.
- **Not a live-app reader.** Plugins read saved bytes. Live-app state access is track I; the
  agent-facing tool that would expose a plugin reader to an agent lands with I's `myco-cap`
  server (capability-spec §1.2).

## 5. Tests ($0)

| Test | Proves |
|---|---|
| `test/plugins/protocol.test.ts` | manifest and wire are closed; class list equals R5's |
| `test/plugins/sandbox.test.ts` | no network, no reads outside the plugin, empty env, basename only, every cap, every malformed answer fails closed |
| `test/plugins/registry.test.ts` | self-test required per claimed class; over-claims refused; forged and edited registrations refused; labels |
| `test/plugins/csv-ledger-e2e.test.ts` | scripted agent + example plugin end to end; plugin never verifies where an independent check does not pass |
| `test/plugins/sdk-boundary.test.ts` | SDK loads in the sandbox; no plugin module reaches the gate |
| `test/benchmark/independence.test.ts` | plugins and grader share no code |
