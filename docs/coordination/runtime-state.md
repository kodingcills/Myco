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
