import json

AUTH_FAILED = "AUTH_FAILED"
BAD_REQUEST = "BAD_REQUEST"
UNKNOWN_OP = "UNKNOWN_OP"
OP_FAILED = "OP_FAILED"
INTERNAL = "INTERNAL"


class OpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


OPS = {}


def op(name, required=None, optional=None):
    def register(fn):
        OPS[name] = {"handler": fn, "required": required or {}, "optional": optional or {}}
        return fn
    return register


def _check_types(spec, params, where):
    for key, typ in spec.items():
        if key not in params:
            continue
        value = params[key]
        origin = getattr(typ, "__origin__", None)
        if origin is list:
            if not isinstance(value, list) or not all(
                isinstance(v, typ.__args__[0]) for v in value
            ):
                raise OpError(BAD_REQUEST, f"{where}.{key} must be a list of {typ.__args__[0].__name__}")
        elif not isinstance(value, typ):
            raise OpError(BAD_REQUEST, f"{where}.{key} must be {typ.__name__}")



def handle_request(line, backend, token):
    from . import ops as _ops  # noqa: F401  (registers all op handlers)

    try:
        payload = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return _error(None, BAD_REQUEST, "request is not valid JSON")
    if not isinstance(payload, dict):
        return _error(None, BAD_REQUEST, "request must be a JSON object")

    request_id = payload.get("id")
    supplied = payload.get("token")
    if not isinstance(supplied, str) or supplied != token:
        return _error(request_id, AUTH_FAILED, "missing or invalid token")
    op_name = payload.get("op")
    if not isinstance(op_name, str) or op_name not in OPS:
        return _error(request_id, UNKNOWN_OP, f"unknown op: {op_name!r}")
    params = payload.get("params", {})
    if not isinstance(params, dict):
        return _error(request_id, BAD_REQUEST, "params must be a JSON object")

    spec = OPS[op_name]
    try:
        for key in spec["required"]:
            if key not in params:
                raise OpError(BAD_REQUEST, f"missing required param: {key}")
        _check_types(spec["required"], params, "params")
        _check_types(spec["optional"], params, "params")
        result = spec["handler"](backend, params)
    except OpError as exc:
        return _error(request_id, exc.code, exc.message)
    except Exception as exc:
        return _error(request_id, OP_FAILED, f"{type(exc).__name__}: {exc}")
    response = {"ok": True, "id": request_id, "result": result}
    return response


def _error(request_id, code, message):
    return {"ok": False, "id": request_id, "error": {"code": code, "message": message}}


def encode(response):
    return json.dumps(response, separators=(",", ":")) + "\n"
