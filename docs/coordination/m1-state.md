# Myco M1 — coordinator state

## Objective
Milestone 1: verified, recoverable desktop execution in one real Windows GUI app (LibreOffice Calc record edits, default suggestion). Acceptance: 27/30 reliability, 0 false successes in ≥10 corrupted trials, recovery from app interruption and invalid target, machine-readable evidence, screenshot-agent baseline on identical conditions, reproducible by another agent. Full spec: docs/product/vision.md.

## Environment facts
- Host: Apple M4 Pro Mac, 24 GB RAM, ~130 GB free. Docker present, no VM software installed by us.
- Windows env (decided by Tiffany via outer loop, 2026-11-18): Windows 11 ARM64 VM in UTM on this Mac. Outer loop is provisioning; we do NOT install. VM docs will land at ~/VMs/myco-win11/README.md. SSH as user `myco`, key ~/VMs/myco-win11/id_ed25519, via localhost port forward. Auto-logon interactive desktop. Python 3.12 ARM64, LibreOffice (ARM64 if available), pywinauto, uiautomation. `clean-base` snapshot for resets.
- Adapter/harness must be designed around: SSH control plane + interactive-session launcher (session-0 problem) + snapshot restore.
- Status: env NOT live yet. Outer loop will announce.

## Roles and models (pstack, Oh My Pi)
- Build: cheaperinference/glm-5.3. Judgment: cheaperinference/kimi-k3. Swarm/research: cheaperinference/deepseek-v4.1-flash. All with thinking:auto.

## Active children
(Point-in-time log; rows are stamped when written and not rewritten retroactively. Current as of 2026-11-18.)
| Child | Task | Model | Status |
|---|---|---|---|
| Research: eval frameworks | OSWorld/OSWorld2, OpenComputer verifiers, screenshot baselines (OpenAdapt, Agent S, UI-TARS, OpenCUA) | deepseek-v4.1-flash | done → docs/research/eval-frameworks.md (committed) |
| Research: structural adapters | UFO/UFO2, agent-desktop (verify Tiffany's claims), pywinauto vs uiautomation, UNO verifier, Cua; ARM64 matrix | deepseek-v4.1-flash | done → docs/research/adapters.md (committed) |
| Research: Windows env | UTM scripting, snapshot reset strategy, SSH session-0 launcher, ARM64 compat | deepseek-v4.1-flash | done → docs/env/windows.md (committed) |
| Build: core runtime skeleton | TS toolchain, core interfaces, fake app, tests, CI | glm-5.3 | done → PR #1, head c85b568; CI + independent review pending |
| Verify: PR #1 | adversarial review | kimi-k3 | done → REJECTED: uncertain collapse, bare-ok ActResult, fake ref versioning (ADR-0002/0003). Adversarial attack could NOT fool the harness. |
| Fix: PR #1 | must-fixes 1-3 + lockfile on feat/m1-core-runtime-skeleton | glm-5.3 | running |
| Verify: PR #2 | docs foundation review | kimi-k3 | done → VERIFIED; nice-to-fixes applied (Cua date note, 2 citation fixes, snapshot header) |

## Decisions so far
- Issue tracker: Linear team TIF, owned by outer loop; repo-local canonical backlog at docs/backlog/m1.md. (setup-matt-pocock-skills)
- Triage labels: defaults. Domain docs: single-context. Agent file: AGENTS.md.
- pstack models: already configured at ~/.agents/pstack-models.md (Oh My Pi section); no /setup-pstack needed.
- Language for core runtime: TypeScript/Node 24 (delegated; justifiable — MCP ecosystem, adapter boundary keeps Windows-side Python possible).

## Key research findings (docs/env/windows.md)
- LibreOffice has NO native UIA — IAccessible2 via lossy MSAA→UIA proxy (tdf#160982). UIA gives windows/menus/dialogs but NOT reliable Calc cell state. M1 verification must lean on UNO; Calc cell observation via UIA is unreliable. → shapes adapter ADR.
- SSH can never drive the GUI (session 0). Launcher = logon-started Python agent in the interactive session (127.0.0.1:8765, NDJSON, token), bootstrapped/recovered by a scheduled task with LogonType=InteractiveToken.
- utmctl refuses SSH (OSStatus -1743, TCC). Outer loop must run from GUI session or pre-authorize TCC — flagged to outer loop.
- Live snapshots fail on wizard-default Win11 ARM64 (NVMe + virtio-ramfb-gl). Reset = stop --request → snapshot restore clean-base → start. Fallback A: utmctl start --disposable (P7 gates on it; may be strictly better). Fallback B: qcow2 overlays.
- LibreOffice 26.8.3 official Win ARM64 MSI exists; pywinauto/uiautomation/comtypes run native ARM64 (pywin32/Pillow have cp312-win_arm64 wheels).

## Key research findings (docs/research/eval-frameworks.md)
- OpenComputer with state verifiers = echo0715/OpenComputer (Yale NLP, Apache-2.0): ships a UNO-based Calc verifier with 16 check-* endpoints. Adopt verifier shape, not harness.
- OpenAdapt is a COMPETITOR (MIT, verified execution layer, published false-success numbers: 54/72 bad saves reported saved from on-screen "Saved"; 30/30 from a computer-use agent). M1 must cite and beat these.
- OSWorld Calc evaluator = whole-sheet DataFrame.equals; gold computed OUTSIDE the guest (employee_age_reference discipline — adopt verbatim). OSWorld 2.0 partial_scores = right evidence shape.
- Cheap general VLMs cannot ground Calc cells (measured 2/16). Baseline = Agent S3 + UI-TARS-1.5-7B grounding. CheaperInference vision support unverified (credits error).
- Verdict needs UNVERIFIED state distinct from failed (both prior designs collapse it). Matches the build brief's verified/refuted/uncertain.
- Never eval() task-supplied strings (OpenComputer does — RCE hole). Use declarative predicate language.
- Evaluator must not depend on GUI keystrokes (OSWorld postconfig presses Ctrl+S via pyautogui).

## Key research findings (docs/research/adapters.md)
- agent-desktop verified real: Rust, CUIAutomation8, STALE_REF/AMBIGUOUS_TARGET, three-way outcome, MCP, Apache-2.0, ARM64 released. But publish=false, no COM/UNO. → steal primitives, no dependency.
- Adapter = uiautomation + raw comtypes SetConnectionTimeout/SetTransactionTimeout (neither lib exposes them; killed-app trial hits unbounded hang). UNO = independent read-only verifier, separate process.
- Two verifications: edit landed (UNO live read) vs edit persisted (close + host-side file parse). isModified() = cheap pre-check.
- UFO's reusable asset: UIA query shape (FindAllBuildCache, 3-property cache, element cap). UFO verification = LLM judging screenshots — rejected.
- ARM64 clear: LibreOffice 26.8.3 aarch64 MSI + SDK; pywin32 win_arm64 wheels; uiautomation bitmap DLLs x64-only but degrade gracefully.

## Architecture and backlog
- docs/architecture/m1.md: ADR-0001 (TS host + Python guest agent, NDJSON) [CONSEQUENTIAL], ADR-0002 (independent 3-valued verifier, UNO), ADR-0003 (uiautomation+comtypes adapter, agent-desktop primitives, no dependency) [CONSEQUENTIAL], ADR-0004 (programs as data), ADR-0005 (fault injection, host-side ground truth), ADR-0006 (recovery semantics), ADR-0007 (evidence + conformance ledger), ADR-0008 (eval harness), ADR-0009 (baseline: Agent S3 + UI-TARS-1.5-7B), ADR-0010 (env ratified). Task family calc-record-edit + per-row DoD defined.
- docs/backlog/m1.md: M1-001..M1-018 with blocked_by. Ready for Linear mirroring.

## Open decisions
- ~~Adapter choice~~ → decided: uiautomation + comtypes timeouts, agent-desktop primitives reimplemented (ADR-0003).
- ~~Task family~~ → decided: calc-record-edit (docs/architecture/m1.md).
- ~~DSL vs API~~ → decided: programs as declarative data (ADR-0004).
- UI-TARS hosting for the baseline (local vs hosted; possible account/cost) — escalate when M1-015 starts.

## Blockers
- Windows VM not yet provisioned (outer loop owns).

## Next steps
1. Collect 3 research reports + build PR.
2. Independent verifier review of build PR (kimi-k3) before merge.
3. Write docs/architecture/m1.md (ADRs) using research.
4. Write docs/backlog/m1.md.
5. Commit docs, push branch, report to outer loop.

## Log 2026-11-19
- PR #2 (docs foundation) VERIFIED by independent kimi-k3 review (consistency PASS, spec coverage 8/8, scope PASS, one factual nit + 2 citation drifts fixed by coordinator) and MERGED to main (81bf6c4).
- M1-005 (guest agent) delegated to glm-5.3. Protocol surface per docs/env/windows.md is stable, so it runs parallel to PR #1's fix round.
- PR #1 fix round still running (glm-5.3).

## Log 2026-11-19 (2)
- PR #1 RE-VERIFIED at d8a16be by fresh kimi-k3 verifier: all 3 must-fixes confirmed end-to-end, 9-case adversarial attack produced no false success and no uncounted uncertain, no scope creep, lockfile fixed. MERGED to main (f90cd73). Backlog M1-001 marked done.
- Nice-to-fix parked: PersistedStateReadError "corrupt" variant is dead code (parseable garbage legitimately refutes). Next PR touching filepersist.ts should drop or implement it.
- Delegated: M1-009 task family (glm-5.3, owns src/tasks/), M1-012 evidence schema + ledger (glm-5.3, owns evidence.ts/eval.ts/schemas/). Disjoint file ownership to avoid merge collisions. M1-005 (guest agent) still running.

## Log 2026-11-19 (3)
- M1-005 (guest agent) delivered as PR #4 (head 4f4608f): NDJSON loopback server, token auth, 10 ops, WindowsBackend/FakeBackend split, InteractiveToken bootstrap XML, 20/20 pytest, 4/4 CI green. Independent verifier (kimi-k3) spawned.

## Log 2026-11-19 (4)
- PR #4 (M1-005 guest agent) VERIFIED at 4f4608f: protocol conformant (10/10 ops), token enforced on every op over real sockets, loopback-only, agent-thinness clean, bootstrap XML correct, stress attack survived (backlog RSTs only). Coordinator applied the 4 nice-to-fixes (session_info mislabel, request_queue_size=64, ps1 dedupe, README path semantics) as 709c0ad; pytest 20/20 locally; CI 4/4 green on new head; MERGED. Note: windows_backend.py session_info fix is untestable off-Windows — first real-VM run must validate it (part of M1-008).
- M1-005 marked done. Next delegatable: M1-010 fault injectors (now unblocked: M1-001 + M1-005 merged).

## Log 2026-11-19 (5)
- PR #5 (M1-009) verifier: content PASS (30 distinct deterministic sets, host-only ground truth confirmed by code read, 4/4 attacks failed, CI green) but REJECTED on process: branch not rebased onto main (vendored runtime pollutes diff), one tautological no-write test, close-step comment/guard mismatch. Fix child delegated (rebase + 2 code fixes + FNV collision note). Parked for real-adapter phase: strengthen locate beyond pristine-value equality (row/column header identity) — belongs to M1-006/M1-013 integration.

## Log 2026-11-19 (6)
- PR #6 (M1-012) verified at db55655 and merged. Merge blocker: repo OAuth token lacks `workflow` scope (GitHub refuses API merges touching ci.yml). Worked around by folding schema-validate into `pnpm test`. Durable fix = Tiffany runs `gh auth refresh -s workflow`.
- M1-010 child stream died post-push; work recovered from PR #7, conflict resolved by coordinator, VERIFIED at 7d9b080 (0 false successes in 11/11 corrupted configs; 65/65 tests), merged. Parked nice-to-fix: fake app setSaveDelay 60s timer could use a dispose().
- VM-gated items remain blocked on the UTM Automation Allow click (TCC dialog on the Mac's screen; re-trigger with one vm.sh status call if dismissed).

## Log 2026-11-19 (7) — VM PHASE STARTED
- TCC Automation grant landed (Tiffany reset T3 Code AppleEvents; one vm.sh status call succeeded in 2s). VM was already started from the earlier timed-out dispatch.
- M1-008 done (coordinator, live VM): comtypes 1.5.0, uiautomation 2.0.29, pyuno (LO-bundled python), pywin32 all import on ARM64. smoke.ps1 pass:true, exact match, 197 UIA elements. uia_cell found:false confirms cell values must come from UNO/file, not UIA (validates ADR-0002/0003).
- M1-017 done: reset.sh live ×3, 8.3-8.6s each, guest clean each time.
- Delegated: M1-006 (glm-5.3, owns agent/, deploys to live VM, bounded-UIA-timeout validation required as evidence) and M1-007 (glm-5.3, owns src/verify/+src/win/, host-side UNO verifier, exact-match comparison vs AutoCorrect, fake-agent tests).
- VM stays UP while M1-006 works. Shut down when idle: ~/VMs/myco-win11/scripts/shutdown.sh.

## Cross-workstream dependencies (owner: M1 coordinator, per outer loop 2026-11-19)
| Workstream | Thread | Branch | Depends on M1 | M1 depends on it |
|---|---|---|---|---|
| Myco Runtime Owner (Rust) | mcp:launch:cba81a8ecbe150c1ad3f6908da73bab666f2f4eca8ccd1657f403f1f051220fa | myco/runtime-v0 | boundary constraints sent 2026-11-19 (no duplicating TS engine per ADR-0001; reuse M1-012 evidence schema; hands off myco-win11) | nothing — M1 is independent; do not slow M1 for it |
| Myco Dogfood Owner | mcp:launch:a4cad102668e27328e4726db527286133e1d90b3a6884a507edbd4fb1a0a5ebc | myco/dogfood-v0 | gated on runtime's first end-to-end path; M1 coordinator sends the Phase-1 go signal | nothing |

Obligations:
- Review runtime owner's boundary ADR when it lands on myco/runtime-v0; flag conflicts with ADR-0001 / M1-012 schema to the outer loop.
  - 2026-11-19: REVIEWED docs/architecture/runtime.md @ 55bd21c (ADR-0011/0012/0013) — ACCEPTED, no conflicts. Answered its open question as schema owner: verdict-less session records become a `recordKind` discriminator (run: verdict required; session: verdict forbidden) via a schema PR the runtime owner files; no verdict-less records under the current schema meanwhile.
  - 2026-11-19: RT-014 (recordKind schema) delivered on myco/runtime-v0 @ a0e5dda — ACCEPTED after dropping their result-record.ts onto M1 main and running the full M1 suite: 77/77 green, artifacts validate unchanged. Rides with the runtime PR; will re-verify at that PR's head.
  - Radar: dogfood REQ-03 needs Tk listbox rows + status line via AT-SPI; runtime owner is probing with a Tkinter smoke app (RT-003) and will forward measurements.
- On runtime first-path-works: message dogfood owner to start Phase 1.
- myco-win11 is M1-owned; other owners must ask before touching it.
- RAM watch: Windows VM 8 GB of 24 GB; Linux VM must stay small and be shut down when idle. Check memory_pressure when both VMs may be up.

## Log 2026-11-19 (8)
- CheaperInference wallet outage killed the first M1-006 child (402); respawned after top-up with identical kickoff.
- PR #9 (M1-007 UNO verifier) VERIFIED at 6e166fa: exact comparison confirmed, all 8 attacks failed (case flip refuted, dropped save refuted, fabricating agent refuted/uncertain, no hangs). Coordinator applied 3 nice-to-fixes (sequenced ids, SshTunnel SIGKILL escalation, configurable guest temp dir) as 79660f3, gates green, MERGED.
- Note: dogfood workstream merged PR #8 to main (their own scope; no M1 interaction).
