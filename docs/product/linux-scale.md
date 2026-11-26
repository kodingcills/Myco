# Linux scale track: disposable desktops and verified datasets (track U)

**Status: design plus the non-VM parts, pre-measurement.** This page covers capability track U,
"Linux scale track", merged with the "Lightweight agent desktops" roadmap item. Nothing here
has been measured, and no result is claimed. The microVM runtime needs KVM and Firecracker on
a host, so it is not in this change. It is listed under [TO FILE](#10-to-file-local-single-owner).

**Goal (Tiffany, 2026-11-26 10:29 / 10:41 ET):** microVM-based disposable Linux desktops for
massive parallelism, data collection, and training and eval environments for labs. Every run
is verified and can be exported as a clean dataset.

**What this change ships, all runnable in CI at $0** (no model, no VM, no network):

| Part | Where |
|---|---|
| Backend interface: create, run, capture persisted bytes, destroy | `src/desktops/backend.ts` |
| Local-process backend (the CI implementation) | `src/desktops/local-process.ts` |
| Parallel fleet runner with a per-desktop canary contamination scan | `src/desktops/fleet.ts` |
| Agent step protocol: `myco.episode/1` actions and status text on stdout (interim stand-in for #542's episode recorder) | `src/desktops/transcript.ts` |
| Mirror of the canonical episode record `myco.episode/1` (#538 §3, #542), plus an interim episode writer | `src/dataset/episode.ts` |
| Dataset exporter (a container over episodes), leak scan, schema | `src/dataset/export.ts`, `src/dataset/hygiene.ts`, `schemas/dataset-export.ts` |
| Tests, including a scripted end-to-end run | `test/desktops/`, `test/dataset/` |
| Mutation proofs of every guard | `scripts/desktops-mutation-proof.sh` |

---

## 1. How it fits with the roadmap item and track L

- **The "Lightweight agent desktops" roadmap item** (`docs/product/vision.md`) asked for
  fast-booting, low-memory, disposable Linux desktop VMs as the base for the Linux path and for
  later hosting. It also asked a research question: compare boot time, memory per desktop,
  reset time, and GUI and screenshot support with today's QEMU path. Track U is that item. The
  research question becomes U's infrastructure measurement (§9, U-infra, run under TO FILE).
  The vision placed the item after the demo. Tiffany's 10:41 ET override makes all capability
  tracks M2 scope now, so U is designed and its non-VM parts are built now. It still does not
  block the M2 tracks A to H or the integrity fixes.
- **Track L, "Safe parallelism"** (`docs/product/capability-spec.md` §L, which lands with the
  spec PR) measures throughput at N = 4 against N = 1 with zero cross-trial contamination. U
  supplies the substrate L measures on. That covers the desktop per trial, the fleet runner,
  and the contamination check L names as its guardrail (a unique canary per desktop, scanned
  for in every other trial's capture and output). L-infra's 200-trial zero-contamination run is
  `runFleet` with the microVM backend.
- **Track M, "Learning from verified outcomes"** stores skills only from verified runs. U's
  exporter applies the same rule to datasets: only gate-verified, grader-passed runs are
  positives.
- **The canonical episode format, `myco.episode/1`** (spec part 2, #538 §3; built by the
  data-capture PR #542) is the ONE per-attempt record. M's skill store and U's export are both
  built from it. U defines no competing record: its dataset is a container over episodes
  (§6). Until #542 merges, U mirrors the episode type and schema in `src/dataset/episode.ts`
  (pinned to a #542 head by `test/dataset/episode-mirror.test.ts`, which runs #542's own
  schema and `validateEpisode`, vendored under `test/fixtures/episode-542/`, against the
  mirror and against every episode U exports) and drafts episodes with an
  interim writer; the step protocol (`src/desktops/transcript.ts`) emits episode actions
  directly. Both are replaced by #542's code when it merges (§10).
- **The Linux path** (`docs/product/linux-path.md`, `src/linux/`) is today's single-desktop,
  headless Calc loop. The microVM image runs the same actuator inside a desktop.
  `src/desktops` does not import `src/linux`; the image is where the two meet.

## 2. The microVM image: `myco-linux-desktop/1`

A minimal Linux desktop with LibreOffice, built reproducibly and pinned by digest.

| Layer | Choice | Why |
|---|---|---|
| Kernel | A minimal guest kernel: virtio-blk, virtio-vsock, no virtio-net driver needed, no modules | Fast boot; a small attack surface |
| Root file system | Debian stable slim (glibc, which LibreOffice needs), read-only ext4 image | Shared by every desktop; never written |
| Writable layer | A per-desktop overlay disk (copy-on-write over the root image), thrown away at destroy | Disposable; no state carries between trials |
| Display | Xvfb (a virtual framebuffer) plus a minimal window manager, at a fixed resolution | Screenshots for C1-style agents; no GPU |
| Apps | LibreOffice Calc plus `python3-uno`, the same packages the Linux path's CI job installs | One set of app bytes for the gate, the grader and the agent |
| Guest agent | A small static binary on vsock: run a program, take a screenshot, report ready. It never reads or writes the evidence. | The only channel between host and guest |
| Not present | sshd, a network stack configured for any interface, package managers at runtime, host-shared folders | Isolation (§5) |

The image build is a script that outputs the kernel, the root image and a manifest. The
manifest holds the SHA-256 of each and the package list with versions. A desktop's
`DesktopSpec.image` names the manifest id, and every exported record carries it
(`desktop.image`).

## 3. Boot, snapshot and restore

1. **Build once:** kernel plus root image.
2. **Warm once per image:** cold-boot a desktop. Start Xvfb and LibreOffice headless until the
   guest agent reports ready, then take a Firecracker snapshot (guest memory plus device state).
   The snapshot's digest goes into the image manifest.
3. **Create = restore.** Each desktop restores from the warm snapshot. Guest memory is mapped
   copy-on-write, so N desktops share the unmodified pages. Each desktop gets a fresh overlay
   disk and a vsock. After restore, the guest agent reseeds the kernel RNG (VM generation ID)
   and sets the clock, so no two desktops share random state or a stale time.
4. **Seed:** the harness writes the task's files into the overlay before the agent starts,
   through the guest agent (`DesktopSpec.seed`; relative paths only, checked on the host).
5. **Run:** the agent drives the desktop. Under the step protocol (`src/desktops/transcript.ts`)
   it reports each action (already a `myco.episode/1` action) and its status text. The harness
   drafts the attempt's episode from that, the gate record and the grade.
6. **Capture after stop.** The harness stops the VM, then reads the persisted document from
   the overlay disk on the host. The read is relative-path only, refuses symlinks and
   non-regular files, and is size-capped (`capture`). The agent cannot change the bytes after
   the capture, because the VM is no longer running. This is the per-trial persisted-bytes
   capture the gate and the grader each read.
7. **Destroy:** delete the overlay and the VM's jail directory. **Reset is always
   destroy-plus-restore.** A desktop is never reused for a second trial.

## 4. The backend interface

`DesktopBackend` (`src/desktops/backend.ts`) is the seam. A microVM backend implements the same
five members as the CI backend:

```ts
interface DesktopBackend {
  readonly kind: string;               // "local-process/1", later "firecracker/1"
  readonly isolation: "process" | "container" | "microvm";
  readonly enforcesNetworkOff: boolean;
  create(spec: DesktopSpec): Promise<DesktopHandle>;     // network must be "off"
  run(handle, { argv, timeoutMs }): Promise<RunResult>;
  capture(handle, relativePath): Promise<CapturedBytes | null>;  // bytes + sha256
  destroy(handle): Promise<void>;                        // idempotent
}
```

Every backend must keep these guarantees (pinned in `test/desktops/backend.test.ts`):

- Network is off: `create` refuses any spec whose `network` is not `"off"` (`NETWORK_NOT_OFF`).
- Seed and capture paths are relative and normalised and stay inside the desktop. `..`, `.`,
  absolute paths, backslashes and hidden names are refused (`PATH_ESCAPE`, `BAD_PATH`).
- `capture` never follows a symlink, in any path component (`SYMLINK_REFUSED`). It refuses
  directories and FIFOs (`NOT_REGULAR_FILE`) and refuses anything over the size cap
  (`CAPTURE_TOO_LARGE`). It never truncates.
- A program in the desktop does not inherit the host environment. It sees `LANG`, `TZ`, a
  fixed system `PATH` (`DESKTOP_PATH`, never the host's, which can name host home
  directories), its own `HOME` and its own `TMPDIR`, and nothing else. One exception is not
  the backend's to remove: macOS adds `__CF_USER_TEXT_ENCODING` (`0x<uid>:0x<enc>:0x<region>`,
  no path or name) to every child process, whatever environment it is spawned with. The
  test allows that one key on darwin only, and only in that shape.
- A file that changes while it is captured is refused (`CAPTURE_CHANGED`), never captured
  partially.
- A handle answers only for its own desktop. Calls after `destroy`, forged handles and other
  backends' handles are refused.
- Output has the desktop's host root replaced by `<home>` and `<desktop>` placeholders.
  Errors are codes only (`DesktopError.code`), never a path or a value.

The **local-process backend** keeps all of these. It is honest about what it does not
provide: `isolation: "process"` and `enforcesNetworkOff: false`. A program can still read the
host file system and open sockets. The snoop test shows this: an agent reads its neighbour's
canary, and the fleet's contamination scan catches it. The local-process backend is the
reference for the interface and for $0 tests. It is not a security boundary.

The **fleet runner** (`runFleet`) runs trials on any backend with a concurrency cap. It
refuses duplicate trial keys, run ids or canaries before any desktop starts. It always
destroys each desktop, and it reports contamination events.

## 5. Security model

| Threat | microVM backend (TO FILE) | local-process backend (CI) |
|---|---|---|
| The agent reads another trial's files | A separate VM per trial, a separate overlay, no shared folders. Canary scan as detector. | **Not prevented.** Detected by the canary scan (`FleetResult.clean = false`). |
| The agent reaches the network (exfiltration, outside help) | No network device is attached. `network: "off"` is the only accepted value. | **Not enforced** (`enforcesNetworkOff: false`, recorded per run). The proxy and host firewall apply. |
| The agent reads host secrets through the environment | The guest has no host environment. | The allowlisted environment only (tested with a planted variable). |
| The agent changes the document after the capture | The capture happens after the VM stops. | The capture happens after the program exits. Nothing runs in the desktop afterwards. |
| The agent tricks the capture with a symlink, FIFO or huge file | Host-side reads refuse these. | Same code: `capture` refuses them. |
| The agent influences the verdict | The gate request stays `taskId`/`runId`/`claim` only. The gate is bound to one trial. The desktop has no reach to the evidence root, vault or audit log. | Same. `src/desktops` and `src/dataset` import nothing from the gate, the grader or the task generators (`test/desktops/import-boundary.test.ts`). |
| Host breakout | KVM plus the Firecracker jailer (chroot, unprivileged uid, cgroups, seccomp). | Out of scope: not a boundary. |
| A dataset leaks secrets, host paths or user names | §6: the exporter refuses the whole export. | Same exporter. |

None of this changes a gate guarantee. The gate still takes only `taskId`, `runId` and
`claim`, is bound to one trial, fails closed, gives codes-only agent-facing reasons, and stays
CSV-only for Calc until the xlsx replacement lands. The grader stays independent. R1 evidence
rules and R7 are untouched. Rows from a scripted agent are simulated and never count as
evidence.

## 6. Dataset export

The dataset is built FROM canonical `myco.episode/1` records: it is a container over episodes,
not a second per-attempt format. `exportDataset` (`src/dataset/export.ts`) takes, per attempt,
the episode, the raw gate result (to bind the episode's gate record to its trial), the
captured CSV bytes (to bind the grade, and carried as the episode's document blob), the task
set's declared fixture digest, and U's desktop facts. It writes one directory:

- `episodes/<episodeId>.json`: each exported episode, copied byte for byte as canonical JSON.
  Steps (actions and observations), the claim, the gate verdict (codes only), the
  independent grader's ground truth, harness metadata, provenance and the `simulated` flag
  live here, and only here.
- `blobs/<sha256>.csv`: the persisted document each exported episode graded, byte for byte,
  named by its digest. #542 requires a graded episode to observe the document it graded (a
  `state` / `persisted` / `text/csv` observation whose hash is `groundTruth.persistedSha256`),
  so the container carries it; every exported episode passes #542's `validateEpisode` with
  these blobs. Two attempts that saved identical bytes share one blob.
- `records.jsonl`: one `myco.dataset.record/3` per exported episode, sorted by episode id. A
  record references its episode by id and digest (`episode.id`, `episode.sha256`,
  `episode.file`) and carries only U's own fields: the `label` (`positive` / `negative`), the
  desktop facts (`backend`, `isolation`, `networkEnforced`, `image`) and where the capture was
  taken (`capture.path`, `format`, `size`; the digest is the episode's
  `groundTruth.persistedSha256`).
- `manifest.json`: `myco.dataset.manifest/3`. It holds counts (candidates, records,
  positives, negatives, simulated, and excluded episodes by code), each record's SHA-256, the
  SHA-256 of `records.jsonl` and `schema.json`, each blob's file, SHA-256 and size, and the
  episode format with the #542 head the
  mirror was taken from. It always has `evidence: false`: a dataset is never scorecard
  evidence.
- `schema.json`: the record and manifest schemas plus the mirrored episode schema, so a
  consumer can validate without this repo.

**Which manifest a consumer trusts.** U's `manifest.json` describes U's container: which
episodes were selected, with which label, on which desktop. Each episode inside is a
`myco.episode/1` record a consumer can re-validate with #542's `validateEpisode`, blobs
included. #542's own `myco-episodes export` (`myco.episode-dataset/1`) is a separate, flat
export of episodes; U's container neither wraps nor replaces it. Both reference the same
episodes by the same content id.

**Which episodes are exported** (fail closed):

| Gate (raw result bound to this task and run, equal to the episode's gate record) | Ground truth (independent grader, graded these exact bytes against the declared fixture) | Claim | Result |
|---|---|---|---|
| verified, accepted | pass | done | **positive** |
| verified, accepted | pass | not-done or no-claim | excluded `NOT_CLAIMED` (correct, not claimed) |
| refuted | fail | any | **negative** if `includeNegatives`, else excluded `NEGATIVES_NOT_REQUESTED` |
| verified | fail | any | excluded `GATE_GRADER_DISAGREE` (a false VERIFIED; never exported) |
| refuted | pass | any | excluded `GATE_GRADER_DISAGREE` |
| uncertain | any | any | excluded `GATE_UNCERTAIN` |
| any | ungradable | any | excluded `GRADE_UNGRADABLE` |
| missing, malformed, or for another task or run | | | excluded `MISSING_GATE`, `GATE_MALFORMED`, `GATE_NOT_BOUND` |
| differs from the episode's gate record | | | excluded `GATE_EPISODE_MISMATCH` |
| | missing (`source: "none"`), or for other bytes or another fixture | | excluded `MISSING_GRADE`, `GRADE_NOT_BOUND` |
| no capture | | | excluded `MISSING_CAPTURE` |

The exporter recomputes the captured bytes' digest itself. It never trusts the digest a
caller hands it.

**What refuses the whole export.** Nothing is written, and the output directory never appears:

- `EPISODE_INVALID`: an episode that fails the mirrored `myco.episode/1` contract, which is
  every rule of #542's `validateEpisode` at the pinned head: the closed schema (a smuggled
  field such as gate prose or an env dump is refused, never passed through), the content id,
  action and observation order (`not-recorded` carries no items), outcome agreement (with
  the gate verdict, `accepted`, and a recorded harness fault), ground truth (a graded
  document is observed in the episode and is the captured one; `document-withheld` needs a
  withheld observation; a harness fault carries no grade; the grade is against the task's
  fixture), and cost (an estimate needs token counts). An exported episode must also pass
  #542's blob rules with the blob the container writes. U is stricter on blobs: it carries
  one persisted CSV document per episode, and refuses a screenshot or any other state blob
  (§10).
- `LEAK`: a host path, the machine's user or host name, #542's planted marker, an
  operator-named string, or a secret-shaped string anywhere in ANY output file (episodes,
  records, manifest, schema and blobs), in keys as well as values. A blob that is not UTF-8
  text cannot be scanned and is refused (`unscannable`). Every string is scanned as written
  and after decoding Unicode look-alikes (NFKC fullwidth forms, other slash glyphs,
  zero-width characters), shell and C escapes (`\x2f`, `\057`, `\u{2f}`), JSON escapes
  (`\/`, `\uXXXX`), percent escapes (also double-encoded) and HTML entities. Any absolute
  POSIX path of two or more segments is a host path, whatever its root (a root list is never
  complete: `/github/workspace` and `/__w/repo` are real CI paths), and so is a single-segment
  path under a known root. Host paths also include POSIX roots (a home root such as `/home/x` or `/Users/x` is matched even
  mid-token; system roots after any character that cannot end a relative path segment, so
  `>/tmp/x`, `-f/etc/x` and `2>/dev/null` are refused), Windows drive paths with either
  separator, UNC and backslash home paths, `file:` URLs, `~/` and `~user/`, and `$HOME` or
  `%USERPROFILE%` spellings. The username and hostname come from the machine by default and
  can be injected (`HygieneOptions.identity`); tests plant them, because a CI runner's own
  identity (`runner`) is too generic to scan for. The exporter never redacts. A refusal names
  the file and the JSON path, never the value.
- `SIMULATED_UNLABELLED`: a scripted or unknown planner (`plannerModelId` null or not one of
  #542's real planner ids) or any source other than `gated-trial` whose episode is not
  labelled `simulated: true`. This applies to excluded
  episodes too.
- `DUPLICATE_TRIAL` (trial key, run id or episode id), `SCHEMA_INVALID`, `OUT_EXISTS`.

**Fixture and vault contents.** The fixture is recorded by digest, never copied. The captured
document is carried as a blob (#542 requires it), so a marker planted in the fixture that
survives into the saved document refuses the export at that blob, as does an agent that
echoes it into its transcript (`test/desktops/e2e.test.ts`). The exporter never
reads the environment. It cannot know the value of a real secret, so it scans for secret
shapes. A vault value that does not look like a secret is caught only if the operator names
it: `forbiddenStringsFromFiles(paths)` (`src/dataset/hygiene.ts`) builds `forbiddenStrings`
from files the agent must never echo (a vault export, a planted canary). The e2e test plants
such a value, shows that a local-process agent can read it off the host, and shows that the
export is refused. Harness-controlled paths are written as placeholders at the source, so the
scan only has to catch what slips through. Fail closed has a cost: a shell action that names
a system binary (`/usr/bin/libreoffice`) refuses the export. Agents should use bare command
names (see §10 for placeholders at the source).

## 7. Scale targets (proposals, to be measured under TO FILE)

These are design targets for one host, not results.

| Metric | Target | Compared with |
|---|---|---|
| Restore to agent-ready (LibreOffice up) | p50 ≤ 500 ms, p95 ≤ 1.5 s | QEMU Linux path cold boot |
| Memory per desktop, with Calc open | ≤ 400 MiB unique RSS (copy-on-write shared base) | QEMU guest RAM |
| Teardown | ≤ 200 ms | |
| Density | ≥ 32 desktops at once on a 16-vCPU, 64 GiB host | |
| Throughput, scripted agent, fc-v1-size tasks | ≥ 1,000 trials per hour per host | Linux path, sequential |
| Contamination | 0 events over ≥ 200 trials at N = 1, 2, 4, 8 | shared with L-infra |

## 8. How to run the $0 tests

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run test/desktops test/dataset
bash scripts/desktops-mutation-proof.sh   # edits src/desktops and src/dataset, restores on exit
```

`test/desktops/e2e.test.ts` runs 8 trials of a scripted agent in local-process desktops, four
at a time. It hands each capture to the **real** gate (bound to that trial) and the **real**
independent grader, drafts each trial's episode, and exports the dataset. It checks the
counts (4 positives, 2 labelled negatives, 1 not claimed, 1 crash excluded), the schemas, the
digests, and that no host path is written. It also checks four more things: a snooping agent
makes the batch unclean; markers an agent writes into an observation or an action refuse the
export; a marker planted in the fixture never reaches the dataset unless echoed; and a vault
value read off the host is refused through the operator deny-list. No model, no VM and no
network are used. Every episode is `simulated: true`.

## 9. Pre-registered measurement bar (proposal for the capability spec)

This follows the capability spec's shared rules (§1 there, which lands with the spec PR): the
independent grader decides, a verified task is a done claim plus a grader `pass`, the unit is
the task, paired across arms, no exclusions, seeded ABBA assignment, Claude Ultra only, no run
before the integrity fixes (#518, the xlsx replacement for #503, the #494 follow-up) and the
lead's GO, Codex gated. Nothing here is run in this change.

**What U claims.** Running the baseline agents on a Myco disposable desktop does not lower
their verified rate, it multiplies throughput, and every run it exports is clean and
verified. U adds no agent-facing tool. Its gain is the substrate and the data. The
agent-improvement claim from training on the data belongs to M and to a later training track,
not to U.

**Arms.** The existing baseline surfaces, unchanged: **C1** (screenshot-only) and
**hcu+shell**. Each runs on (a) the current Linux path, sequential, N = 1, and (b) the U microVM
backend at N = 8. Same tasks, fixtures, instruction text, model id, step budget (30), output
ceiling, pacing and retry budget (0). One scored attempt per trial.

**Task set.** fc-v1's 90 satisfiable tasks, run on the Linux path (n = 90 per arm per
condition, k = 1).

**Stage 1, U-infra (no model, simulated, never evidence).** The microVM backend passes
`test/desktops/backend.test.ts`, run as a conformance suite against it. It shows 0
contamination over ≥ 200 trials at N = 1, 2, 4 and 8 (shared with L-infra). An export of every
U-infra trial passes the planted-marker suite with 0 leaks. Reported metrics: restore-to-ready
p50 and p95, unique RSS per desktop, teardown time. These answer the roadmap item's research
question against the QEMU path.

**Stage 2, U-agent. Bar components, tested in this fixed sequence at α = 0.05 each:**

1. **Zero contamination** across all U-agent trials. One event fails the bar and voids the
   batch.
2. **Parity (non-inferiority), per arm.** For C1, and separately for hcu+shell: the verified
   rate on U at N = 8 is non-inferior to the same arm on the current path. The test is the
   one-sided 95% upper bound of (current rate − U rate), Newcombe's paired score interval,
   below 5 percentage points.
3. **Throughput.** Verified tasks per wall-clock hour on U at N = 8 is at least 4 × the same
   arm's throughput on the current path. This includes desktop start, reset and teardown. The
   test is a paired bootstrap over tasks (10,000 resamples, pre-registered seed), and the
   one-sided 95% lower bound of the ratio must be ≥ 4.
4. **Dataset integrity.** Exporting every U-agent trial gives: 0 leaks; every positive
   re-graded `pass` by the grader from its inputs; every positive's gate record bound
   to its own trial; every attempt in #518's attempt ledger either exported or excluded with a
   code (once #518 lands). One breach fails the bar. The dataset stores the persisted
   document by digest only. For the re-grade, the harness keeps each trial's captured bytes
   in that trial's evidence location (where the gate read them) and re-grades those bytes
   against the digest the episode records.

**Power, stated before any run.** For component 2, with 90 paired tasks, a true difference of
0, and discordance d (the share of tasks where the two conditions disagree), the upper bound is
about 1.645 × √(d / 90). This is under 5 points only while d ≲ 8%. If discordance is higher,
component 2 is reported "not shown (underpowered at n = 90)" with the discordant count, never
as a pass. If Ultra rate limits stop N = 8, U-agent is reported "not measurable", with the
rate-limit events, not "failed".

**Guardrails** (any one makes the bar "not shown"): a parity check fails (tool lists, model id,
step budget, instruction or fixture digests differ between conditions); a row's
`fixtureSha256` is not its task's; any `runId` or evidence root is shared; any gate answers
another trial's request; a false done rate on U above the current path's by more than 5
points.

**Pre-registration.** Once ratified, the bar is frozen as
`docs/product/capability-prereg/U-v1/prereg.json` (the spec's §3 location), with the task-set
manifest SHA-256, the seeds, the step budget, the model id and the analysis script's SHA-256.
U packs are experiment rows, never R1 evidence.

## 10. TO FILE (local, single-owner)

These need KVM and Firecracker on a Linux host, or the merged integrity fixes, so they are
not in this change. Each is a queued local task for a single owner under the VM lock. None of
them touches the Windows VM, its lock, qemu, UTM or port 8765.

1. **U-VM-1, image build:** a reproducible `myco-linux-desktop/1` build (kernel, read-only
   root, manifest with digests and package versions).
2. **U-VM-2, Firecracker backend:** implement `DesktopBackend` with the jailer, no network
   device, a per-desktop overlay, the vsock guest agent, and capture after stop.
3. **U-VM-3, snapshot and restore:** the warm snapshot, the RNG and clock reseed, and
   destroy-plus-restore reset.
4. **U-VM-4, conformance:** run `test/desktops/backend.test.ts` against the microVM backend,
   plus a no-NIC assertion. Name the local-process race in it: the lstat walk and the `open`
   are not atomic, and `O_NOFOLLOW` only guards the last path part, so a directory part can be
   swapped for a symlink in between. That is acceptable for a backend that is not a boundary.
   The microVM backend reads the overlay after the VM stops, so nothing can race it.
5. **U-infra measurement:** §9 stage 1, including the 200-trial zero-contamination run (shared
   with L-infra) and the QEMU comparison the roadmap item asked for.
6. **Pre-registration freeze for U** after the capability spec lands and the lead ratifies §9.
7. **Ledger reconciliation:** check exports against #518's attempt ledger once it merges.
8. **U-agent measurement:** §9 stage 2. Claude Ultra only, after the integrity fixes and the
   lead's GO.
9. **Switch to #542's episode code** once it merges: replace the mirror and the interim writer
   in `src/dataset/episode.ts` with #542's `Episode` type, `episodeSchema`, `validateEpisode`
   and `buildEpisode`, and the step protocol with its `EpisodeRecorder`; delete the vendored
   copy in `test/fixtures/episode-542/`. Then drop the one documented loosening (reason codes
   are code-shaped, not the `REASON_CODES` enum). Until then, run
   `scripts/episode-mirror-drift.sh` whenever #542's head moves.
10. **One leak scanner:** consolidate `src/dataset/hygiene.ts` onto the canonical episode
    cleanliness scan (`src/episode/clean.ts`, #542) once it merges, so a single scanner (with
    the encoded-path cases tested here) guards every export.
11. **More blobs in the container:** the persisted CSV document is carried (round 3). Still
    refused: screenshots (PNG needs #542's frame redaction plus a byte-level scan before it
    can be carried) and `ui-tree` / `app-state` / JSON state blobs.
12. **Placeholders at source for system paths:** have the microVM guest agent rewrite guest
    system paths (`/usr/bin/...`) to placeholders, so real hcu+shell actions export instead
    of being refused by the fail-closed scan.
