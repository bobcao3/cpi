import contextlib
import errno
import fcntl
import hashlib
import json
import math
import os
import socket
import stat
import sys
import time
from pathlib import Path

CONNECT_TIMEOUT = 2.0
FRAME_TIMEOUT = 10.0
START_TIMEOUT = 20.0
STOP_TIMEOUT = 10.0
LOCK_TIMEOUT = 40.0
BACKLOG = 16
STALE_CODE = -32001


class RpcError(Exception):
    def __init__(self, code, message, data=None):
        super().__init__(message)
        self.code = code
        self.data = data

    def to_dict(self):
        result = {"code": self.code, "message": str(self)}
        if self.data is not None:
            result["data"] = self.data
        return result


def reject_constant(value):
    raise ValueError(f"Non-finite JSON number: {value}")


def decode_json(data):
    value = json.loads(data, parse_constant=reject_constant)
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Non-finite JSON number")
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return value


def encode_json(value):
    data = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode(
        "utf-8"
    )
    return data + b"\n"


def receive_frame(connection, timeout):
    deadline = None if timeout is None else time.monotonic() + timeout
    data = bytearray()
    while True:
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise RpcError(-32003, "Request frame timed out")
        connection.settimeout(remaining)
        chunk = connection.recv(65536)
        if not chunk:
            raise RpcError(-32600, "Connection closed before newline")
        data.extend(chunk)
        newline = data.find(b"\n", max(0, len(data) - len(chunk)))
        if newline >= 0:
            if newline != len(data) - 1:
                raise RpcError(-32600, "Expected one newline-delimited JSON frame")
            try:
                return decode_json(data[:newline].decode("utf-8"))
            except (ValueError, RecursionError) as error:
                raise RpcError(-32700, "Invalid JSON", str(error)) from error


def private_directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise RpcError(
            -32004, f"Runtime directory must be owned by this user with mode 0700: {path}"
        )
    return path


def runtime_directory(create=True):
    identity = [
        str(Path(sys.executable).resolve()),
        sys.prefix,
        str(Path(__file__).resolve().parent),
    ]
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        base = Path(runtime)
        info = base.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RpcError(-32004, "XDG_RUNTIME_DIR must be a private directory owned by this user")
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
        if create:
            cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        base = cache / "cpi-prose"
        if create or base.exists():
            private_directory(base)
    path = base / f"cpi-prose-{digest}"
    if len(os.fsencode(path / "rpc.sock")) > 103:
        raise RpcError(
            -32004, "Socket path too long; set XDG_RUNTIME_DIR to a short private directory"
        )
    if create or path.exists():
        private_directory(path)
    return path


def private_file(path, flags):
    descriptor = os.open(path, flags | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
    ):
        os.close(descriptor)
        raise RpcError(-32004, f"Unsafe runtime file: {path}")
    return descriptor


@contextlib.contextmanager
def file_lock(path, timeout=LOCK_TIMEOUT):
    descriptor = private_file(path, os.O_RDWR)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RpcError(-32005, f"Timed out waiting for daemon lock: {path}")
                time.sleep(0.05)
        yield
    finally:
        os.close(descriptor)


def check_socket(path):
    info = path.lstat()
    if (
        not stat.S_ISSOCK(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise RpcError(-32004, f"Unsafe daemon socket: {path}")


def rpc_call(directory, method, params=None, timeout=None):
    path = directory / "rpc.sock"
    check_socket(path)
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    frame = encode_json(request)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(CONNECT_TIMEOUT)
        connection.connect(str(path))
        connection.settimeout(FRAME_TIMEOUT)
        connection.sendall(frame)
        response = receive_frame(connection, timeout)
    if (
        not isinstance(response, dict)
        or response.get("jsonrpc") != "2.0"
        or type(response.get("id")) is not int
        or response["id"] != 1
    ):
        raise RpcError(-32603, "Invalid daemon response")
    if ("error" in response) == ("result" in response):
        raise RpcError(-32603, "Invalid daemon response payload")
    if "error" in response:
        error = response["error"]
        if (
            not isinstance(error, dict)
            or type(error.get("code")) is not int
            or not isinstance(error.get("message"), str)
        ):
            raise RpcError(-32603, "Invalid daemon error")
        raise RpcError(error["code"], error["message"], error.get("data"))
    if not isinstance(response["result"], dict):
        raise RpcError(-32603, "Expected an object result from daemon")
    return response["result"]


def probe(directory):
    try:
        return rpc_call(directory, "health", timeout=CONNECT_TIMEOUT)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return None
        raise
