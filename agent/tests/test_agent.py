import base64
import json
import os
import socket

import pytest

from myco_agent.backend import OpsBackend, select_backend
from myco_agent.fake_backend import FakeBackend
from myco_agent.protocol import AUTH_FAILED, BAD_REQUEST, UNKNOWN_OP, handle_request
from myco_agent.server import AgentServer, read_token

TOKEN = "test-token-1234"
HOST = "127.0.0.1"


class Client:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=5)
        self.f = self.sock.makefile("rwb")

    def readline(self):
        return self.f.readline()

    def send_raw(self, data):
        self.f.write(data)
        self.f.flush()

    def request(self, payload):
        self.send_raw(json.dumps(payload).encode() + b"\n")
        return json.loads(self.f.readline())

    def close(self):
        self.f.close()
        self.sock.close()


@pytest.fixture()
def backend():
    return FakeBackend()


@pytest.fixture()
def server(backend, tmp_path):
    token_path = tmp_path / "agent.token"
    token_path.write_text(TOKEN + "\n")
    assert read_token(str(token_path)) == TOKEN
    srv = AgentServer(HOST, 0, TOKEN, backend)
    import threading

    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def port(server):
    return server.server_address[1]


@pytest.fixture()
def client(port):
    c = Client(port)
    yield c
    c.close()


def req(op, **params):
    return {"id": 1, "token": TOKEN, "op": op, "params": params}


def test_ping_round_trip(client):
    r = client.request(req("ping"))
    assert r["ok"] is True
    assert r["id"] == 1
    assert r["result"]["agent_version"]
    assert r["result"]["session_id"]
    assert r["result"]["backend"] == "fake"


def test_session_info_round_trip(client):
    r = client.request(req("session_info"))
    assert r["ok"] is True
    assert set(r["result"]) == {"session_id", "window_station", "desktop", "user"}


def test_auth_rejection_missing_and_wrong_token(port):
    for payload in (
        {"id": 1, "op": "ping", "params": {}},
        {"id": 2, "token": "wrong", "op": "ping", "params": {}},
    ):
        c = Client(port)
        r = c.request(payload)
        c.close()
        assert r["ok"] is False
        assert r["error"]["code"] == AUTH_FAILED


def test_malformed_ndjson(client):
    client.send_raw(b"this is not json\n")
    r = json.loads(client.readline())
    assert r["ok"] is False
    assert r["error"]["code"] == BAD_REQUEST
    client.send_raw(b"[1,2,3]\n")
    r = json.loads(client.readline())
    assert r["ok"] is False
    assert r["error"]["code"] == BAD_REQUEST
    r = client.request(req("nope"))
    assert r["ok"] is False
    assert r["error"]["code"] == UNKNOWN_OP


def test_missing_required_param(client):
    r = client.request({"id": 1, "token": TOKEN, "op": "read_file", "params": {}})
    assert r["ok"] is False
    assert r["error"]["code"] == BAD_REQUEST


def test_file_round_trip_base64(client, backend, tmp_path):
    payload = os.urandom(2048)
    w = client.request(req("write_file", path="artifacts/blob.bin", data_b64=base64.b64encode(payload).decode()))
    assert w["ok"] is True
    assert w["result"]["bytes"] == len(payload)
    r = client.request(req("read_file", path="artifacts/blob.bin"))
    assert r["ok"] is True
    assert base64.b64decode(r["result"]["data_b64"]) == payload
    assert open(backend.resolve("artifacts/blob.bin"), "rb").read() == payload


def test_read_missing_file(client):
    r = client.request(req("read_file", path="does/not/exist"))
    assert r["ok"] is False
    assert r["error"]["code"] == "OP_FAILED"


def test_launch_uia_tree_screenshot(client, backend):
    backend.add_window("soffice.bin", "Untitled 1 - LibreOffice Calc", [
        {"control_type": "Edit", "name": "A1"},
        {"control_type": "Button", "name": "Save"},
    ])
    l = client.request(req("launch", argv=["C:\\Program Files\\LibreOffice\\program\\soffice.bin", "--calc"]))
    assert l["ok"] is True
    pid = l["result"]["pid"]
    assert isinstance(pid, int)

    t = client.request(req("uia_tree", pid=pid, depth=8))
    assert t["ok"] is True
    windows = t["result"]["windows"]
    assert len(windows) == 1
    win = windows[0]
    assert win["title"] == "Untitled 1 - LibreOffice Calc"
    assert {c["name"] for c in win["children"]} == {"A1", "Save"}

    i = client.request(req("uia_invoke", runtime_id=win["children"][0]["runtime_id"], action="invoke"))
    assert i["ok"] is True
    assert i["result"]["delivered"] is True

    s = client.request(req("screenshot", pid=pid))
    assert s["ok"] is True
    png = base64.b64decode(s["result"]["png_b64"])
    assert png.startswith(b"\x89PNG\r\n\x1a\n")

    k = client.request(req("kill", pid=pid))
    assert k["ok"] is True
    t2 = client.request(req("uia_tree", pid=pid))
    assert t2["ok"] is True
    assert t2["result"]["windows"] == []
    s2 = client.request(req("screenshot", pid=pid))
    assert s2["ok"] is False


def test_uia_tree_depth_zero(client, backend):
    backend.add_window("calc.exe", "Main")
    l = client.request(req("launch", argv=["calc.exe"]))
    pid = l["result"]["pid"]
    t = client.request(req("uia_tree", pid=pid, depth=0))
    assert t["ok"] is True
    assert t["result"]["windows"][0]["children"] == []


def test_uno_eval_round_trip(client, backend):
    backend.set_cell_values({"B7": 42})
    r = client.request(req("uno_eval", call="get_value", cell="B7", socket="2002"))
    assert r["ok"] is True
    assert r["result"]["value"] == 42
    r = client.request(req("uno_eval", call="get_value", cell="B7"))
    assert r["ok"] is False
    assert r["error"]["code"] == "OP_FAILED"


def test_crash_on_command_returns_op_failed_not_dead(client, backend, port):
    backend.crash_on("uia_tree")
    r = client.request(req("uia_tree"))
    assert r["ok"] is False
    assert r["error"]["code"] == "OP_FAILED"
    c2 = Client(port)
    pong = c2.request(req("ping"))
    c2.close()
    assert pong["ok"] is True


def test_server_survives_client_disconnect_mid_request(server, backend):
    port = server.server_address[1]
    sock = socket.create_connection((HOST, port), timeout=5)
    sock.sendall(json.dumps(req("ping")).encode()[:20])
    sock.close()
    c = Client(port)
    pong = c.request(req("ping"))
    c.close()
    assert pong["ok"] is True


def test_multiple_requests_one_connection(client):
    for i in range(5):
        r = client.request({"id": i, "token": TOKEN, "op": "ping", "params": {}})
        assert r["id"] == i
        assert r["ok"] is True


def test_select_backend_fake_and_reject_unknown():
    assert isinstance(select_backend("fake"), FakeBackend)
    assert isinstance(FakeBackend(), OpsBackend)
    try:
        select_backend("bogus")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_windows_backend_import_fails_clean_off_windows():
    import sys

    from myco_agent import windows_backend

    if sys.platform == "win32":
        return
    import pytest

    with pytest.raises(RuntimeError):
        windows_backend.WindowsBackend()
