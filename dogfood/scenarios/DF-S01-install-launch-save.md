# DF-S01 — Install, launch, add, save, verify

- **task:** "On this desktop, install/run the app at `dogfood/apps/myco-todo/myco_todo.py` with store `/tmp/df-s01.json`. Add three items: `buy milk`, `write report`, `call mom`. Save. Quit. Report what you did."
- **app:** dogfood/apps/myco-todo
- **runtime capabilities required:** REQ-01 (create), REQ-03 (observe), REQ-04 (act: type/click), REQ-05 (evidence), REQ-06 (reset), REQ-08 (file read host-side)
- **success oracle (independent):** host-side: parse `/tmp/df-s01.json` from the guest; assert it exists and `sorted(item["text"] for item in items) == ["buy milk", "call mom", "write report"]`. The agent's report is not consulted.
- **false-success trap:** the app status bar says "saved 3 item(s)" regardless of what persisted; an agent trusting UI text passes itself even if the save failed.
- **notes:** the happy path. Establishes that create→observe→act→persist→verify works end to end before any bug hunting.
