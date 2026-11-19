# myco-todo

Minimal Tkinter GUI todo app used as the app-under-test for Myco dogfood scenarios.

- **Runs on:** any Linux with Python 3 + Tkinter (`apt install python3-tk`), macOS, Windows. The Myco Desktop Runtime's first host is expected to be Linux ARM64; this app has zero dependencies beyond the stdlib + Tk.
- **Persisted outcome:** a JSON store (default `~/.myco-todo.json`, override with `--store`).
- **Seeded bug:** items whose text starts with `BUG` (case-insensitive) appear in the on-screen list but are silently dropped at save. The UI never reports this. See the module docstring in `myco_todo.py`.

## Run

```sh
python3 myco_todo.py                    # GUI
python3 myco_todo.py --self-test        # headless logic check, no display needed
```

## Why this app

The seeded bug reproduces the false-success shape M1 exists to kill: an agent
that trusts the UI ("the status bar said saved 3 item(s)") reports success,
while the persisted file disagrees. Dogfood scenarios use an independent oracle
(parse the JSON store host-side) so the agent's own claims are never evidence.
