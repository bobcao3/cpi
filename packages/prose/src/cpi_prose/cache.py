import hashlib
import json
import sqlite3
import time
from pathlib import Path

from .inputs import identity


class ReferenceCache:
    max_entries = 128
    max_bytes = 64 * 1024 * 1024

    def __init__(self, directory: Path, engine_id: str):
        self.engine_id = engine_id
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = directory / "references.sqlite3"
        self.connection = sqlite3.connect(path, timeout=10)
        path.chmod(0o600)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS reference "
            "(id TEXT PRIMARY KEY, engine TEXT NOT NULL, result TEXT NOT NULL, "
            "used REAL NOT NULL, bytes INTEGER NOT NULL)"
        )
        self.connection.commit()

    def key(self, document: dict) -> str:
        return hashlib.sha256((self.engine_id + identity(document)).encode()).hexdigest()

    def get(self, key: str) -> dict | None:
        row = self.connection.execute(
            "SELECT result FROM reference WHERE id=? AND engine=?",
            (key, self.engine_id),
        ).fetchone()
        if row is None:
            return None
        with self.connection:
            self.connection.execute("UPDATE reference SET used=? WHERE id=?", (time.time(), key))
        return json.loads(row[0])

    def put(self, key: str, result: dict):
        content = json.dumps(result, ensure_ascii=False, allow_nan=False)
        size = len(content.encode())
        with self.connection:
            self.connection.execute(
                "INSERT OR REPLACE INTO reference VALUES (?, ?, ?, ?, ?)",
                (key, self.engine_id, content, time.time(), size),
            )
            rows = self.connection.execute(
                "SELECT id, bytes FROM reference ORDER BY used DESC, id"
            ).fetchall()
            total = 0
            for index, (entry_id, entry_bytes) in enumerate(rows):
                total += entry_bytes
                if index >= self.max_entries or total > self.max_bytes:
                    self.connection.execute("DELETE FROM reference WHERE id=?", (entry_id,))

    def stats(self) -> dict:
        count, size = self.connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM reference"
        ).fetchone()
        return {"entries": count, "bytes": size}

    def clear(self) -> dict:
        with self.connection:
            self.connection.execute("DELETE FROM reference")
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.connection.execute("VACUUM")
        return self.stats()
