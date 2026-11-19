"""NDJSON server for myco-agent.

Uses a threading socketserver rather than asyncio: requests are blocking
desktop operations (UIA, screenshot) that naturally parallelize per
connection and gain nothing from an event loop.
"""

import json
import socketserver
import threading

from .protocol import handle_request


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        while True:
            try:
                line = self.rfile.readline()
            except (ConnectionError, OSError):
                return
            if not line:
                return
            if not line.strip():
                continue
            try:
                response = handle_request(line, self.server.backend, self.server.token)
            except Exception:
                response = {"ok": False, "id": None, "error": {"code": "INTERNAL", "message": "unhandled"}}
            try:
                self.wfile.write(json.dumps(response).encode() + b"\n")
                self.wfile.flush()
            except (ConnectionError, OSError):
                return


class AgentServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # default backlog of 5 refuses connections under connect bursts
    request_queue_size = 64

    def __init__(self, host, port, token, backend):
        self.token = token
        self.backend = backend
        super().__init__((host, port), _Handler)


def read_token(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


def serve(host, port, token, backend):
    server = AgentServer(host, port, token, backend)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main(argv=None):
    import argparse
    import os
    import sys

    from .backend import select_backend

    parser = argparse.ArgumentParser(prog="myco-agent")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", default=os.environ.get("MYCO_AGENT_TOKEN_FILE", "C:\\ProgramData\\Myco\\agent.token"))
    parser.add_argument("--backend", default=None, choices=["windows", "fake"])
    args = parser.parse_args(argv)

    try:
        token = read_token(args.token_file)
    except OSError as exc:
        print(f"myco-agent: cannot read token file {args.token_file}: {exc}", file=sys.stderr)
        return 1

    backend = select_backend(args.backend)
    print(f"myco-agent: listening on {args.host}:{args.port}", file=sys.stderr)
    server = AgentServer(args.host, args.port, token, backend)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
