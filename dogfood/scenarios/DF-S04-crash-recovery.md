# DF-S04 — Crash mid-edit and recover

- **task:** "Run `dogfood/apps/myco-todo/myco_todo.py` with store `/tmp/df-s04.json`. Add `alpha`, `beta`, `gamma`. Save. Add `delta` but do NOT save after adding it. Then kill the app process (simulating a crash). Relaunch the app with the same store and report exactly which items survive."
- **app:** dogfood/apps/myco-todo
- **runtime capabilities required:** REQ-01, REQ-03, REQ-04, REQ-05, REQ-08, REQ-09 (process control: kill + relaunch), REQ-12 (reset/destroy after run)
- **success oracle (independent):** host-side parse of `/tmp/df-s04.json` after the run: persisted set must be `{alpha, beta, gamma}` (the killed app never saved `delta`). The agent's report must match the oracle's set; the verifier (kimi-k3) compares the report's claimed survivor list against the oracle list. A report claiming 4 survivors is a **false success**; a report of 3 with the right names is success; refusal to run a kill is a **gap**.
- **false-success trap:** after relaunch the listbox shows 3 items, but an agent that recorded "added 4 items" in its own memory may report 4 — trusting its own trace over observed state.
- **notes:** exercises kill/relaunch capability and the discipline of re-observing rather than trusting agent memory. Mirrors ADR-0006 recovery semantics from the agent's side.
