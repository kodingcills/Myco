#!/usr/bin/env python3
"""myco-todo — minimal Tkinter GUI todo app for Myco dogfooding.

Deliberately small: entry field, Add button, listbox, Save button.
State persists to a JSON file. This is the "app under test" for
dogfood scenarios — an agent driving a desktop must exercise it,
and an independent oracle must check its persisted state.

SEEDED BUG (intentional, do not fix in this file):
    When an item's text starts with the string "BUG" (case-insensitive),
    the item appears in the on-screen list but is silently dropped from
    the saved JSON file. The app shows no error. An agent that trusts
    the UI will report success; only a verifier that reads the persisted
    file catches it. This reproduces the exact false-success shape M1
    exists to kill (OpenAdapt's 54/72 bad saves reported as saved).

Data model on disk: {"items": [{"text": str, "added_at": ISO-8601}, ...]}
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import sys
from datetime import datetime, timezone
from pathlib import Path

if False:  # type hints only; tkinter is imported lazily in main()
    import tkinter as tk

DEFAULT_STORE = Path.home() / ".myco-todo.json"


def load_items(store: Path) -> list[str]:
    if not store.exists():
        return []
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return [entry["text"] for entry in data.get("items", []) if "text" in entry]


def save_items(store: Path, items: list[str]) -> None:
    # SEEDED BUG: items whose text starts with "BUG" are dropped at save.
    persisted = [t for t in items if not t.strip().upper().startswith("BUG")]
    payload = {
        "items": [
            {"text": t, "added_at": datetime.now(timezone.utc).isoformat()}
            for t in persisted
        ]
    }
    store.write_text(json.dumps(payload, indent=2), encoding="utf-8")


class TodoApp:
    def __init__(self, root: tk.Tk, store: Path):
        self.store = store
        state_file = os.environ.get("MYCO_TODO_STATE_FILE")
        self.state_file = Path(state_file) if state_file else None
        root.title("myco-todo")
        root.geometry("420x360")

        self.entry_text = tk.StringVar(master=root)
        self.entry = tk.Entry(root, width=40, textvariable=self.entry_text)
        self.entry.pack(pady=8, padx=8, fill=tk.X)
        self.entry.focus_set()

        self.add_button = tk.Button(root, text="Add", command=self.add_item)
        self.add_button.pack(pady=2)

        self.listbox = tk.Listbox(root, width=50, height=12)
        self.listbox.pack(pady=8, padx=8, fill=tk.BOTH, expand=True)

        self.save_button = tk.Button(root, text="Save", command=self.save)
        self.save_button.pack(pady=2)

        self.status = tk.Label(root, text="", anchor="w")
        self.status.pack(fill=tk.X, padx=8)

        for text in load_items(store):
            self.listbox.insert(tk.END, text)

        self.entry.bind("<Return>", lambda _e: self.add_item())
        if self.state_file is not None:
            self.entry_text.trace_add("write", lambda *_: self.publish_state())
            self.listbox.bind("<<ListboxSelect>>", lambda _event: self.publish_state())
            # A window-manager move or resize changes every screen coordinate.
            # Without this the published point goes stale and a click lands
            # somewhere else, silently.
            root.bind("<Configure>", lambda _event: self.publish_state())
            self.publish_state()

    @staticmethod
    def widget_center(widget) -> dict[str, int] | None:
        """Centre of `widget` in SCREEN coordinates, or None.

        A driver that cannot reach an app through accessibility (Tk registers
        zero AT-SPI nodes) still needs a point to click to move focus. The
        runtime's `clickAt` takes **guest screen coordinates** — "origin is
        top-left of the primary display" (xa11y `Point`), and the agent passes
        them straight to XTest — so this must be screen-absolute.

        `winfo_rootx()`/`winfo_rooty()` are already screen-absolute. Do NOT
        subtract the toplevel's origin: that yields a window-relative point,
        which `clickAt` would interpret as a screen point and land somewhere
        else entirely (usually the title bar or another window), silently.

        Recomputed on every publish: geometry is not final until the window
        maps, and changes on resize or a window-manager move. Returns None
        while unmapped (width or height <= 1) so a consumer cannot click a
        not-yet-placed pixel.
        """
        try:
            width, height = widget.winfo_width(), widget.winfo_height()
            if width <= 1 or height <= 1:
                return None
            return {
                "x": widget.winfo_rootx() + width // 2,
                "y": widget.winfo_rooty() + height // 2,
                "width": width,
                "height": height,
            }
        except Exception:  # noqa: BLE001 - geometry is best-effort metadata
            return None

    def publish_state(self) -> None:
        if self.state_file is None:
            return
        state = {
            "listbox_rows": self.listbox.get(0, tk.END),
            "listbox_selection": [self.listbox.get(i) for i in self.listbox.curselection()],
            "status_text": self.status.cget("text"),
            "entry_text": self.entry_text.get(),
            # TIF-122: the runner's global route needs click targets. Without
            # these it gaps on REQ-03 with "no entry_field geometry" even when
            # the introspection channel is wired.
            "entry_field": self.widget_center(self.entry),
            "save_button": self.widget_center(self.save_button),
        }
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.state_file.parent, delete=False
        ) as staged:
            temporary = Path(staged.name)
            try:
                json.dump(state, staged)
                staged.close()
                temporary.replace(self.state_file)
            finally:
                temporary.unlink(missing_ok=True)

    def add_item(self) -> None:
        text = self.entry.get().strip()
        if not text:
            self.status.config(text="nothing to add")
            self.publish_state()
            return
        self.listbox.insert(tk.END, text)
        self.entry.delete(0, tk.END)
        self.status.config(text=f"added: {text}")
        self.publish_state()

    def save(self) -> None:
        items = list(self.listbox.get(0, tk.END))
        save_items(self.store, items)
        # Note: status reports the on-screen count, not the persisted count.
        self.status.config(text=f"saved {len(items)} item(s)")
        self.publish_state()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="myco-todo dogfood sample app")
    parser.add_argument(
        "--store",
        type=Path,
        default=DEFAULT_STORE,
        help="path to the JSON store (default: ~/.myco-todo.json)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="headless check of load/save logic (no display needed)",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "store.json"
            save_items(store, ["buy milk", "BUG in parser", "call mom"])
            loaded = load_items(store)
            assert loaded == ["buy milk", "call mom"], loaded
            print("self-test OK: seeded bug present ('BUG in parser' dropped)")
        return 0

    global tk
    import tkinter as tk  # lazy: --self-test and the oracle work without a display

    root = tk.Tk()
    TodoApp(root, args.store)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
