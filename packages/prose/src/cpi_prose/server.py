import os
import signal
import socket
import time

from .config import fingerprint
from .transport import (
    BACKLOG,
    FRAME_TIMEOUT,
    STALE_CODE,
    RpcError,
    check_socket,
    encode_json,
    file_lock,
    receive_frame,
    runtime_directory,
)


class Server:
    def __init__(self, settings):
        self.settings = settings
        self.fingerprint = fingerprint(settings)
        self.started_at = time.time()
        self.analyzer = None
        self.stopping = False

    def stop(self, signum=None, frame=None):
        self.stopping = True

    def health(self, current_fingerprint):
        return {
            "running": True,
            "pid": os.getpid(),
            "fingerprint": self.fingerprint,
            "stale": current_fingerprint != self.fingerprint,
            "started_at": self.started_at,
            "uptime_seconds": round(time.time() - self.started_at, 3),
            "analyzer_loaded": self.analyzer is not None,
            "settings": self.settings.to_dict(),
        }

    def dispatch(self, method, params):
        current_fingerprint = fingerprint(self.settings)
        if method in ("health", "status", "shutdown"):
            if params:
                raise RpcError(-32602, f"{method} does not accept parameters")
            if method == "shutdown":
                self.stopping = True
                return {"stopping": True, "pid": os.getpid()}
            return self.health(current_fingerprint)
        if current_fingerprint != self.fingerprint:
            raise RpcError(
                STALE_CODE,
                "Daemon source, dependencies, or configuration changed; restart required",
            )
        if method not in ("analyze", "cache/stats", "cache/clear"):
            raise RpcError(-32601, "Method not found")
        if self.analyzer is None:
            from .service import Analyzer

            self.analyzer = Analyzer(self.settings)
        result = self.analyzer.request(method, params)
        if fingerprint(self.settings) != self.fingerprint:
            raise RpcError(STALE_CODE, "Daemon changed during request; result discarded")
        if not isinstance(result, dict):
            raise RpcError(-32603, "Analyzer returned a non-object result")
        return result

    def response(self, request):
        request_id = None
        notification = False
        try:
            if not isinstance(request, dict):
                raise RpcError(-32600, "Expected a JSON-RPC request object")
            candidate_id = request.get("id")
            if candidate_id is not None and type(candidate_id) not in (str, int):
                raise RpcError(-32600, "Request id must be a string, integer, or null")
            request_id = candidate_id
            if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
                raise RpcError(-32600, "Invalid JSON-RPC request")
            notification = "id" not in request
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise RpcError(-32602, "Parameters must be an object")
            result = self.dispatch(request["method"], params)
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as error:
            response = self.error_response(error, request_id)
        return None if notification else response

    def error_response(self, error, request_id=None):
        if not isinstance(error, RpcError):
            code = -32602 if isinstance(error, (ValueError, TypeError)) else -32000
            error = RpcError(code, str(error) or type(error).__name__)
        return {"jsonrpc": "2.0", "id": request_id, "error": error.to_dict()}

    def handle(self, connection):
        try:
            response = self.response(receive_frame(connection, FRAME_TIMEOUT))
        except Exception as error:
            response = self.error_response(error)
        if response is None:
            return
        try:
            frame = encode_json(response)
        except ValueError, TypeError, RecursionError, RpcError:
            frame = encode_json(
                self.error_response(
                    RpcError(
                        -32603, "Response is not finite, serializable, or within the byte limit"
                    )
                )
            )
        try:
            connection.settimeout(None)
            connection.sendall(frame)
        except OSError:
            pass

    def run(self, directory):
        path = directory / "rpc.sock"
        if path.exists() or path.is_symlink():
            check_socket(path)
            path.unlink()
        previous_handlers = {}
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, self.stop)
        socket_identity = None
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                previous_umask = os.umask(0o177)
                try:
                    listener.bind(str(path))
                finally:
                    os.umask(previous_umask)
                path.chmod(0o600)
                socket_identity = path.stat().st_ino
                listener.listen(BACKLOG)
                last_request = time.monotonic()
                while not self.stopping:
                    remaining = self.settings.idle_seconds - (time.monotonic() - last_request)
                    if remaining <= 0:
                        break
                    listener.settimeout(min(remaining, 0.5))
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    with connection:
                        self.handle(connection)
                    last_request = time.monotonic()
        finally:
            try:
                if socket_identity is not None and path.lstat().st_ino == socket_identity:
                    path.unlink()
            except FileNotFoundError:
                pass
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)


def serve(settings):
    if settings.idle_seconds <= 0:
        raise ValueError("idle_seconds must be positive")
    directory = runtime_directory()
    with file_lock(directory / "server.lock", timeout=0):
        Server(settings).run(directory)


if __name__ == "__main__":
    from .config import Settings

    serve(Settings.from_env())
