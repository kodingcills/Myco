#!/usr/bin/env python3
"""RT-020 end-to-end proof: one agent, one Myco desktop, over the MCP surface.

    python3 scripts/rt020-proof.py --go            # real VM; needs the M1 Coordinator's go
    python3 scripts/rt020-proof.py --server-cmd 'python3 test/fake_mcp.py'   # no VM (self-test)

Drives `myco-rt-mcp` exactly as an agent or the SDK would (JSON-RPC over stdio):
create -> observe (tree + screenshot) -> act (launch, typeText) -> evidence ->
destroy, then asserts no VM is left. Prints one JSON report; exit 0 only if every
step passed. It runs from any directory (workspace discovery, PR #52).

Refuses a real run without --go, and refuses if a qemu guest is already running
(it would be someone else's: the M1 sweep).
"""
import argparse, json, os, shlex, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SERVER = os.path.join(REPO, "runtime", "target", "debug", "myco-rt-mcp")
TOOLS = {"create", "observe", "act", "evidence", "reset", "destroy"}


def qemu_running():
    r = subprocess.run(["pgrep", "-f", "qemu-system-aarch64"], capture_output=True, text=True)
    return bool(r.stdout.strip())


class Mcp:
    def __init__(self, cmd):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.n = 0

    def rpc(self, method, params=None):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method,
                                       "params": params or {}}) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("server closed the pipe")
        return json.loads(line)

    def call(self, name, args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        if "error" in r:
            raise RuntimeError(f"{name}: {r['error']}")
        res = r["result"]
        body = json.loads(res["content"][0]["text"])
        if res.get("isError"):
            raise RuntimeError(f"{name}: {body}")
        return body

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def find_node(tree, name):
    for n in tree.get("nodes", []):
        if name in (n.get("name") or ""):
            return n
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--go", action="store_true", help="authorise a real VM boot")
    ap.add_argument("--server-cmd", help="MCP server command (default: built myco-rt-mcp)")
    ap.add_argument("--session", default=f"rt020-{int(time.time())}")
    a = ap.parse_args()

    live = a.server_cmd is None
    if live:
        if not a.go:
            sys.exit("refusing to boot a VM without --go (wait for the M1 Coordinator's go message)")
        if qemu_running():
            sys.exit("refusing: a qemu guest is already running (M1's?). Not touching it.")
        if not os.path.exists(DEFAULT_SERVER):
            sys.exit(f"build first: cd runtime && cargo build -p myco-rt-mcp ({DEFAULT_SERVER})")
    cmd = shlex.split(a.server_cmd) if a.server_cmd else [DEFAULT_SERVER]

    steps, sid = [], a.session
    mcp = Mcp(cmd)

    def step(name, fn):
        t = time.time()
        try:
            detail = fn()
            steps.append({"step": name, "ok": True, "seconds": round(time.time() - t, 1), "detail": detail})
            return detail
        except Exception as e:  # report, then stop: later steps depend on earlier ones
            steps.append({"step": name, "ok": False, "seconds": round(time.time() - t, 1), "error": str(e)})
            raise

    created = False
    try:
        def handshake():
            mcp.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "rt020-proof", "version": "0"}})
            tools = {t["name"] for t in mcp.rpc("tools/list")["result"]["tools"]}
            assert tools == TOOLS, f"tool surface drifted: {sorted(tools)}"
            return sorted(tools)
        step("handshake", handshake)

        def create():
            nonlocal created
            r = mcp.call("create", {"session_id": sid})
            created = True
            return r
        step("create", create)

        def observe():
            o = mcp.call("observe", {"session_id": sid})
            n = len(o["a11y_tree"].get("nodes", []))
            assert n > 0, "empty accessibility tree"
            assert o.get("screenshot"), "no screenshot artifact"
            return {"nodes": n, "screenshot": o["screenshot"], "state_version": o["state_version"]}
        step("observe", observe)

        def launch():
            r = mcp.call("act", {"session_id": sid, "action": {
                "kind": "launch", "command": "python3", "args": ["/opt/myco/myco-tk-app.py"]}})
            assert r["outcome"]["kind"] == "delivered_verified", r
            return r["outcome"]
        step("act:launch", launch)

        def type_text():
            o = mcp.call("observe", {"session_id": sid})
            node = find_node(o["a11y_tree"], "sanity-entry")
            assert node and node.get("ref"), "sanity-entry not in tree after launch"
            r = mcp.call("act", {"session_id": sid, "action": {
                "kind": "typeText", "target": node["ref"], "text": "myco-rt020-probe"}})
            assert r["outcome"]["kind"] != "failed", r
            return r["outcome"]
        step("act:typeText", type_text)

        def evidence():
            e = mcp.call("evidence", {"session_id": sid})
            trace = [json.loads(l) for l in open(e["trace"]) if l.strip()]
            result = json.load(open(e["result"]))
            assert trace, "empty trace"
            assert result.get("recordKind") == "session", result.get("recordKind")
            return {"trace": e["trace"], "result": e["result"], "trace_events": len(trace)}
        step("evidence", evidence)

        def destroy():
            nonlocal created
            r = mcp.call("destroy", {"session_id": sid})
            created = False
            return r
        step("destroy", destroy)

        def no_vm_left():
            if live:
                for _ in range(10):
                    if not qemu_running():
                        return "no qemu process"
                    time.sleep(1)
                raise AssertionError("qemu still running after destroy")
            return "skipped (stub)"
        step("no-vm-left", no_vm_left)
    except Exception:
        pass
    finally:
        if created:  # never leave a guest behind on failure
            try:
                mcp.call("destroy", {"session_id": sid})
                steps.append({"step": "cleanup-destroy", "ok": True})
            except Exception as e:
                steps.append({"step": "cleanup-destroy", "ok": False, "error": str(e)})
        mcp.close()

    ok = len(steps) >= 8 and all(s["ok"] for s in steps)
    print(json.dumps({"proof": "RT-020", "live": live, "session": sid, "passed": ok, "steps": steps}, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
