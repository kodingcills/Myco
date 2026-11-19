# Myco Desktop Runtime (Rust) — workstream state

Owner: RT workstream (this thread). Cross-workstream changes route through the Myco
M1 Coordinator (threadId
`mcp:launch:ea839ebaa08e7e4a093c2d3ffb0b742d3c2e96192f52c993503b9c8e6cfaac9d`).
M1's state: [m1-state.md](m1-state.md). Backlog: [../backlog/runtime.md](../backlog/runtime.md).

## Scope (from Tiffany, 2026-11-19)
Programmable, agent-native desktop runtime in Rust (`runtime/` Cargo workspace in this
repo). v0 API: exactly six ops — `create`, `observe` (accessibility tree + screenshot
+ process/window info), `act`, `evidence`, `reset`, `destroy`. Surfaces: MCP server
(primary) + CLI with JSON I/O (same core), per ADR-0013. First host: Linux ARM64
guest under QEMU+HVF (ADR-0011). Boundary with M1: ADR-0012.

North-star demo: an Oh My Pi coding agent creates a disposable desktop, installs and
launches the app it is developing, tests the real GUI, captures evidence, destroys
the environment. The Dogfood workstream consumes this.

## Hard rules (from the brief)
- **Never** start/stop/reset/snapshot `myco-win11` without M1-coordinator sign-off.
- No paid services, no account creation, no macOS privacy-permission changes: escalate.
- RAM: Win11 VM uses 8 GB; shut runtime VMs down when idle; cap concurrent desktops.
- Merge only after independent verifier (kimi-k3) passes and CI is green.
- Never answer permission prompts or read credentials.

## Dogfood requirements (REQ-01..REQ-12) — coverage map

Source: docs/coordination/dogfood-state.md on main (PR #8, merged 2026-11-19).
DF-005 (TIF-27) is blocked on **RT-first-path** (= RT-011 end-to-end test).

| REQ | Requirement | Covered by | First path? |
|---|---|---|---|
| REQ-01 | create → session handle | RT-006 (`QemuLinuxBackend.provision`) | yes |
| REQ-02 | destroy, no state leaks | RT-006 (`destroy`, overlay deletion) | yes |
| REQ-03 | observe: structured tree incl. **Tk listbox rows + status line** | RT-007 — **AT RISK**: Tk's AT-SPI exposure on Linux is unverified (historically weak/absent). RT-003's smoke app is a Tk app (Listbox + Entry + status Label) precisely to probe this; finding lands with RT-003. | yes, pending Tk probe |
| REQ-04 | act: typing + clicks, three-way outcome | RT-008 (`ActionOutcome` three-way, read-back per ADR-0014) | yes |
| REQ-05 | evidence: M1-012 schema artifacts + run ids | RT-009 (+ RT-014 `recordKind:"session"`) | yes |
| REQ-06 | reset with measured cost | RT-006 + RT-011 (measured, not inherited from M1-017) | yes |
| REQ-08 | host-side guest file read | **RT-015** (extended op, post-first-path) | no |
| REQ-09 | process control (launch/kill/relaunch, exit status) | launch via `act` now; kill/relaunch/exit-status = **RT-016** | partial |
| REQ-10 | guest file edit/write | **RT-017** (extended op) | no |
| REQ-11 | guest shell exec w/ stdout/stderr/exit | **RT-018** (extended op) | no |
| REQ-12 | reset/destroy after crashes | RT-006 acceptance + RT-011 (crash-then-reset case) | yes |

Note: REQ-08/10/11 exceed the brief's "v0 = exactly six operations". They are
scheduled as extended ops immediately after the first path rather than expanding v0
mid-flight; flagged to the outer loop (runtime-state.md log, 2026-11-19).
REQ-07 was retired by Dogfood (folded into REQ-03).

## Interfaces RT provides to M1 / Dogfood
| Interface | Shape | Status |
|---|---|---|
| Six-op session API | MCP stdio server + `myco-rt` CLI (JSON NDJSON) | ADR-0013; not implemented |
| Linux desktop backend | QEMU+HVF ARM64 guest, AT-SPI observation, input actuation | ADR-0011; not implemented |
| Evidence envelope | `runs/<sessionId>/trace.jsonl` + `result.json` reusing M1's schemas (verdict omitted) | ADR-0012; not implemented |
| `Backend` trait | Rust trait for create/observe/act/evidence/reset/destroy | ADR-0011; not implemented |

## Interfaces RT needs from M1
| Interface | Owner | Status |
|---|---|---|
| Evidence schema (`schemas/`, docs/architecture/evidence-schema.md) stays stable or changes via shared PR | M1 (M1-012, done) | stable; RT reuses |
| Adapter vocabulary (opaque refs, StaleRefError, three-way action outcome — ADR-0003) | M1 | stable; RT adopts |
| Windows/UTM backend requirements (anticipate `myco-win11`) | M1 coordinator | not started; RT-00x placeholder |
| Dogfood's exact consume path for the north-star demo (MCP client? CLI?) | outer loop / Dogfood | **open question** — escalated |

## Decisions
- ADR-0011 host = Linux ARM64 QEMU+HVF VM over container desktop (tradeoffs in ADR). [CONSEQUENTIAL, reported]
- ADR-0012 boundary: Rust = lifecycle/session only; no runner/verifier/verdicts; reuses M1 evidence schema. [CONSEQUENTIAL, reported]
- ADR-0013 surface = MCP stdio + CLI JSON from one core. [CONSEQUENTIAL, reported]
- Prior art: xa11y / computer-use-rs / MS Hybrid Computer Use evaluation in progress → docs/research/runtime-prior-art.md (RT-001).

## Active children
| Child | Task | Model | Status |
|---|---|---|---|
| rt-priorart-2 | prior-art evaluation → docs/research/runtime-prior-art.md | deepseek-v4.1-flash | running |

## Blockers
- None external yet. Prior-art result gates RT-003 (in-guest observation/actuation stack choice).

## Log 2026-11-19
- Workstream bootstrapped. Read AGENTS.md, vision, m1.md (ADR-0001..0010), m1-state.md.
- Verified host facts: Rust 1.94.0, QEMU 11.1.3, no /dev/kvm (HVF as expected), 97 GB disk free, Win11 VM scripts are osascript-based (will not touch VM).
- Wrote docs/architecture/runtime.md (ADR-0011..0013), this file, docs/backlog/runtime.md.
- Delegated RT-001 prior-art research (deepseek-v4.1-flash).
- M1 coordinator set three boundary constraints (act = transport primitive; evidence =
  M1 schema as-is with extensions via flagged PRs against schemas/; myco-win11 owned by
  M1, hands off without asking). ADR-0012 updated to match verbatim; no conflicts.
  Coordinator will review the boundary ADR on myco/runtime-v0; RT owes the coordinator
  the Phase-1 go signal input when the first end-to-end path works.
- M1 coordinator review of ADR-0011/0012/0013 @ 55bd21c: ACCEPTED. Verdict-less session
  records resolved as RT-014 (recordKind discriminator PR against schemas/: "run" =
  verdict required, backward compatible; "session" = verdict forbidden, checks optional).
  ADR-0011 reset-cost figure corrected: M1-017's 8.3–8.6 s is Windows live-snapshot;
  Linux boot/reset cost measured fresh at RT-011. Phase-1 go signal: standing — send
  RT-011 passing evidence, coordinator messages Dogfood same day.
- Delegated RT-014 (recordKind schema PR, glm-5.3).
- RT-001 done: docs/research/runtime-prior-art.md committed (verified, pinned commits).
  ADOPT xa11y 0.16.1; BUILD rest; HCU contract shapes; cua-vmm reset concept; agent-desktop
  post-mortems → read-back verification mandatory in act. ADR-0014 records the stack:
  X11/Xvfb (Wayland portal prompt blocks unattended screenshots), Ubuntu 24.04 ARM64 floor.
- Delegated RT-003 (guest provisioning: Ubuntu 24.04 ARM64 + Xvfb + AT-SPI + smoke proof,
  glm-5.3). RT-003 and RT-014 children share this branch; file ownership is disjoint
  (schemas/ vs runtime/guest/).
- RT-014 ACCEPTED by M1 schema owner: dual verification (72/72 on myco/runtime-v0;
  77/77 on M1 main with the schema dropped in, all M1 artifacts unchanged). Rides with
  the runtime PR; owner re-runs compat at that PR's head. M1 shares the Tk/AT-SPI
  skepticism (labels can be invisible); RT-003's Tk probe numbers go to both M1 and
  Dogfood when they land.
