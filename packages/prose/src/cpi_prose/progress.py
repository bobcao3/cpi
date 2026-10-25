import logging
import sys
import threading
import time
from contextlib import contextmanager

logger = logging.getLogger("cpi_prose")
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter("[cpi-prose %(levelname)s] %(message)s"))
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


def progress(message):
    logger.info(message)


@contextmanager
def forward_logs(directory):
    path = directory / "daemon.log"
    position = path.stat().st_size if path.exists() else 0
    stopped = threading.Event()
    activity = time.monotonic()

    def drain():
        nonlocal position, activity
        try:
            with path.open("rb") as log:
                log.seek(position)
                data = log.read(65536)
                position = log.tell()
            if data:
                sys.stderr.buffer.write(data)
                sys.stderr.buffer.flush()
                activity = time.monotonic()
            elif not stopped.is_set() and time.monotonic() - activity >= 5:
                progress("Waiting for the analysis server...")
                activity = time.monotonic()
        except FileNotFoundError:
            return
        except BrokenPipeError, OSError:
            stopped.set()

    def follow():
        while not stopped.wait(0.1):
            drain()
        drain()

    thread = threading.Thread(target=follow, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=2)
