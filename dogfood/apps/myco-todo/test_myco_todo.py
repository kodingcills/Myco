import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import myco_todo


class WidgetCenterTest(unittest.TestCase):
    """Headless: the geometry rule, without a display.

    The GUI test above skips wherever Tk is unavailable, which is most CI
    images. This one always runs, so a change to the coordinate rule cannot
    pass unnoticed.
    """

    class FakeWidget:
        def __init__(self, rootx, rooty, width, height):
            self._rootx, self._rooty = rootx, rooty
            self._width, self._height = width, height

        def winfo_rootx(self):
            return self._rootx

        def winfo_rooty(self):
            return self._rooty

        def winfo_width(self):
            return self._width

        def winfo_height(self):
            return self._height

    def test_centre_is_screen_absolute(self):
        """`clickAt` takes screen coordinates, so the centre must be too.

        One case pins both properties at once: the value is the widget's centre
        (not a corner), and it is in screen space (no window origin removed).
        The round-1 bug published `rootx - toplevel_rootx + w//2`, which for a
        window at screen (100, 85) gave (194, 19) instead of (294, 104) — a
        click on the title bar, silently.
        """
        # Widget at screen (144, 92), 300x24 -> centre (294, 104).
        widget = self.FakeWidget(144, 92, 300, 24)
        self.assertEqual(myco_todo.TodoApp.widget_center(widget),
                         {"x": 294, "y": 104, "width": 300, "height": 24})
        # A different window origin must not shift the answer: same widget
        # geometry, different absolute position, different centre.
        moved = self.FakeWidget(144 + 37, 92 + 11, 300, 24)
        self.assertEqual(myco_todo.TodoApp.widget_center(moved),
                         {"x": 331, "y": 115, "width": 300, "height": 24})

    def test_unmapped_widget_has_no_centre(self):
        for width, height in ((1, 24), (300, 1), (0, 0)):
            widget = self.FakeWidget(0, 0, width, height)
            self.assertIsNone(myco_todo.TodoApp.widget_center(widget),
                              f"{width}x{height} is not mapped")

    def test_broken_widget_does_not_raise(self):
        class Broken:
            def winfo_rootx(self):
                raise RuntimeError("gone")

        self.assertIsNone(myco_todo.TodoApp.widget_center(Broken()))


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
                published = json.loads(state.read_text())
                # TIF-122: the runner's global route clicks these points, so a
                # missing or malformed record is a REQ-03 gap at run time.
                entry_field = published.pop("entry_field")
                save_button = published.pop("save_button")
                for name, geom in (("entry_field", entry_field), ("save_button", save_button)):
                    self.assertIsNotNone(geom, f"{name} must be published once mapped")
                    self.assertEqual(sorted(geom), ["height", "width", "x", "y"])
                    for key, value in geom.items():
                        self.assertIsInstance(value, int, f"{name}.{key} must be an int")
                    self.assertGreater(geom["width"], 1)
                    self.assertGreater(geom["height"], 1)
                # The Save button sits below the entry in a vertical stack, so
                # these are genuinely different points (not both 0,0).
                self.assertNotEqual((entry_field["x"], entry_field["y"]),
                                    (save_button["x"], save_button["y"]))
                self.assertGreater(save_button["y"], entry_field["y"])
                self.assertEqual(published, {
                    "listbox_rows": ["buy milk", "BUG hidden"],
                    "listbox_selection": [],
                    "status_text": "saved 2 item(s)",
                    "entry_text": "",
                })
