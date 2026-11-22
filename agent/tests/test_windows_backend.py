"""Off-Windows unit tests for WindowsBackend helpers: timeout config parsing,
SendKeys escaping, timeout classification, element caps, import guard.

Everything touching real COM/UIA runs on the VM (validation section of
M1-006); these pin the pure-Python contracts.
"""

import importlib
import sys

import pytest


def _load_windows_backend():
    import myco_agent.windows_backend as wb

    importlib.reload(wb_mod if (wb_mod := sys.modules.get("myco_agent.windows_backend")) else wb)
    return sys.modules["myco_agent.windows_backend"]


@pytest.fixture()
def wb(monkeypatch):
    import myco_agent.windows_backend as module

    monkeypatch.delenv("MYCO_UIA_CONNECT_TIMEOUT_MS", raising=False)
    monkeypatch.delenv("MYCO_UIA_TRANSACTION_TIMEOUT_MS", raising=False)
    return importlib.reload(module)


# ----------------------------------------------------------------- timeouts

def test_default_timeouts(wb):
    assert wb._connect_timeout_ms() == 5000
    assert wb._transaction_timeout_ms() == 10000


def test_env_timeouts(wb, monkeypatch):
    monkeypatch.setenv("MYCO_UIA_CONNECT_TIMEOUT_MS", "2500")
    monkeypatch.setenv("MYCO_UIA_TRANSACTION_TIMEOUT_MS", "40000")
    assert wb._connect_timeout_ms() == 2500
    assert wb._transaction_timeout_ms() == 40000


def test_env_timeouts_reject_garbage_and_negatives(wb, monkeypatch):
    monkeypatch.setenv("MYCO_UIA_CONNECT_TIMEOUT_MS", "soon")
    assert wb._connect_timeout_ms() == 5000  # falls back to default
    monkeypatch.setenv("MYCO_UIA_CONNECT_TIMEOUT_MS", "-100")
    assert wb._connect_timeout_ms() == 0  # clamped at zero


class _FakeHresult:
    value = 0x80131505


def test_is_timeout_error_recognizes_uia_timeout(wb):
    class COMError(Exception):
        hresult = _FakeHresult()

    assert wb._is_timeout_error(COMError("The operation timed out"))


def test_is_timeout_error_plain_exception_false(wb):
    assert not wb._is_timeout_error(ValueError("nope"))


def test_is_timeout_error_timeout_error_true(wb):
    assert wb._is_timeout_error(TimeoutError())


# ------------------------------------------------------------------ sendkeys

def test_sendkeys_escape_braces_metacharacters(wb):
    # each special char is individually braced
    assert wb._sendkeys_escape("a{b}c") == "a{{}b{}}c"
    assert wb._sendkeys_escape("50%") == "50{%}"
    assert wb._sendkeys_escape("(x)") == "{(}x{)}"
    assert wb._sendkeys_escape("a+b") == "a{+}b"
    assert wb._sendkeys_escape("plain-text 42") == "plain-text 42"


def test_sendkeys_escape_non_string_input(wb):
    assert wb._sendkeys_escape(42) == "42"


# --------------------------------------------------------------- caps / guards

def test_max_elements_and_windows_are_bounded(wb):
    assert wb.MAX_ELEMENTS == 3000
    assert wb.MAX_WINDOWS == 8
    assert wb.MAX_SEARCH_DEPTH >= 8  # deep enough to reach Calc's Name Box


def test_backend_rejects_non_windows(monkeypatch):
    from myco_agent.windows_backend import WindowsBackend

    monkeypatch.setattr(sys, "platform", "darwin")
    with pytest.raises(RuntimeError, match="requires Windows"):
        WindowsBackend()


def test_import_on_mac_os_is_clean():
    import myco_agent.windows_backend  # noqa: F401


def test_uia_tree_bad_depth_is_op_error(wb, monkeypatch):
    """depth < 0 must raise BAD_REQUEST before touching the desktop."""
    from myco_agent.protocol import OpError

    monkeypatch.setattr(wb.os, "name", "nt")
    backend = wb.WindowsBackend()
    with pytest.raises(OpError) as exc:
        backend.uia_tree(depth=-1)
    assert exc.value.code == "BAD_REQUEST"


def test_screenshot_bad_rect_is_op_error(wb, monkeypatch):
    from myco_agent.protocol import OpError

    monkeypatch.setattr(wb.os, "name", "nt")
    backend = wb.WindowsBackend()
    with pytest.raises(OpError) as exc:
        backend.screenshot(rect=[1, 2, 3])
    assert exc.value.code == "BAD_REQUEST"
    with pytest.raises(OpError):
        backend.screenshot(rect=[1, 2, 3, "x"])


# ----------------------------------------------------------------- kill


def _backend_with_image(wb, monkeypatch, live_pids):
    """A WindowsBackend with a scripted process listing and controlled taskkill
    outcome, so the kill contract can be pinned off-Windows.

    `_pids_of_image` is called twice per image kill (before, after). The second
    call reports the post-kill state, which is what makes "died" and "survived"
    distinguishable at all - the distinction the old code could not make.
    """
    backend = wb.WindowsBackend.__new__(wb.WindowsBackend)
    calls = {"n": 0}
    after = {"pids": []}  # what the SECOND listing reports (post-kill truth)

    def fake_pids_of_image(image_name):
        calls["n"] += 1
        return list(live_pids) if calls["n"] == 1 else list(after["pids"])

    monkeypatch.setattr(wb.WindowsBackend, "_pids_of_image", staticmethod(fake_pids_of_image))
    return backend, after


def _script_taskkill(monkeypatch, returncode):
    """Control taskkill's exit status and record the argv it was invoked with."""
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)

        class P:
            pass

        p = P()
        p.returncode = returncode
        p.stdout = ""
        p.stderr = "" if returncode == 0 else "ERROR: The process could not be terminated."
        return p

    monkeypatch.setattr("subprocess.run", fake_run)
    return calls


def test_kill_reports_success_when_process_dies(wb, monkeypatch):
    backend, after = _backend_with_image(wb, monkeypatch, [3708])
    _script_taskkill(monkeypatch, 0)
    after["pids"] = []  # the kill worked
    result = backend.kill(image_name="soffice.bin")
    assert result["killed"] == [3708]
    assert "errors" not in result


def test_kill_reports_error_when_the_process_survives(wb, monkeypatch):
    """The 2026-11-22 failure shape: taskkill fails, the process is still there,
    and the caller is told nothing. killed=[] must not read as "guest is clean"."""
    backend, after = _backend_with_image(wb, monkeypatch, [3708])
    _script_taskkill(monkeypatch, 1)
    after["pids"] = [3708]  # it survived
    result = backend.kill(image_name="soffice.bin")
    assert result["killed"] == []
    assert result["errors"], "a failed kill that left the process alive must be reported"
    assert "survivors=[3708]" in result["errors"][0]


def test_kill_reports_error_on_nonzero_rc_even_if_the_process_died(wb, monkeypatch):
    backend, after = _backend_with_image(wb, monkeypatch, [3708])
    _script_taskkill(monkeypatch, 1)
    after["pids"] = []  # died despite the non-zero returncode
    result = backend.kill(image_name="soffice.bin")
    assert result["killed"] == [3708]
    assert result["errors"], "a non-zero taskkill returncode is reported even when nothing survives"


def test_kill_says_nothing_when_there_was_nothing_to_kill(wb, monkeypatch):
    """An empty process list is success, not an error - the distinction the old
    code could not make."""
    backend, _ = _backend_with_image(wb, monkeypatch, [])
    _script_taskkill(monkeypatch, 0)
    result = backend.kill(image_name="soffice.bin")
    assert result["killed"] == []
    assert "errors" not in result
