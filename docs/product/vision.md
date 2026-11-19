# Myco: product vision (from Tiffany, 2026-11-18; condensed by her outer-loop assistant)

## Mission
Make existing desktop software reliably executable by AI agents through verified operations, recoverable execution, and reusable procedural knowledge. Agents stop where real work begins: spreadsheets, legacy clients, vendor tools, and remote sessions are built for people. Agents can touch them, but nobody can trust them to finish work there.

## What current tools leave unsolved
- **True app state:** agents guess from pixels or noisy accessibility dumps.
- **Action success:** nothing checks whether an action worked, so errors compound silently.
- **Recovery:** a wrong step can't be undone.
- **Learning:** run 100 is as hard as run 1.
- **Parallelism with context:** every new agent starts on a blank machine.

## Approach: the desktop as a program, not a picture
- Read state directly from each app's UI framework or object model (UIA, AX, AT-SPI, COM, UNO, JVM) as typed data.
- Execute intent as code: guarded programs of actions, waits, and assertions, run locally.
- Verify every step against real app state, and retry from a known-good point.
- Fork live desktops, so parallel attempts inherit full context.
- Compile successful runs into reusable, self-healing procedures.
- Gate irreversible actions until the work behind them is verified.

The agent's job is intent and judgment: what should happen and what "done" means. The runtime handles how it happens, confirms it happened, and remembers how.

## Tradeoffs we accept
- Coverage comes one framework adapter at a time.
- Reading an app structurally or running it headless can disagree with what's on screen.
- Verifiers need domain knowledge.
- Forking is hard: server-side sessions collide, and the remote system can't be forked.
- Compiled workflows drift as apps update.
- There are more moving parts.
- Platforms add friction: macOS licensing, multi-session Windows, MFA, and anti-bot checks.

## Winning
An agent can take a long, real job in arbitrary desktop software and finish it verifiably, without supervision, at a cost that falls with repetition. Myco is the default runtime whenever work leaves the browser or API.

Full solution path:
1. Structure everywhere: framework adapters plus pixel-to-structure perception.
2. Transactional actions: verify locally, branch on uncertainty, commit externally only when proven.
3. Search when uncertain: fork, try alternatives in parallel, keep what verifies.
4. Learn permanently: a compiled, shared, self-healing workflow registry.
5. Run anywhere: laptop to fleet, any OS, self-hosted.

## Product surfaces (later; NOT Milestone 1)
- **For an agent:** one tool that takes a job and returns a verified result with evidence.
- **For a developer:** SDK, a demonstration recorder, and a way to write checks.
- **For an operator, in priority order:**
  1. Job board
  2. Commit-gate approval queue
  3. Live view with an intent overlay, takeover, and multiple cursors
  4. Agent debugger: breakpoints on state, step-through, watch expressions, edit-and-continue
  5. Time travel from state deltas, "fork from here", and run diffs
  6. Semantic lineage canvas: position shows fork lineage, zoom shows abstraction level, edges show fork, retry, winner, or commit
  7. Workflow studio and drift monitor
- **Also:** branch race view, state-diff view, outcome receipts, app map explorer, fleet controls, collaboration, and mobile approvals.
- **Risk:** UI scope swallowing the core. Build the debugger, time travel, and commit queue first, from runtime primitives.

## Competitive landscape (Tiffany's research; verify before relying on it)
- **Cua:** driver, multiplayer cursors, sandboxes, Lume, Cua-Bench. No verification, learning, or commits.
- **Vercel Labs agent-desktop:** Rust; reads the accessibility tree (AX, UIA, AT-SPI) and returns refs; headless; explicit stale-ref errors; MCP. A likely ADAPTER candidate for us.
- **Orgo:** cloud VMs with live fork and clone; screenshot loop. Fork alone is table stakes now, not our differentiator.
- **Simular:** Agent S and SimuLang compile runs into code. Closed. The closest in philosophy.
- **Windows 365 for Agents and Copilot Studio:** vision-based, one Cloud PC per agent. Doesn't support Citrix, Java, or Electron.
- **Lab agents** (OpenAI, Meta, xAI, Manus, Anthropic): closed and consumer-focused.
- **UiPath:** selector-based RPA that is brittle and proprietary.
- **E2B, Daytona, Fly:** possible backends.
- **UI-TARS, OpenCUA, OpenAdapt, OpenClaw:** potential consumers of Myco.

What only we combine: typed state from object models beyond accessibility, guarded programs with per-action verification, verifier-driven search over forks, a commit gate, open self-healing compiled workflows, and open, self-hosted, high-density deployment.

## Long-term paradigm bets (direction, not M1 scope)
1. **Software as verifiable RL environments.** Typed state is the reward, fork gives cheap mid-task resets, and real software encodes real expertise. Self-play for software: agents explore apps in forks, propose tasks plus state checkers, verify, train, and repeat.
   - **Killers:** shallow auto-verifiers, reward hacking, unproven transfer, licensing.
   - **Proof experiment:** about 1,000 self-generated LibreOffice Calc tasks, RL on a small open model, then test on OSWorld's held-out Calc tasks.
2. **Portable execution layer for agent OSes** (Windows Agent Workspace, MXC, Windows 365 for Agents, ANOLISA, and others). They solve containment, identity, and access; nobody solves operating software reliably inside. Myco is the POSIX/Kubernetes-like layer: an open interface spec (state, act, verify, fork, commit, skills) with Myco as the reference implementation.
   - **Order:** Windows inside MXC and Agent Workspace first, then Linux and cloud desktops, then a cross-OS skill registry, then RL on top.
   - **Risks:** Microsoft builds it natively, and sandbox policies block deep hooks.

## Platforms
Value is highest on Windows (Office, line-of-business apps, Java, Citrix). Linux is the fleet substrate; macOS is the developer machine.

---

# MILESTONE 1 (the ONLY current scope)
**Prove Myco can reliably execute and verify a real desktop operation in one real Windows application.**

Give an agent a task in a real desktop app. Myco executes it through the app, independently verifies that the intended state persisted, detects when execution goes wrong, and produces an auditable result. The point being proved: a successful interaction is not the same as a successful outcome. Relevant work: OSWorld 2.0, OpenComputer, and Microsoft UFO.

## Suggested demo (not mandatory)
LibreOffice Calc on Windows, editing records with controlled input files and an independent evaluator:
1. Observe through an existing adapter.
2. Execute with guarded actions that validate the app, target, and expected state.
3. Save, then reopen or independently inspect the file to confirm values persisted.
4. Break it deliberately: focus change, invalid control, delayed save, killed app. It must never report false success.
5. Recover: retry or resume reversible operations, and report uncertainty instead of guessing.
6. Produce evidence: outcome, trace, verification results, and unresolved state.

## Acceptance criteria
| Requirement | Criterion |
|---|---|
| Real desktop execution | One parameterized task family against a real Windows GUI app |
| Independent verification | Success decided from persisted app state, never from the agent's claims |
| Reliability | At least 27 of 30 varied normal trials succeed |
| Failure detection | 0 false-success reports across at least 10 deliberately corrupted or interrupted trials |
| Recovery | Safe recovery from an app interruption AND an invalid UI target |
| Evidence | Every run emits a machine-readable trace, result, and verification outcome |
| Baseline | Compared against a screenshot-based agent on identical tasks, initial states, and model settings |
| Reproducibility | Another coding agent can reproduce the evaluation from the repo |

Build reusable foundations, not a hardcoded demo. Do not expand into the full product until M1 is demonstrably complete. Be technically ambitious and creative.
