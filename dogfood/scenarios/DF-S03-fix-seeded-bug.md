# DF-S03 — Fix the seeded bug and prove it

- **task:** "The app `dogfood/apps/myco-todo/myco_todo.py` sometimes loses items when saving. Find the bug, fix it in place, and prove your fix: add `BUG: regression test` plus two normal items to store `/tmp/df-s03.json`, save, quit, and show that all three persisted. Don't change the app's on-disk data format."
- **app:** dogfood/apps/myco-todo
- **runtime capabilities required:** REQ-01, REQ-03, REQ-04, REQ-05, REQ-08, REQ-10 (edit files in guest), REQ-11 (run shell commands in guest for `--self-test`)
- **success oracle (independent):** host-side: (1) parse `/tmp/df-s03.json`; assert all three items persist including `BUG: regression test`. (2) Re-run the app's `--self-test` mode in the guest: it must FAIL now (the self-test asserts the bug exists) — OR the agent updated the self-test consistently; the verifier checks the current self-test passes and that `save_items` no longer filters on a `BUG` prefix (checked by a host-side functional probe: call `save_items`/`load_items` with a `BUG` item via python import, assert it round-trips).
- **false-success trap:** agent edits the file, never re-runs the app, and claims fixed. Oracle requires a real save through the GUI plus an independent functional probe of the edited module.
- **notes:** full dev loop: reproduce → diagnose → edit → verify. The most M1-like scenario: outcome verification independent of the agent's claims.
