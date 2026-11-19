from . import AGENT_VERSION, SESSION_ID
from .protocol import OpError, op


@op("ping")
def ping(backend, params):
    info = backend.ping()
    return {"agent_version": AGENT_VERSION, "session_id": SESSION_ID, **info}


@op("session_info")
def session_info(backend, params):
    return backend.session_info()


@op("launch", required={"argv": list}, optional={"cwd": str})
def launch(backend, params):
    if not params["argv"] or not all(isinstance(a, str) for a in params["argv"]):
        raise OpError("BAD_REQUEST", "argv must be a non-empty list of strings")
    return backend.launch(params["argv"], params.get("cwd"))


@op("uia_tree", optional={"pid": int, "title": str, "depth": int})
def uia_tree(backend, params):
    return backend.uia_tree(
        params.get("pid"), params.get("title"), params.get("depth", 8)
    )


@op(
    "uia_invoke",
    required={"runtime_id": list, "action": str},
    optional={"value": str},
)
def uia_invoke(backend, params):
    if params["action"] not in ("invoke", "select", "set_value"):
        raise OpError("BAD_REQUEST", "action must be invoke, select or set_value")
    return backend.uia_invoke(params["runtime_id"], params["action"], params.get("value"))


@op("screenshot", optional={"pid": int, "rect": list})
def screenshot(backend, params):
    return backend.screenshot(params.get("pid"), params.get("rect"))


@op("read_file", required={"path": str})
def read_file(backend, params):
    return backend.read_file(params["path"])


@op("write_file", required={"path": str, "data_b64": str})
def write_file(backend, params):
    return backend.write_file(params["path"], params["data_b64"])


@op("kill", optional={"pid": int, "image_name": str})
def kill(backend, params):
    if params.get("pid") is None and params.get("image_name") is None:
        raise OpError("BAD_REQUEST", "one of pid or image_name is required")
    return backend.kill(params.get("pid"), params.get("image_name"))


@op(
    "uno_eval",
    required={"call": str},
    optional={"sheet": str, "cell": str, "socket": str},
)
def uno_eval(backend, params):
    if params["call"] not in ("get_value", "get_string", "get_error", "is_modified"):
        raise OpError("BAD_REQUEST", "unsupported uno call")
    return backend.uno_eval(
        params["call"], params.get("sheet"), params.get("cell"), params.get("socket")
    )
