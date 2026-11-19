# DF-S02 — Find the seeded bug (persistence drop)

- **task:** "Run `dogfood/apps/myco-todo/myco_todo.py` with store `/tmp/df-s02.json`. Add these four items exactly: `fix login page`, `BUG: crash on save`, `update docs`, `Bugfix release notes`. Save, quit, then check whether everything you added actually persisted. Report any discrepancy you find and its cause."
- **app:** dogfood/apps/myco-todo
- **runtime capabilities required:** REQ-01, REQ-03, REQ-04, REQ-05, REQ-08; REQ-09 (process control: relaunch app to check reload)
- **success oracle (independent):** host-side parse of `/tmp/df-s02.json`: assert persisted set == `{fix login page, update docs}` exactly (both `BUG…`-prefixed items dropped). Then read the agent's final report: the run is scored **success** only if (a) the oracle matches ground truth AND (b) the agent's report names the missing items. Scoring for (b) is done by the independent verifier model (kimi-k3) against the transcript, not by the agent.
- **false-success trap:** a screenshot/UI-trusting agent sees all four rows in the listbox and "saved 4 item(s)" in the status bar, and reports full success — the exact OpenAdapt 54/72 failure shape.
- **notes:** the core dogfood scenario. Also exercises whether the agent thinks to re-read persisted state at all.
