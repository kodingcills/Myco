# Replayable proof (capability track Q)

Status: M2 capability track Q, Tier 2. Code: `src/proof/`, CLI `scripts/proof.ts`, tests
`test/proof/`. Local only: no network, no model, no VM.

## What it is

A **proof bundle** is one JSON file that records one run so someone else can check it. It
is a tamper-evident **container over the attempt's canonical episode record**, not a second
per-attempt record: `myco.episode/1` (data capture, #542; capability spec part 2, #538 §3) is
the one canonical record of an attempt. The bundle's `run.episode` references that episode by
`episodeId` and sha256 (or is `null` for a run written before episodes exist), its `run` fields
(`runId`, `taskId`, `arm`, `simulated`) are a projection of the episode's, and the rest is Q's
own: the hash chain, evidence digests, the ledger anchor, and handoff and policy decisions.
With `--episode E` the verifier recomputes the episode's id and digest and refuses any
projected field that disagrees (`PROOF_EPISODE`). The digest is over the episode's canonical
JSON without the trailing newline #542's store appends, not over the file's bytes. Without
`--episode`, a bundle that references an episode still verifies, but the reference is **not
cross-checked**: the result says `episodeChecked: false` and the report says "reference only:
not checked here". The bundle never copies the episode's other groups (ground truth, agent
claim, provenance, observations).

The bundle carries:

- the ordered **actions** (agent or harness, tool, a redacted summary);
- the **gate verdicts** (`myco.gate/v1`: verdict, `accepted`, reason **codes** only, never
  free-text reasons) and the evidence each verdict cites;
- **evidence digests** (sha256 and byte count of each artifact; small clean text inlined);
- **checkpoints** of multi-step tasks;
- **handoffs** between agents or sessions (shape lands with track N);
- **policy decisions** (allow / deny / ask, with a code; shape lands with track O);
- a **ledger anchor** and the **attempt ledger** itself (#518's `attempts.jsonl` events,
  verbatim), binding the run to its start and end events and to the ledger head.

Every record is hash-chained: `prevSha256` is the sha256 of the previous record's canonical
JSON (sorted keys). The first record's `prevSha256` is the sha256 of the canonical `run`
header, so the run's ids, arm, `simulated` flag and episode reference are covered by the chain
and the head. The bundle pins its head (record count, last hash). Apart from that genesis, this
is the attempt ledger's construction (#518).

The ledger anchor binds the run to one trial of the ledger: that trial's single start and end
events, which must carry the run's task and the run's arm (an anchored run must state its arm;
`hcu+shell` is a valid arm). It does not bind the run id, because the ledger has none.

```
npx tsx scripts/proof.ts export RUN.json --out bundle.json [--forbid-file F] [--user-file U]
npx tsx scripts/proof.ts verify bundle.json [--evidence-dir D] [--episode E] [--expect-head H] [--expect-ledger-head H] [--user-file U]
npx tsx scripts/proof.ts report bundle.json --out report.html [verify flags]
```

Exit codes: 0 ok, 1 refused, 2 usage. `RUN.json` is a `ProofRunInput` (`src/proof/bundle.ts`)
written by the harness, never by the agent. `RUN.json` may name `episodeFile`, the attempt's
episode. `--forbid-file` lines are extra literals to redact and refuse; export registers no
secret values of its own (it redacts the host's home, temp and checkout directories, its
account name, every forbid-file line, and the generic shapes), so put secret values in the
forbid file too. `--user-file` lines are account names to redact and refuse as whole words in
any letter case: register the guest's account name there (the exporting host's own account is
registered automatically). Neither file's contents are ever printed.

## The verifier

`verify` recomputes every record hash and chain link, the head, every inline evidence digest,
every digest-only artifact when `--evidence-dir` points at the run's evidence, and the whole
attempt ledger. It refuses (exit 1, a code per error) on:

| Code | Cause |
|---|---|
| `PROOF_CHAIN` | an edited, removed or reordered record, or an edited `run` header (the chain breaks) |
| `PROOF_GAP` | a `seq` that is not the record's index (a gap or a reorder) |
| `PROOF_TRUNCATED` | the records do not reach the pinned head (tail cut or extended) |
| `PROOF_SCHEMA` | not JSON, or any unknown field, wrong type, non-code reason, or absolute or escaping evidence path |
| `PROOF_CLAIM` | the claim is not the fixed statement below (no stronger claim) |
| `PROOF_EVIDENCE` / `PROOF_EVIDENCE_DIGEST` / `PROOF_EVIDENCE_MISSING` | an inlined frame, a duplicate id, content that does not match its digest, an original file that changed or is missing |
| `PROOF_VERDICT` | `accepted` without `verified`, `verified` without `ORACLE_PASS` or `ORACLE_PASS` without `verified`, a verdict for another task or run, or citing evidence not recorded before it |
| `PROOF_LEDGER_CHAIN` / `PROOF_LEDGER_HEAD` / `PROOF_LEDGER_ANCHOR` | an edited, reordered or truncated ledger; a ledger event outside #518's schema (unknown field, unknown arm, a start with an outcome, an end without one, a harness class without `harness-fault` or the reverse); a ledger with no anchor or an anchor with no ledger; an anchor that does not point at exactly one start and one end of the run's trial, for the run's task and arm |
| `PROOF_EPISODE` | with `--episode`: an episode whose id is not its content hash, that differs from `run.episode`, whose run id, task, arm, simulated flag or trial key differs from the bundle's, or an episode given for a bundle that references none |
| `PROOF_ANCHOR_MISMATCH` | a head differs from the one given out of band |
| `PROOF_REDACTION` | any parsed string value or key of the bundle carries a secret, an absolute host path, a `~user` home, or a forbidden literal, in any decoded form |

The exporter runs the same verifier on what it built and refuses to write a bundle that would
not verify. The report refuses to render one, and refuses to return HTML that its own scan
finds a leak in. The CLI scans each line it prints and prints only error codes if one would
leak.

## Security model (stated plainly)

**Tamper-evident, not tamper-proof.** The claim every bundle carries, and the only claim the
verifier accepts, is:

> Tamper-evident, not tamper-proof: any edit, gap, reordering or truncation of these records or
> of the attempt ledger they carry is detected when checked against the heads pinned here (the
> attempt ledger's guarantee, #518, and no more). The trusted harness that wrote the run is the
> boundary: the chains are unkeyed and unsigned, so whoever can write the whole bundle can
> regenerate a consistent one; only a head received out of band detects that.

So:

- **The trusted harness is the boundary.** The bundle proves that what you hold is what the
  harness wrote, as far as partial changes go. It does not prove the harness recorded honestly.
- **Whole-bundle regeneration is not detected** unless you check a head you received separately
  (`--expect-head`, `--expect-ledger-head`; for example the pack's ledger pin recorded
  host-side). A test pins this limit ("STATED LIMIT") so it stays visible.
- **Nothing is signed or keyed.** Rewrite resistance (a signed or externally anchored head) is
  the same open decision as #518's and is not built here.
- **Simulated runs are never evidence.** `run.simulated` is covered by the chain (the run
  header seeds it); the verifier reports it and the report shows a banner.
- **The gate is unchanged.** The bundle is built after the run from the harness's own records.
  The agent still supplies only `taskId`, `runId` and `claim`; nothing here is a new gate input.

### Redaction

The aim is that no secret, absolute host path, username or vault key is in a bundle or
report. What is enforced is exactly the shapes and registered literals below; anything
outside them is a stated limit (item 5), not a guarantee.

1. The exporter rewrites every string: registered literals first (secret values, vault keys,
   the host's home, temp and checkout directories), then generic shapes (POSIX, Windows drive,
   UNC and rootless backslash paths, network file URLs, `~user` homes, `file:` URLs, private
   keys, bearer and vendor key shapes, `key=value` credentials), then the account-name shapes
   and the registered account names. A token that still leaks once decoded is replaced whole.
   - Every scan also runs over each **decoded form** of the string: JSON escapes (`\/`, `\t`,
     `\u002f`), percent-encoding (`%2F`) and HTML entities (`&#47;`), stacked up to three deep.
   - A path is not recognised by an allow-list of characters before it (any character left off
     such a list bypasses it). A generic absolute path is skipped only when it continues a word
     or a relative path. **Home roots have no such exception:** `Users`, `home`, `root`,
     `Documents and Settings` or its 8.3 name `DOCUME~N`, followed by a separator and a segment
     (either separator, any case), and `var/folders`, are a host path after any
     non-alphanumeric character, so `.../home/a`, `../../Users/a`, `v2/Users/a`,
     `build-/home/a`, `/Users\a` and drive-relative `C:Users\a` are all caught.
   - **The user segment after a home root may contain spaces** (`C:\Users\First Last\x`), as
     may every segment of a Windows drive path (`D:\Profiles\First Last\x`), of a UNC path
     after the host, and of a network file URL. A user segment runs to the next separator and
     stops only at a character no account name may contain. A share or folder segment (drive,
     UNC, network URL) also runs on through `, ; = + [ ]`, which a Windows folder or share name
     may contain (`\\nas\homes\Last, First`), and stops at a separator, a line break, a tab or
     one of `" < > | : * ?`. **The UNC shape covers the whole
     class:** `\\nas\homes\First Last`, either or mixed separators (`\\nas/homes/a`,
     `//nas/a`), the long-path and device prefixes (`\\?\UNC\nas\a`, `\\.\UNC\nas\a`,
     `\\?\C:\Users\a`), double-escaped backslashes, a UNC path after a `:` such as
     PowerShell's provider-qualified path (`FileSystem::\\nas\homes\First Last`, as
     `Get-Location` prints it), and every encoded form of each. A slash pair directly after a
     URL scheme (`letters:`) is not a UNC host, so `https://host/x` stays; the network file
     schemes `file`, `smb`, `cifs`, `afp`, `nfs`, `webdav`, `dav(s)` and `(s)ftp(s)` are caught
     with spaces in every segment and any run of separators after the colon
     (`file://nas/homes/First Last/x`, `file://///nas/homes/First Last`,
     `file:///srv/First Last/x`). These
     whitespace-tolerant shapes run **before** the drive, backslash and POSIX shapes, which stop
     at whitespace: run after them, the part before the space is replaced and the surname is
     left with no root to flag it. For the same reason, a string whose **decoded** form holds
     such a path with whitespace in it (`C:\u005cUsers\u005cFirst Last`,
     `%5C%5Cnas%5CFirst Last`) is replaced whole.
   - **Usernames are caught in exactly these forms:** a registered account name (the
     exporting host's own, and every `--user-file` line) as a whole word in **any letter
     case**; `DOMAIN\user` as `whoami` and Windows prompts print it (a domain of letters,
     digits, `.` and `-`, a backslash, then a user segment that may contain spaces); `user@host`
     as POSIX prompts, `scp` and e-mail print it; and a user folder inside any path shape
     above. These over-match too: a relative `dir\file`, a literal `word\nword` escape, an
     e-mail address or `git@host` is redacted.
   - This over-matches (`src/home/x`, or the rest of a sentence after `C:\Users\`, is redacted
     too). It is not a proof that nothing identifying can get through: see the limits below.
     Vendor key prefixes may follow anything but a letter.
2. Evidence text is inlined only if redaction would leave it byte-identical, so an inline
   digest is always the original artifact's. Otherwise it is digest-only (`withheld:
   "redaction"`).
3. **Screenshots and frames are never inlined**, only their digests (`withheld: "frame"`). The
   watch view has no merged pixel-redaction rules, and this track does not invent them.
4. Every output is scanned before it is written: the bundle by the verifier (every parsed value
   and key), the report's final HTML by the renderer, and the CLI's own output. A leak that
   survives step 1 and that a scanner recognises stops the export or the report. It is never
   written. Leak reports name kinds and offsets, never the value.
5. **Limits.** The scanners recognise shapes and registered literals, so they cannot flag a
   fragment that no longer looks like a path (which is why step 1's order matters). Not caught
   today:
   - an account name that is not registered and is not in one of the forms above, such as a
     name written in plain prose (`logged in as Alice`) or after a prompt with no `@`;
   - a spaced folder in a **POSIX** path outside the home roots (`/srv/First Last/x` keeps
     `Last/x`): only home roots, Windows drive, UNC and network-URL segments may span spaces;
   - a URL whose scheme is not one of the network file schemes above
     (`dest://nas/homes/First Last`): it is read as an ordinary URL and not flagged;
   - a `DOMAIN\user` with `_`, `:`, `.`, `-` or a separator directly before the domain
     (`x_CORP\user`), and a `user@host` whose host does not start with a letter
     (`a@10.0.0.1`);
   - obfuscated or invalid forms (a soft hyphen inside `Users`, a fullwidth `／`, a tab inside
     `Documents and Settings` or inside a UNC folder name, a bracketed IPv6 "UNC" host), and
     paths outside the home roots behind a character the generic shape skips
     (`run.../tmp/x/y`).
   These are hardening items for the shared scanner (TO FILE).

Planted-marker tests (`test/proof/redaction.test.ts`) plant fake secrets, key shapes, a vault
key (plain and percent-encoded), a username and macOS, Linux and Windows home paths in every
free-text field and in evidence fixture files. They assert none reach the bundle or the
report. One test per scanner bypass (JSON-escaped, percent-encoded and entity-encoded paths,
backslash and UNC paths, `~user` homes, leading-character bypasses, and each home root after a
`.`, `-`, digit, letter or `/`, mixed separators and drive-relative forms) asserts each is
found, redacted, refused by the verifier and absent from an export, and the report refuses to
render each.

TO FILE: consolidate this scanner and #542's episode cleanliness scan onto one canonical
scanner once #542 merges, with a parity test over the bypass corpus.

### The report

`report` writes one static HTML file: no script, no link, no image, no remote URL, a
`default-src 'none'` CSP, and every value HTML-escaped. Replay is read-only and needs no
server, so there is nothing to bind to loopback.

The renderer takes a bundle and a verification result. It renders only a passing result
that belongs to that bundle: the result's head must name the same record count, and the chain
recomputed from the bundle's run header over its records must end at that head. A passing
result for another bundle, or for these records before an edit, is refused. The CLI always
passes the result of verifying the same bytes.

## Dependencies

- **#542 (`myco.episode/1`), open.** `src/proof/episode-ref.ts` mirrors only the episode
  fields Q reads (`EPISODE_FIELDS_USED`, pinned by `test/proof/episode-ref.test.ts`) and #542's
  id rule, and does not import #542. TO FILE: switch to #542's `Episode` type, `episodeIdOf` and
  `validateEpisode` once it merges; then make `run.episode` required and project the action and
  evidence records from the episode's actions and observations instead of `RUN.json` steps.
- **#518 (attempt ledger), open.** `src/proof/ledger.ts` re-states its documented format (event
  schema, canonical JSON, genesis, head) and does not import it. TO FILE: bind to #518's final
  `verifyAttemptLedger` and `eventSha256` once it merges, with a parity test.
- **Track N (handoffs), track O (policy decisions), in flight.** The bundle defines minimal
  closed shapes (`HandoffBody`, `PolicyBody`). The record kinds land with N and O: their
  records map onto these shapes, never the reverse. TO FILE: once `myco.episode/1` carries the
  handoff log (N, #528's `handoffs` field) and policy decisions (O), the bundle references them
  through the episode instead of restating them.
- **Live runner wiring.** The live harness must write `RUN.json` as the trial runs. That needs
  the VM, so it is out of this PR.

## Proposed pre-registered measurement bar (for `docs/product/capability-spec.md`)

Proposed for the capability spec to adopt or amend before any measurement run. The runs need
the integrity fixes and the lead's GO, on Claude Ultra. This PR runs none.

**Arms.** Myco (gate + proof bundle) against the two baselines: **C1** (screenshot-only; its
shareable record is the screenshot trail and transcript) and **hcu+shell** (its record is the
transcript and shell log). The tasks and trials are the same for every arm, paired by trial.

**Ground truth.** The **independent grader** (`src/benchmark/grade`, no code shared with the
gate) grades each trial's persisted bytes. Simulated rows never count.

**Q1, integrity (deterministic, no model, all-or-nothing).** Over every bundle from the
measurement run (n ≥ 30):

- 100% verify;
- 100% of a pre-registered tamper battery is refused. The battery is edit, delete, swap and
  truncate at every record position, plus ledger edit, reorder and truncate, plus an evidence
  file swap: at least 300 cases;
- 0 planted-marker leaks.

A single miss fails Q1. With 0 misses in 300 cases, the exact one-sided 95% upper bound on the
miss rate is about 1%.

**Q2, audit value over baseline (secondary; capability spec part 2 keeps Q1 as Q's acceptance
bar).**

- **Paired unit.** A *slot* is one pre-registered seeded task instance (task id plus seed,
  seeded with silent-drop tasks of the df-s02 kind). Every slot is run once under each arm.
  For the comparison of Myco with baseline B, a slot is a **pair** when, in BOTH arms' runs of
  that slot, the agent claimed done and the independent grader says not done (false success
  in both). Only pairs enter the test; a slot that is a false success in one arm only is
  reported but does not enter it.
- **Measure.** For each run in a pair, a blind auditor sees only that arm's shareable record
  (Myco: the verified bundle; C1: the screenshot trail and transcript; hcu+shell: the
  transcript and shell log), applies a fixed rubric, and answers "done" or "not done". The
  auditor does not know the arm where the format allows. The run is a success when the answer
  matches the grader's outcome. For Myco the answer must also be machine-checkable: a verified
  bundle whose verdict is `refuted` or `uncertain`.
- **Sample size and stopping.** Run slots until each comparison has at least 40 pairs, up to a
  pre-registered cap of 200 slots. If the cap is reached with fewer than 40 pairs for a
  comparison, that comparison fails (underpowered); the test is not switched afterwards.
- **Test.** Exact McNemar on the pairs' discordant outcomes (Myco success and B failure against
  the reverse), one-sided α = 0.05, Myco against C1 and Myco against hcu+shell, with Holm
  correction over the 2 comparisons.
- **Pass.** Both comparisons significant, and Myco's false-VERIFIED rate (the record shows done
  but the grader says not done) is 0.

**Cost.** Export and verify make no model calls, so the R7 numerator gains no tokens. R7 is
unchanged: total cost of all trials divided by verified trials, a token-derived estimate, null
cost never 0.
