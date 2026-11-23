"""SQLite 資料庫。"""
import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

from . import config

TW = timezone(timedelta(hours=8))   # 台灣不實施日光節約，固定 +08:00
_lock = threading.Lock()


def now_tw() -> datetime:
    """台灣時間（不帶時區），和水利署資料的時間格式一致。"""
    return datetime.now(TW).replace(tzinfo=None, microsecond=0)


def iso(dt):
    return dt.isoformat(timespec="seconds") if dt else None


def parse_time(value):
    """水利署時間可能是 2023-05-03T13:20:10 或 20230503T132010。"""
    if not value:
        return None
    value = str(value).strip().replace("t", "T").replace(" ", "T")
    for fmt in (None, "%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            dt = datetime.fromisoformat(value) if fmt is None else datetime.strptime(value, fmt)
            return dt.astimezone(TW).replace(tzinfo=None) if dt.tzinfo else dt
        except ValueError:
            continue
    return None


def connect():
    os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with _lock, connect() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS reservoirs (
            id TEXT PRIMARY KEY, name TEXT, capacity REAL, capacity_at TEXT, full_level REAL,
            dead_level REAL, daily_inflow REAL, daily_outflow REAL, daily_at TEXT
        );
        CREATE TABLE IF NOT EXISTS observations (
            reservoir_id TEXT NOT NULL, observed_at TEXT NOT NULL,
            effective_storage REAL, water_level REAL, rainfall REAL, inflow REAL, outflow REAL,
            source TEXT DEFAULT 'api',
            UNIQUE (reservoir_id, observed_at)
        );
        CREATE INDEX IF NOT EXISTS idx_obs ON observations (reservoir_id, observed_at);
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT UNIQUE NOT NULL,
            channel TEXT NOT NULL, target TEXT NOT NULL,
            reservoir_ids TEXT NOT NULL, threshold REAL NOT NULL,
            active INTEGER DEFAULT 1, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS alert_state (
            subscription_id INTEGER, reservoir_id TEXT,
            armed INTEGER DEFAULT 1, last_sent_at TEXT,
            PRIMARY KEY (subscription_id, reservoir_id)
        );
        """)
        # 舊版資料庫沒有這些欄位時自動補上，保留已累積的資料
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(reservoirs)")}
        for col, kind in [("dead_level", "REAL"), ("daily_inflow", "REAL"), ("daily_outflow", "REAL"), ("daily_at", "TEXT")]:
            if col not in cols:
                conn.execute(f"ALTER TABLE reservoirs ADD COLUMN {col} {kind}")


def get_state(conn, key, default=None):
    row = conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_state(conn, key, value):
    conn.execute("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, None if value is None else str(value)))


def write_lock():
    """寫入資料庫時用，避免背景排程和網頁請求同時寫入。"""
    return _lock
