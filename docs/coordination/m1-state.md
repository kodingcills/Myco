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
| Child | Task | Model | Status |
|---|---|---|---|
| Research: eval frameworks | OSWorld/OSWorld2, OpenComputer verifiers, screenshot baselines (OpenAdapt, Agent S, UI-TARS, OpenCUA) | deepseek-v4.1-flash | running |
| Research: structural adapters | UFO/UFO2, agent-desktop (verify Tiffany's claims), pywinauto vs uiautomation, UNO verifier, Cua; ARM64 matrix | deepseek-v4.1-flash | running |
| Research: Windows env | UTM scripting, snapshot reset strategy, SSH session-0 launcher, ARM64 compat | deepseek-v4.1-flash | done → docs/env/windows.md (committed) |
| Build: core runtime skeleton | TS toolchain, core interfaces (state/adapter/program/verify/evidence/eval), fake app, tests, CI, PR to main | glm-5.3 | running |

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

## Open decisions
- Adapter choice (agent-desktop vs pywinauto/uiautomation direct) — pending research.
- Task family exact definition (Calc record edits parameters) — after research.
- DSL vs API for guarded programs — pending architecture doc.

## Blockers
- Windows VM not yet provisioned (outer loop owns).

## Next steps
1. Collect 3 research reports + build PR.
2. Independent verifier review of build PR (kimi-k3) before merge.
3. Write docs/architecture/m1.md (ADRs) using research.
4. Write docs/backlog/m1.md.
5. Commit docs, push branch, report to outer loop.
