"""SQLite persistence for the simulated fleet (stdlib sqlite3; no ORM needed).

Capacity invariants are enforced by the schema itself (CHECK constraints):
capacity >= 0, occupied >= 0, reserved >= 0, occupied + reserved <= capacity.
Every state change runs inside `tx()` (BEGIN IMMEDIATE + a process lock), and
reservations use conditional UPDATEs whose row count proves success, so two
orders can never take the same last parking space or the same drone.
Schema changes bump SCHEMA_VERSION (PRAGMA user_version) and add a migration.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE facilities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('HOSPITAL_STATION', 'DEPOT', 'RESTAURANT_PAD')),
    ref_id TEXT,                       -- OSM hospital/restaurant id; NULL for depots
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    district TEXT,
    capacity INTEGER NOT NULL CHECK (capacity >= 0),
    occupied INTEGER NOT NULL DEFAULT 0 CHECK (occupied >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    verification TEXT NOT NULL CHECK (verification IN
        ('PROPOSED', 'REVIEW_REQUIRED', 'SIMULATION_ENABLED', 'VERIFIED_BY_OPERATOR', 'DISABLED')),
    operational_status TEXT NOT NULL DEFAULT 'OPEN' CHECK (operational_status IN ('OPEN', 'CLOSED')),
    depot_type TEXT,                   -- STANDARD | HIGH_DEMAND (depots)
    landing_method TEXT,
    data_source TEXT NOT NULL,
    demand_score REAL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (occupied + reserved <= capacity)
);
CREATE INDEX facilities_kind ON facilities(kind);
CREATE INDEX facilities_ref ON facilities(ref_id);

CREATE TABLE drones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'RESERVED', 'LOADING', 'IN_FLIGHT', 'DELIVERING',
                                           'RETURNING', 'CHARGING', 'MAINTENANCE', 'OFFLINE')),
    home_depot_id TEXT NOT NULL REFERENCES facilities(id),
    current_facility_id TEXT REFERENCES facilities(id),
    battery_pct REAL NOT NULL CHECK (battery_pct BETWEEN 0 AND 100),
    max_range_m REAL NOT NULL,
    current_order_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
    restaurant_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('NOT_SUBSCRIBED', 'TRIAL', 'ACTIVE', 'SUSPENDED')),
    demo INTEGER NOT NULL DEFAULT 0,  -- 1 = seeded demo partner (fictional agreement)
    updated_at TEXT NOT NULL
);

CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    order_type TEXT NOT NULL,
    status TEXT NOT NULL,
    pickup_lat REAL NOT NULL, pickup_lon REAL NOT NULL, pickup_facility_id TEXT,
    dest_lat REAL NOT NULL, dest_lon REAL NOT NULL, dest_facility_id TEXT,
    partner_id TEXT,
    drone_id TEXT,
    profile_id TEXT,
    altitude_m INTEGER NOT NULL,
    weather_mode TEXT NOT NULL,
    legs_json TEXT,
    distance_m REAL, eta_s REAL,
    message TEXT,
    verification TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class FleetDB:
    def __init__(self, path: Path | str):
        self.path = Path(path) if str(path) != ":memory:" else path
        if isinstance(self.path, Path):
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None, timeout=10)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        if str(self.path) != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version == 0:
            # executescript manages its own transaction (it commits first), so not inside tx().
            with self._lock:
                self.conn.executescript("BEGIN;\n" + SCHEMA + f"\nPRAGMA user_version = {SCHEMA_VERSION};\nCOMMIT;")
        elif version > SCHEMA_VERSION:
            raise RuntimeError(f"Fleet database {self.path} has a newer schema ({version}) than this code ({SCHEMA_VERSION}).")

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """One atomic transaction; rolls back on any exception."""
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    def query(self, sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    def one(self, sql: str, params: tuple | list = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def meta(self, key: str) -> str | None:
        row = self.one("SELECT value FROM meta WHERE key = ?", (key,))
        return row["value"] if row else None

    def close(self) -> None:
        with self._lock:
            self.conn.close()
