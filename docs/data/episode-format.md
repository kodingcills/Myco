# Episode format: `myco.episode/1`

This is the canonical record of one attempt at one task, saved when the attempt ends.
Each episode holds the task, the agent's actions, what was observed, the gate's verdict,
the ground truth, harness metadata and provenance. It is versioned, closed (unknown fields
are refused), clean by construction, and exportable as a reproducible dataset.

The code lives in:

- `schemas/episode.ts`: the closed JSON Schema for the episode, the store and the dataset manifest.
- `src/episode/types.ts`: the TypeScript types.
- `src/episode/validate.ts`: the full contract (`validateEpisode`).
- `src/episode/clean.ts`: the redaction pass and the refusal scan.
- `src/episode/recorder.ts`: what a transport records into while an attempt runs.
- `src/episode/store.ts`: the local store.
- `src/episode/export.ts` and `src/episode/cli.ts`: export, validate and import.
- Writer hooks: `src/episode/gated.ts`, `src/episode/dry-run.ts` and `src/episode/demo.ts`.

The CLI is `npx tsx scripts/myco-episodes.ts`.

## 1. Schema

The schema is closed at every level (`additionalProperties: false`), on every action
variant and every observation variant too. Adding a field, or adding an enum value that old
readers would refuse, makes a new version (`myco.episode/2`).

| Field | Content |
|---|---|
| `schema` | `"myco.episode/1"` |
| `episodeId` | sha256 of the canonical JSON (sorted keys) of the episode without this field. Episodes are content-addressed. |
| `outcome` | `verified`, `refuted`, `uncertain`, `harness-fault`, `launch-refused` or `unregistrable` |
| `simulated` | `false` only for a real model on a real gated trial (§3) |
| `task` | `id`, `family`, `taskSetVersion`, `faultClass`, `instruction` (redacted text, or null; hashed in an export, §5.1), `instructionSha256`, `fixtureSha256` |
| `actions` | `capture` (`recorded` / `not-recorded`), `truncated`, `items`: at most 1000 typed actions, numbered `seq` 0..n-1. The kinds are `click`, `type`, `key`, `scroll`, `launch`, `wait`, `shell`, `gate-check` and `observe`. Each one carries `atMs` (ms since start, or null). |
| `observations` | `capture`, `withheld` (count of dropped observations), `items`: at most 500. A `screenshot` is a PNG file. A `state` is the `persisted` document, a `ui-tree` or `app-state`, stored as a CSV or JSON file. A `ui-status` is text of at most 200 chars. Files are content-addressed: `blobs/<sha256>.<ext>`, with the hash and byte count recorded. |
| `agentClaim` | `done`, `not-done` or `no-claim` |
| `gate` | null, or `verdict`, `accepted`, `reasonCodes` (stable `myco.gate/v1` codes; null when the path does not see them) and `oracle` (`family`, `version`, `specSha256`, or null). Gate prose (`reasons`) is never captured. |
| `groundTruth` | Either the **independent grader**'s result (`src/benchmark/grade`): `graderVersion`, `status` (pass / fail / ungradable), `targetSatisfied`, `mismatchCount`, `fixtureSha256` and `persistedSha256`. Or `{ source: "none", reason }`, where the reason is `no-independent-grader`, `harness-fault`, `agent-never-ran` or `document-withheld` (the captured document was withheld as unclean, so no grade can be bound to it). The gate's verdict is never ground truth. |
| `harness` | `arm`, `plannerModelId`, `outputCeiling`, `corrections` (on / off), `flags` (`policy`, `handoff`, `assisted`: each a boolean, or null for not applicable), `timing` (`startedAt`, `endedAt`, `wallClockS`, `vmS`), `cost` and `fault` (`class`, `code`, or null). `cost` is `basis` (always *"token-derived estimate at frozen rates; not billed USD"*), `estimateUsd`, `inputTokens` and `outputTokens`. |
| `provenance` | `source` (`gated-trial`, `m2-dry-run`, `demo-mock` or `demo-multistep-mock`), `runId`, `trialKey`, `attemptLedger` (the #518 ledger head, or null) and `writer` (`myco.episode-writer/1`) |

Every timestamp and number field is nullable, and null means *not measured*. A cost is
never 0 for an unmeasured run.

## 2. Guarantees (`validateEpisode`, fail closed)

The schema alone is not the contract. `validateEpisode` also refuses an episode when any of
these rules fails. Each rule has its own test, and each was mutation-proved (see the PR body).

- **Content id.** `episodeId` is the hash of the content.
- **Order.** Actions and observations are numbered in order. An observation can only follow
  an action that exists. A `not-recorded` capture has no items.
- **Outcome.** The outcome is `harness-fault` exactly when a harness fault is recorded. An
  outcome of `verified`, `refuted` or `uncertain` needs the gate's same verdict. `accepted`
  is true exactly when the verdict is `verified`. A `launch-refused` or `unregistrable`
  episode has no gate decision.
- **Ground truth.** A harness-faulted attempt is never graded as an agent outcome. A grade
  is bound to the task's fixture by hash, and to the captured `persisted` document both
  ways: a captured document must be the graded one, and a grade of a document
  (non-null `persistedSha256`) needs that document's `persisted` observation in the
  episode. A document withheld as unclean is therefore never graded: ground truth is
  `document-withheld`, which needs a withheld observation and no `persisted` one. A grade
  with no document is `ungradable`.
- **Simulated label.** `simulated: false` requires a `gated-trial` source and a Claude model
  planner id (the same list as R1's `EVIDENCE_PLANNERS`).
- **Cost.** A non-null `estimateUsd` needs both token counts. The estimate is
  token-derived, never billed USD.
- **Cleanliness and blobs.** The cleanliness scan (§4) runs over every string. Every blob
  must be present and must hash to its name and size. A blob no episode references is
  refused.

## 3. Writer hooks: which runs are saved

| Path on main | Hook | Label |
|---|---|---|
| Gated trial (`runGatedTrial`) | `runGatedTrialWithEpisode` (wraps the call and the transport; the gate is untouched) | real or simulated, by planner |
| M2 R1 dry run (`scripts/m2-r1-dryrun.ts`) | `writeDryRunEpisodes`, writes to `<out>/episodes` automatically | simulated |
| `myco-gate demo --transport mock` (todo-items, calc-multi-step) | `writeDemoEpisodes` / `writeMultiStepDemoEpisodes`, writes to `<out>/episodes` | simulated |

How each ending is labelled:

- **Verified / refuted / uncertain.** The gate's post-stop verdict, labelled as such.
  `uncertain` is its own label, never a success or a failure.
- **Harness fault.** Saved and labelled `harness-fault` with a class, never as an agent
  outcome. This covers five cases:
  - the transport's `runAgent` threw (`transport-error`);
  - the transport's `captureAfterStop` threw (`capture-error`);
  - anything else in the gated trial threw, for example the vault refusing a captured
    file name (`harness-error`). The original error is re-thrown;
  - the gate decided with a harness reason code (`gate-harness-code`). These are the codes
    `src/benchmark/gated-rows.ts` classes as harness: `STATE_MISSING`, `STATE_UNREADABLE`,
    `AUDIT_FAILED`, `FIXTURE_UNREADABLE` and `FIXTURE_MISMATCH`;
  - the caller declared a fault from its trial-ops row, with an M2 harness class.
- **Launch refused.** The launch audit refused the plan, so the agent never ran.
- **Unregistrable.** The gate's registry rejected the task spec (fc-v1 invalid-target).

Writing an episode never changes a trial's outcome or its exit code. A refused episode is
logged in the store's `refused.jsonl` by issue code only, and the result is returned. On the
gated hook, any other error building or writing the episode (a store I/O error, or a caller
callback such as `claim` that throws) is caught and returned as
`{ status: "error", error }` beside the outcome; when the trial itself threw, that original
error is what propagates.

**Realness is the caller's statement.** The gated hook labels an episode real from the
caller's `simulated: false` and planner id; the validator checks only that the planner id is
a Claude model id, not that the transport was a live Claude run. A real store must therefore
be fed only by the live Claude transport (the pilot runner, #524); a mock transport with a
real label would write a real episode.

**Simulated rows never mix with real ones.** A store is real or simulated, fixed in
`STORE.json` when the store is created, and it refuses episodes of the other kind. An export
is real or simulated and refuses a store of the other kind. `validate` refuses a dataset
whose manifest label disagrees with any episode in it. The dry-run and demo hooks refuse a
real store outright.

What each path cannot see:

- **The dry run** reads arm rows. They carry the verdict but not the reason codes, so
  `gate.reasonCodes` is null. The scripted agent's actions are `not-recorded`.
- **The demos** expose no actions. Their families have no independent grader, so ground
  truth is `no-independent-grader`.
- **The gated hook** records actions and frames only if the transport records them into
  the `EpisodeRecorder` it is given.

## 4. Clean by construction: what is never captured

The schema has **no field** for any of the following, and the writers copy named fields only:

- environment variables or an env dump;
- the launch plan's argv, MCP server commands or their env;
- secrets, keys, tokens or credential files;
- absolute host paths, the home directory, the username or the temp directory;
- vault internals: the vault root, the seal, the receipt (`SealReceipt`), the HMAC key or
  the sealed fixtures;
- oracle source or oracle source paths; the hashes of the oracle sources stay in the vault;
- gate prose (`reasons`), since agent-facing output carries codes only;
- the raw Sai ledger and anything under `scripts/sai/`. A store refuses to live under
  `scripts/sai/`, `~/.myco/secrets` or `docs/research/experiments/`, and any stray file in a
  store (a planted ledger, say) fails the read and the export.

Two passes run on top of that:

1. **Redaction** (`redactText`) runs on free text the agent produced or saw: typed text,
   shell commands, UI status and the instruction. The home directory, the temp directory,
   `/<user>` and absolute POSIX, Windows, UNC and `~/` paths become placeholders.
2. **Refusal** (`cleanIssues`, `blobIssues`) runs on every string and every blob of the
   finished episode. Any of these refuses the episode:
   - the planted canary `PLANTED_FAKE_MARKER`;
   - an absolute path;
   - a key-shaped string (`sk-ant-`, `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox?-`, `AIza`,
     `glpat-`, `hf_`, JWTs, `-----BEGIN … PRIVATE KEY`, `Bearer …`);
   - a host identifier.

   Secrets and markers are never scrubbed: one that reaches an episode means a leak path
   exists, and a scrubber guessing a key's extent can leave a piece behind. A structured
   state document that fails the scan is **withheld** (counted in `withheld`), never altered.

**Screenshots** pass only through a `FrameRedactor`, which applies the live watch view's
rules (#513, `src/watch/sanitize-frame.ts`: `sanitizePng` re-encodes the frame from its
pixels, and `frameLeaks` scans the bytes). Until #513 lands there is no redactor on main,
so every screenshot is withheld and counted. The adapter, *(lands with #513)*, is:

```ts
const frameRedactor: FrameRedactor = {
  redact(png) {
    const clean = sanitizePng(Buffer.from(png));
    return clean !== null && !frameLeaks(clean, true, hostNeedles()) ? clean : null;
  },
};
```

What this cannot do: pixels are the frame. A screenshot shows what was on the guest's screen.

## 5. Store, export, validate, import

```text
<store>/STORE.json             { "schema": "myco.episode-store/1", "simulated": true|false }
<store>/episodes/<id>.json     canonical JSON (sorted keys), one episode
<store>/blobs/<sha256>.<ext>   content-addressed screenshots and state
<store>/refused.jsonl          refusals: source, run id, issue codes only
```

```sh
npx tsx scripts/myco-episodes.ts export --from <store> [--from <store> ...] --out <dir> --simulated \
  [--task-set fc-v1] [--arm myco-gate] [--outcome refuted] [--since 2026-11-01] [--until 2026-11-30]
npx tsx scripts/myco-episodes.ts validate --dataset <dir>      # or --store <dir>
npx tsx scripts/myco-episodes.ts import --dataset <dir> --into <store>
```

Exit codes: 0 means OK, 1 means invalid or refused, 3 means a usage error.

A dataset is `manifest.json` plus `episodes/`. It carries **no blobs**: screenshots and
CSV/JSON state are digest-only (§5.1), so `counts.blobs` (blobs carried) is always 0. The manifest (`myco.episode-dataset/1`) holds:

- the schema version;
- the real/simulated label;
- the normalised filter;
- counts by outcome, arm, task set, family and source;
- every file's path, sha256 and size;
- `datasetSha256`, one hash over the file list;
- provenance: the number of distinct runs and the attempt-ledger heads.

The manifest has no timestamps and no host paths. Export is deterministic: the same stores
and filter give a byte-identical dataset, whatever order the stores are given in. Export
validates every source episode first and fails closed. `validate` recomputes everything and
refuses:

- an unlisted, missing or edited file;
- a non-canonical episode file;
- a wrong count;
- an episode outside the filter;
- any `blobs/` entry (a dataset is digest-only);
- an episode with any string outside its field's closed grammar (`OPEN_STRING`, below);
- a manifest filter that fails the export's own filter check (its closed grammars) or carries an
  identity string (`manifest filter: …`, below);
- a mislabelled dataset.

`import` validates the dataset first, then writes into a store of the same kind. An episode that
references a blob cannot be restored from a digest-only dataset, so the store refuses it
(`BLOB_MISSING`). Blob-free episodes round-trip: importing them and exporting the store again
gives the same dataset, byte for byte.

### 5.1 What leaves the machine: the closed allowlist (TIF-265)

The store keeps each episode as written (free text redacted, on the machine that recorded
it). **The export never writes free text.** It writes `closeEpisode(ep)` (`src/episode/closed.ts`),
the closed-schema pattern of #553:

| Field kind | Fields | Exported as |
|---|---|---|
| Closed value | enums, digests, timestamps, blob file names, reason codes, versions, fault codes, and the arm (a known arm, `myco-gate` or `hcu+shell`, optionally with a `:variant` of lower-case letters, digits and hyphens, such as the multi-step demo's `myco-gate:retry`) | as is when it matches its grammar; anything else **refuses the export**, naming the field, never the value |
| Id | `task.id`, `harness.plannerModelId`, `provenance.runId`, `provenance.trialKey` | as is when it matches `CLOSED_ID` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`) and does not start like a hash, else `h-<60 hex>`: an id starting `h-` or `H-` that is not exactly `h-<60 hex>` (`H-<60 HEX>`, `h-<64 hex>`, `h-<59 hex>`) is always re-hashed, and `validateDataset` refuses one (#612 D2, `src/export-guard/hash-like.ts`, the rule track U's container already had) |
| Free text | `task.instruction`, typed text, shell commands, UI status | always `h-<60 hex>` of the raw value |
| Key and app names (F1, lead ruling 22:18Z) | `keys`, `app` (schema cap 64) | as is ONLY from a closed vocabulary: a known key or key combination (`KNOWN_KEYS`: up to three modifiers plus a named key, any case) or a registered app id (`REGISTERED_APPS`: `localc`, `lowriter`, `soffice`, `libreoffice`, `scalc`, `swriter`); anything else `h-<60 hex>` |

**One hashed form** (lead ruling 2026-11-26 23:06Z): every hashed value on every field is
`h-` followed by the first 60 hex digits (240 bits) of sha256 under the domain tag
`myco.episode.export-text/1`. It carries no input text, and it fits the 64-character key and app
cap. No other `h-` string (64 hex, 59 or 61 hex, upper case) counts as already hashed.

**Provenance-bound** (#579 O3; `src/export-guard/provenance.ts`): even an exact `h-<60 hex>` is
kept as is ONLY when the harness produced it, that is when the store's hash ledger
(`<store>/hash-ledger.jsonl`) records it for this episode id at this exact JSON path. Any other
`h-<60 hex>` (an agent typed it, or it sits at another path or in another episode) is re-hashed
like any other value, so an agent cannot hex-encode a path or a name (up to 30 bytes) into a
hashed field, and a hex-letter identity (`cafe`) cannot ride inside one. Only `importDataset`
writes the ledger, after the dataset validated, so export, import, export stays byte-identical. A
malformed ledger line refuses the read. An imported dataset is trusted as harness output: a
dataset written before #579 must be re-exported from its source store, not re-imported. The digest is
unsalted, so equal values stay equal (one run's episodes share a hashed `runId`). A digest does
not reveal its input, but someone who guesses the exact input can confirm the guess. Every string path an
episode can hold is listed in `FIELD_TREATMENT`. A string at any other path refuses the
export, so a new field is a reviewed change. `episodeId` is recomputed over the closed content.
The export filter is closed too (it is written to the manifest).

**Identity checks never skip a closed-pattern value** (#612 D1): the identity check skips an
exact `h-<60 hex>` only in a field the export hashes (an id, a key or app name). In a closed
pattern field (`task.family`, `task.taskSetVersion`, `task.faultClass`, `gate.oracle.family`)
and in the filter, the export never hashes, so a value shaped like `h-<60 hex>` there is checked
like any other value: a hex-letter identity inside it refuses the export, and `validateDataset`
reports it. Track U's container applies the same rule (`src/export-guard/hash-like.ts`).

Why: `redactText` rewrites host paths by pattern, and patterns miss path forms. #553's probe
corpus (spaced folders, `Documents and Settings`, 8.3 short names, UNC, mixed separators,
encoded forms, unicode) put a planted username into 123 of 145 exported datasets before this
change. For example, `C:\Users\First Last\x` was stored as `<path> Last\x`, and the
cleanliness scan cannot see a path in what is left. The scan (§4) still runs over every
exported episode as a backstop. It is no longer what keeps a path out.

**Identity strings are leaks** (lead ruling 2026-11-26 21:52Z; `src/episode/identity.ts`). A host
username, the host name, or a configured identity string (a full name, another account) never
leaves the machine verbatim, in any case, whether alone, in a path or joined to other text:
- free text is always digested;
- an id or token field that holds one (`task.id`, `runId`, `trialKey`, `plannerModelId`, key and
  app names) is digested;
- any other closed pattern field that holds one (task family, task-set id, fault class, oracle
  family and version, grader version, the arm, a fault code), or the export filter (task set and
  arm), refuses the export, naming the JSON path and the class, never the value;
- `validateDataset` refuses a hand-edited dataset carrying one, its manifest filter included.

The sources and thresholds are the shared leak guard's (#560):
- the account name (`os.userInfo().username`), at least 3 characters and not a generic account
  (`root`, `user`, `runner`, `admin`, `ubuntu`, `node`, `nobody`, `vscode`, `codespace`, #560's
  list);
- the host name's first DNS label (`os.hostname()`), at least 4 characters, not `localhost`;
- each line of an optional identity file (`--identity-file <file>`; CRLF and a byte-order mark
  accepted; an unreadable file refuses without naming its path), at least 3 characters.

The host values are read from `os` at export and validate time and are ALWAYS merged into what the
caller passes (#553). Fake host facts, or a short or generic extra name, never switch them off.

Matching is stricter than #560's word match: full Unicode case folding (NFKC, then upper, then
lower case: `ß`/`ẞ` become `ss`, `ı`/`İ` become `i`), then accents stripped on both sides (#579
O2: NFD, combining marks removed, `ø`/`ł`/`æ` transliterated, so `JOSE` matches a configured
`josé` and `rena` matches `reña`), then letters and digits only, by
substring. So joined forms are caught (`<name>_trial`, `<Name>2`, `xx<name>`, `<name>Trial`), a
spaced full name matches `FirstLast`, `first.last`, `first_last` and `First-Last`, and `GROSS`
matches a configured `Groß`. A configured string of several words is also matched by **each
word of 3 or more characters alone** (#580 O1, lead ruling 02:55Z): with `First Last` configured,
`<first>_trial`, `<Last>2`, `xx<first>`, `<first>Trial` and `run<First>` are digested in an id or
token and refused in any other closed field, exactly as Q bundles and the track U container do
(one shared rule, `src/export-guard/identity-words.ts`). Words are split on whitespace; a word of
1 or 2 characters is not looked for alone. Enum values, digests and content-addressed blob names are exempt,
because a match there could only be a false refusal. A harness-produced hashed id or token is kept
as is (the hash ledger above),
so a re-export stays byte-identical. On a CI runner the account is the generic `runner`, so CI
proves the check with planted identities in every field and with an os-mocked test
(`test/episode/identity-os.test.ts`).

**Blobs are digest-only** (lead ruling 2026-11-26 20:3xZ). Screenshots and CSV/JSON state leave
the machine only as the sha256, byte count and content-addressed name their observation already
carries, never as bytes: a captured document can hold a host path the byte scan misses (a
long-path UNC form, say), and a screenshot can show one. Redacted screenshots behind the frame
redactor may come later, in their own reviewed change with a fuzz over frame text.

Cost: a dataset carries no agent text (typed text, commands and UI status are digests) and no
screenshots or documents (digests and sizes only).

### 5.2 Known limits of the identity check (accepted residual risk, #580 O4)

The identity check catches only identities it knows: this host's account and host name, and the
lines of the identity file. It does **not** catch a name nobody configured, when that name sits in
a closed id or version that its grammar admits. Two examples, both kept verbatim today:
- another machine's host name, such as `<name>-MacBook-Pro.local` in `task.id` or a run id,
  when that machine is not this host and `<name>` is not in the identity file;
- a dotted, path-like closed id with an unconfigured name, such as `Users.<name>.Documents` in
  `task.id` or `task.taskSetVersion`.

Free text is always digested, so this concerns only ids, tokens and closed pattern fields. The
remedy is to put every name that may appear (other accounts, other machines, full names) in the
identity file before exporting; once configured, each is caught in all its joined forms and by
each word of 3 or more characters. A test pins this behaviour so this section stays true
(`test/episode/identity-words.test.ts`, "O4 residual"). The same limit applies to the track U
container and to Q bundles. The dataset README states it too
([`docs/data/README.md`](README.md)); no exporter writes that README, so publishing it with a
dataset is a manual release step, and this limit reaches a dataset's users only if the release
includes it.

## 6. How tracks U and Q consume it

Tracks U and Q build in parallel. This format is canonical, and their files are not edited
here. Each switch-over is listed under *TO FILE* in the PR.

- **U (Linux scale dataset export).** Write episodes with
  `EpisodeStore.open(dir, { simulated })` and `store.record(draft, blobs)`, or wrap the Linux
  trial loop in `runGatedTrialWithEpisode` with an `EpisodeRecorder` handed to the
  transport. Export with `myco-episodes export`. Do not define a parallel row format: map any
  Linux-specific field onto `harness`, `task` or `observations`, or propose `myco.episode/2`.
  Linux runs against a model are real only with a Claude planner id. Scripted or fake Linux
  agents are `simulated: true`.
- **Q (replayable proof).** Read the ordered `actions.items` (typed, `seq`-numbered, with
  `atMs`) and the content-addressed `observations` as the replay script and its checkpoints.
  Pin a replay to `episodeId` and, for a dataset, to `datasetSha256`. Check
  `validateDataset(dir)` (or `myco-episodes validate`) before replaying. Bind to the attempt
  ledger through `provenance.attemptLedger` (lands with #518). A replay must not treat
  `groundTruth` as the gate's output, or the gate's verdict as ground truth.
