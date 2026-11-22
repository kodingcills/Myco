# Baseline status

The host harness runs scripted reference policies over the myco-todo model. It uses the Foundry fixture's initial bytes and isolates the injected save faults. Control saves and recovery saves use the model's healthy save path. These runs exercise the grader and provide no live desktop performance measurements. Setup time, manual interventions, and economics remain unknown.

## Offline-complete (2026-11-22)

Everything below runs with no guest and no VM time. The dev loop stopped serializing on the
VM queue: the arm harness is finished against a fake transport, so the VM task is now *one
class*, not a project.

| Piece | Where | Status |
|---|---|---|
| Arm recorder (producer for the recorded-evidence schema) | `src/foundry/baseline/recorder.ts` | done — records calls, accesses, GUI actions; one recorder per trial; open calls close as `incomplete` |
| Live arm executor (transport-abstracted) | `src/foundry/baseline/executor.ts` | done — budget accounting, step attribution, transport-failure → `incomplete`, screen/persistence capture |
| Fake guest transport | `test/foundry/executor.test.ts` | done — in-memory store, scripted failures, used by 11 tests |
| Paired comparison + exact sign test | `src/foundry/baseline/compare.ts` | done — refuses to name a winner outside the significant bound |
| Grader reconciliation round trip | `test/foundry/executor.test.ts` | done — recorder → executor → `scoreDiscoveryTrial` end to end; a non-GUI store write is caught as `file-io-shortcut` |
| Reference policies (credulous / honest-reread / file-only) | `src/foundry/baseline/arms/index.ts` | done, scored by the same grader |

**Correction while building this:** the contract's sign-test paragraph said "at n = 30 a
two-sided sign test needs 21 discordant trials". That is wrong — 20 unanimous gives
p ≈ 2×10⁻⁶. The true rule is that *unanimous* needs 6, a *split* needs 9 at best (8-to-1),
and an even split proves nothing at any size. `compare.ts` enforces the real bound and
rejects any comparison outside it.

## Still needs the guest (batched, one block)

Nothing here can be finished offline; each needs the Windows guest or a real desktop.

1. **`LiveTransport` implementation for Cua Driver C1** — `screen()` over the driver's
   screenshot, `act()` over its pointer/keyboard, `readPersistence()` over the guest agent's
   `read_file`. This is the only code EF-005 still needs.
2. **HCU GUI-channel transport** — same interface, HCU's `GUI` tool only.
3. **`LiveTransport` for Writer/UNO** — `screen()` from the UIA tree, `readPersistence()` from
   `soffice --convert-to` plus a host-side `word/document.xml` parse, to replace the Writer
   model with a live read (EF-003's remaining gap).
4. **The 30-corrupted-trial run** and its zero-event bound (EF-003 acceptance).
5. **Optional**: Orgo / Simular Sai remain blocked on account creation; no VM time would
   unblock them.

Estimated guest need: ~2 h for (1) plus one Calc trial, ~1 h for (2), ~1 h for (3), ~35 min
of resets plus trial time for (4) at ~21 s per cold restore.

## Live arms queued for the outer loop.

- **screenshot-only** — not-run: Cua Driver C1 pixel arm needs coordinated VM time; planner: claude-sonnet-5-5.
- **hcu** — not-run: Microsoft Hybrid Computer Use GUI channel needs coordinated VM time; planner: claude-sonnet-5-5.
- **hcu+shell** — not-run: Needs coordinated VM time, trusted live evidence ingestion, complete tool-call audits, and independently observed save snapshots; planner: claude-sonnet-5-5.
- **orgo** — blocked: account creation + card/credit; planner: unknown.
- **simular-sai** — blocked: Google sign-in + API key + phone verification; hosted cloud computer is not our fixture host; planner: unknown.
