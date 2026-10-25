import sys

from .config import Settings
from .daemon import request, stop_daemon
from .transport import (
    RpcError,
    decode_json,
    encode_json,
    file_lock,
    probe,
    runtime_directory,
)


def dispatch(message):
    if not isinstance(message, dict) or not isinstance(message.get("method"), str):
        raise ValueError("Expected an object with a method")
    settings = Settings.from_env()
    method, params = message["method"], message.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("Parameters must be an object")
    if method in {"status", "stop"}:
        directory = runtime_directory(create=False)
        if method == "status":
            health = probe(directory)
            if health is None:
                return {"running": False}
            return health
        if not directory.exists():
            return {"stopped": False, "running": False}
        with file_lock(directory / "startup.lock"):
            return stop_daemon(directory)
    return request(settings, method, params)


def main():
    try:
        data = sys.stdin.buffer.read()
        result = dispatch(decode_json(data.decode("utf-8")))
        sys.stdout.buffer.write(encode_json(result))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        details = error.to_dict() if isinstance(error, RpcError) else {"message": str(error)}
        sys.stdout.buffer.write(encode_json({"error": details}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
