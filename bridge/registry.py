"""RunRegistry: SQLite journal for the bridge."""

import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path
from threading import RLock
from typing import Any

from bridge.config import RUN_CLEANUP_LIMIT, RUN_RETENTION_SECONDS

logger = logging.getLogger("chatgpt_bridge")


class RunRegistry:
    """Petit journal SQLite atomique ; aucun prompt/résultat n'est journalisé.

    SQLite est volontairement local au bridge : la contrainte UNIQUE porte la
    garantie de déduplication même lorsque deux handlers HTTP entrent ensemble.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS bridge_runs (
                    idempotency_key TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    bridge_run_id TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','needs_review')),
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    response_json TEXT,
                    error_json TEXT,
                    conversation_json TEXT,
                    preview_json TEXT
                )
                """
            )
            table_sql = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='bridge_runs'"
            ).fetchone()[0]
            columns = {row[1] for row in db.execute("PRAGMA table_info(bridge_runs)")}
            required_columns = {
                "idempotency_key",
                "request_hash",
                "bridge_run_id",
                "state",
                "created_at",
                "updated_at",
                "response_json",
                "error_json",
                "conversation_json",
                "preview_json",
            }
            if "needs_review" not in table_sql or not required_columns.issubset(columns):
                raise RuntimeError(
                    "bridge_runs table schema is incompatible with the current "
                    "code. This bridge no longer migrates historical SQLite "
                    "schemas. Reset the run registry by deleting only "
                    "bridge-runs.sqlite3, bridge-runs.sqlite3-wal and "
                    "bridge-runs.sqlite3-shm inside bridge_data (never delete "
                    "other bridge_data contents, in particular the ChatGPT "
                    "browser/auth state), then restart the bridge."
                )

    def recover_interrupted(self) -> None:
        # Après un arrêt, il est impossible de prouver si le clic UI a eu lieu.
        # Ne jamais resoumettre est la seule reprise sûre. Cette transition se
        # fait au démarrage réel, pas au simple import du module par les tests.
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT idempotency_key, bridge_run_id FROM bridge_runs "
                "WHERE state IN ('queued','running')"
            ).fetchall()
            now = time.time()
            for row in rows:
                interrupted = json.dumps(
                    {
                        "status_code": 503,
                        "body": {
                            "id": row["bridge_run_id"],
                            "object": "response",
                            "status": "failed",
                            "error": {
                                "code": "bridge_server_error",
                                "message": "Le bridge a redémarré pendant cette exécution.",
                                "retryable": False,
                                "phase": "shutdown",
                                # A restart cannot prove whether the browser
                                # received the prompt. Keep the exact
                                # request-scoped target eligible for explicit
                                # recovery, never for an implicit replay.
                                "submission_state": "submission_attempted",
                            },
                        },
                    },
                    separators=(",", ":"),
                )
                db.execute(
                    "UPDATE bridge_runs SET state='failed', error_json=?, updated_at=? "
                    "WHERE idempotency_key=?",
                    (interrupted, now, row["idempotency_key"]),
                )
            db.execute("COMMIT")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    def claim(self, key: str, request_hash: str) -> tuple[dict[str, Any], bool]:
        now = time.time()
        run_id = f"resp_{uuid.uuid4().hex[:24]}"
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM bridge_runs WHERE idempotency_key=?", (key,)
            ).fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO bridge_runs "
                    "(idempotency_key,request_hash,bridge_run_id,state,created_at,updated_at,"
                    "response_json,error_json,conversation_json,preview_json) "
                    "VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL)",
                    (key, request_hash, run_id, "queued", now, now),
                )
                row = db.execute(
                    "SELECT * FROM bridge_runs WHERE idempotency_key=?", (key,)
                ).fetchone()
                created = True
            else:
                created = False
            db.execute("COMMIT")
        assert row is not None
        return dict(row), created

    def set_state(self, key: str, state: str, value: dict[str, Any] | None = None) -> None:
        column = "response_json" if state == "completed" else "error_json"
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if value else None
        with self._lock, self._connect() as db:
            db.execute(
                f"UPDATE bridge_runs SET state=?, updated_at=?, {column}=? WHERE idempotency_key=?",
                (state, time.time(), encoded, key),
            )

    def bind_conversation(self, run_id: str, value: dict[str, Any]) -> None:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT idempotency_key FROM bridge_runs WHERE bridge_run_id=?", (run_id,)
            ).fetchone()
            bound = {
                **value,
                "bridge_run_id": run_id,
                "model_run_id": row["idempotency_key"] if row else None,
            }
            value.update(bound)
            encoded = json.dumps(bound, ensure_ascii=False, separators=(",", ":"))
            db.execute(
                "UPDATE bridge_runs SET conversation_json=?, updated_at=? "
                "WHERE bridge_run_id=?",
                (encoded, time.time(), run_id),
            )

    def store_preview(self, run_id: str, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE bridge_runs SET preview_json=?, updated_at=? WHERE bridge_run_id=?",
                (encoded, time.time(), run_id),
            )

    def get_by_run_id(self, run_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT * FROM bridge_runs WHERE bridge_run_id=?", (run_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_by_idempotency_key(self, key: str) -> dict[str, Any] | None:
        """Resolve the exact request key used when a caller lost the POST response."""
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT * FROM bridge_runs WHERE idempotency_key=?", (key,)
            ).fetchone()
        return dict(row) if row else None

    def cleanup(self) -> int:
        cutoff = time.time() - RUN_RETENTION_SECONDS
        with self._lock, self._connect() as db:
            cursor = db.execute(
                "DELETE FROM bridge_runs WHERE idempotency_key IN ("
                "SELECT idempotency_key FROM bridge_runs "
                "WHERE state IN ('completed','failed') AND updated_at < ? "
                "ORDER BY updated_at LIMIT ?)",
                (cutoff, RUN_CLEANUP_LIMIT),
            )
        return cursor.rowcount

    def accessible(self) -> bool:
        """Vérifie le registre sans exposer son chemin ni son contenu."""
        try:
            with self._lock, self._connect() as db:
                db.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            logger.exception("bridge_registry_unavailable")
            return False

    def checkpoint_and_close(self) -> None:
        """Force le checkpoint WAL ; les connexions sont déjà ouvertes à l'appel."""
        with self._lock, self._connect() as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
