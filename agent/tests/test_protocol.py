import json
import socket

from myco_agent.protocol import AUTH_FAILED, BAD_REQUEST, handle_request
from myco_agent.fake_backend import FakeBackend

TOKEN = "unit-token"


def call(payload, backend=None):
    return handle_request(json.dumps(payload).encode(), backend or FakeBackend(), TOKEN)


def test_ping():
    r = call({"id": 7, "token": TOKEN, "op": "ping", "params": {}})
    assert r["ok"] and r["id"] == 7 and r["result"]["agent_version"]


def test_wrong_token_before_unknown_op():
    r = call({"id": 1, "token": "bad", "op": "nonexistent"})
    assert r["error"]["code"] == AUTH_FAILED


def test_unknown_op():
    r = call({"id": 1, "token": TOKEN, "op": "nonexistent"})
    assert r["error"]["code"] == "UNKNOWN_OP"


def test_bad_json():
    r = handle_request(b"{broken", FakeBackend(), TOKEN)
    assert r["error"]["code"] == BAD_REQUEST


def test_non_object_json():
    r = handle_request(b"[1]", FakeBackend(), TOKEN)
    assert r["error"]["code"] == BAD_REQUEST
