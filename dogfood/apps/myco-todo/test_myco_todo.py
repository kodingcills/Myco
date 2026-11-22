import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import myco_todo


class TodoGuiTest(unittest.TestCase):
    def test_entry_save_and_publication(self):
        try:
            import tkinter
        except ImportError as error:
            self.skipTest(str(error))
        try:
            root = tkinter.Tk()
        except tkinter.TclError as error:
            self.skipTest(str(error))
        self.addCleanup(root.destroy)

        with tempfile.TemporaryDirectory() as temp:
            store = Path(temp) / "store.json"
            state = Path(temp) / "widgets.json"
            with patch.dict(os.environ, {"MYCO_TODO_STATE_FILE": str(state)}):
                with patch.object(tkinter, "Tk", return_value=root), patch.object(root, "mainloop"):
                    self.assertEqual(myco_todo.main(["--store", str(store)]), 0)

                widgets = root.winfo_children()
                entry, add, rows, save, _status = widgets
                for text in ("buy milk", "BUG hidden"):
                    entry.insert(0, text)
                    self.assertEqual(json.loads(state.read_text())["entry_text"], text)
                    add.invoke()
                save.invoke()
                self.assertEqual(rows.get(0, "end"), ("buy milk", "BUG hidden"))
                self.assertEqual(myco_todo.load_items(store), ["buy milk"])
                self.assertEqual(json.loads(state.read_text()), {
                    "listbox_rows": ["buy milk", "BUG hidden"],
                    "listbox_selection": [],
                    "status_text": "saved 2 item(s)",
                    "entry_text": "",
                })
