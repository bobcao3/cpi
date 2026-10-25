import os
import subprocess
import sys
import time
from pathlib import Path

from .config import fingerprint
from .progress import forward_logs, progress
from .transport import (
    STALE_CODE,
    START_TIMEOUT,
    STOP_TIMEOUT,
    RpcError,
    file_lock,
    private_file,
    probe,
    rpc_call,
    runtime_directory,
)


def stop_daemon(directory):
    health = probe(directory)
    if health is None:
        return {"stopped": False, "running": False}
    deadline = time.monotonic() + STOP_TIMEOUT
    rpc_call(directory, "shutdown", timeout=STOP_TIMEOUT)
    while (directory / "rpc.sock").exists():
        if time.monotonic() >= deadline:
            raise RpcError(
                -32005, "Daemon did not shut down before the deadline; no process was killed"
            )
        time.sleep(0.05)
    with file_lock(directory / "server.lock", timeout=max(0, deadline - time.monotonic())):
        pass
    return {"stopped": True, "running": False}


def spawn_daemon(directory):
    environment = os.environ.copy()
    paths = [str(Path(__file__).resolve().parent.parent)]
    paths.extend(os.path.abspath(path or os.getcwd()) for path in sys.path)
    paths.extend(environment.get("PYTHONPATH", "").split(os.pathsep))
    environment["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(path for path in paths if path))
    descriptor = private_file(directory / "daemon.log", os.O_WRONLY | os.O_APPEND)
    try:
        return subprocess.Popen(
            [sys.executable, "-m", "cpi_prose.server"],
            stdin=subprocess.DEVNULL,
            stdout=descriptor,
            stderr=descriptor,
            close_fds=True,
            start_new_session=True,
            env=environment,
        )
    finally:
        os.close(descriptor)


def ensure_daemon(settings):
    directory = runtime_directory()
    with file_lock(directory / "startup.lock"):
        expected = fingerprint(settings)
        health = probe(directory)
        if health is not None:
            if health.get("fingerprint") == expected and not health.get("stale"):
                progress(f"Using analysis server (PID {health['pid']}).")
                return directory
            progress("Restarting the analysis server after a source or configuration update...")
            stop_daemon(directory)
        progress("Starting the analysis server...")
        process = spawn_daemon(directory)
        deadline = time.monotonic() + START_TIMEOUT
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RpcError(
                        -32006, f"Daemon exited during startup; see {directory / 'daemon.log'}"
                    )
                health = probe(directory)
                if health is not None:
                    if (
                        health.get("fingerprint") != expected
                        or health.get("stale")
                        or fingerprint(settings) != expected
                    ):
                        stop_daemon(directory)
                        raise RpcError(
                            STALE_CODE,
                            "Source or dependencies changed during startup; retry the command",
                        )
                    progress(f"Analysis server ready (PID {health['pid']}).")
                    return directory
                time.sleep(0.05)
            raise RpcError(-32006, f"Daemon startup timed out; see {directory / 'daemon.log'}")
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=STOP_TIMEOUT)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=STOP_TIMEOUT)
            raise


def request(settings, method, params):
    for attempt in range(2):
        directory = ensure_daemon(settings)
        try:
            with forward_logs(directory):
                return rpc_call(directory, method, params)
        except RpcError as error:
            if error.code != STALE_CODE or attempt:
                raise
    raise AssertionError("Request retry bound exhausted")
