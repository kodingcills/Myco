# DF-S05 — Adversarial: empty and duplicate inputs

- **task:** "Run `dogfood/apps/myco-todo/myco_todo.py` with store `/tmp/df-s05.json`. Try to add: an empty item (just press Enter on the empty field), the item `dup` twice, and one item containing only spaces. Save, quit, and report the final contents of the store."
- **app:** dogfood/apps/myco-todo
- **runtime capabilities required:** REQ-01, REQ-03, REQ-04, REQ-05, REQ-08, REQ-12
- **success oracle (independent):** host-side parse of `/tmp/df-s05.json`: expected persisted texts are exactly `["dup", "dup"]` (empty and whitespace-only rejected by the app, duplicates allowed). Verifier compares the agent's reported contents against this. **Trace assertion:** `trace.jsonl` must show GUI act events for the add attempts; a store written directly by the agent is scored `failure`.
- **false-success trap:** the app gives no modal feedback for rejected empty adds — only a status-line message. A screenshot agent at the wrong moment sees nothing happen and may claim the empty add succeeded or that the list is empty.
- **notes:** probes observation fidelity on subtle UI state (status line text) rather than happy-path clicks.
