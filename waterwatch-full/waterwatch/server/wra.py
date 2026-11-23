"""抓水利署資料、存進資料庫、整理成前端要的格式。"""
import logging
from datetime import timedelta

import requests

from . import config, db
from .coords import COORDS, region_of

log = logging.getLogger("waterwatch")


def to_float(value):
    """水利署的數字都是字串，空字串代表沒資料。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_all(url):
    """一頁最多 1000 筆，翻頁直到抓完。"""
    rows, page = [], 1
    while page <= 50:
        r = requests.get(url, params={"page": page, "size": 1000}, timeout=30)
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, list) or not data:
            break
        rows.extend(data)
        if len(data) < 1000:
            break
        page += 1
    return rows


def save_daily(conn, rows):
    """每日營運狀況：水庫名稱、有效容量、滿水位。

    每個欄位各自取「最新一筆有值的」：最新一天的容量是空的，就用前一天的容量補上。
    """
    latest = {}  # rid → {"name": (時間, 值), "capacity": (時間, 值), "full_level": (時間, 值)}
    for row in rows:
        rid = str(row.get("reservoiridentifier") or "").strip()
        when = db.parse_time(row.get("datetime"))
        if not rid or not when:
            continue
        cur = latest.setdefault(rid, {})
        values = {"name": (row.get("reservoirname") or "").strip() or None,
                  "capacity": to_float(row.get("capacity")), "full_level": to_float(row.get("nwlmax")),
                  "dead_level": to_float(row.get("dwl"))}
        # 進水量、出水量要同一天的才放一起
        if to_float(row.get("inflow")) is not None or to_float(row.get("outflowtotal")) is not None:
            if "daily" not in cur or when > cur["daily"][0]:
                cur["daily"] = (when, (to_float(row.get("inflow")), to_float(row.get("outflowtotal"))))
        for key, value in values.items():
            if value is not None and (key not in cur or when > cur[key][0]):
                cur[key] = (when, value)
    for rid, cur in latest.items():
        name = cur.get("name", (None, None))[1]
        cap_at, cap = cur.get("capacity", (None, None))
        full = cur.get("full_level", (None, None))[1]
        dead = cur.get("dead_level", (None, None))[1]
        day_at, (day_in, day_out) = cur.get("daily", (None, (None, None)))
        conn.execute("""
            INSERT INTO reservoirs (id, name, capacity, capacity_at, full_level, dead_level, daily_inflow, daily_outflow, daily_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = COALESCE(excluded.name, reservoirs.name),
              capacity = COALESCE(excluded.capacity, reservoirs.capacity),
              capacity_at = CASE WHEN excluded.capacity IS NOT NULL THEN excluded.capacity_at ELSE reservoirs.capacity_at END,
              full_level = COALESCE(excluded.full_level, reservoirs.full_level),
              dead_level = COALESCE(excluded.dead_level, reservoirs.dead_level),
              daily_inflow = CASE WHEN excluded.daily_at IS NOT NULL THEN excluded.daily_inflow ELSE reservoirs.daily_inflow END,
              daily_outflow = CASE WHEN excluded.daily_at IS NOT NULL THEN excluded.daily_outflow ELSE reservoirs.daily_outflow END,
              daily_at = COALESCE(excluded.daily_at, reservoirs.daily_at)
        """, (rid, name, cap, db.iso(cap_at), full, dead, day_in, day_out, db.iso(day_at)))
    return len(latest)


def save_status(conn, rows):
    """水情資料：每小時的水位、有效蓄水量、雨量、進出流量。全部存下來，累積成歷史。"""
    added = 0
    for row in rows:
        rid = str(row.get("reservoiridentifier") or "").strip()
        when = db.parse_time(row.get("observationtime"))
        if not rid or not when:
            continue
        conn.execute("INSERT OR IGNORE INTO reservoirs (id) VALUES (?)", (rid,))
        cur = conn.execute("""
            INSERT OR IGNORE INTO observations
              (reservoir_id, observed_at, effective_storage, water_level, rainfall, inflow, outflow, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'api')
        """, (rid, db.iso(when), to_float(row.get("effectivewaterstoragecapacity")), to_float(row.get("waterlevel")),
              to_float(row.get("accumulaterainfallincatchment")), to_float(row.get("inflowdischarge")),
              to_float(row.get("totaloutflow"))))
        added += cur.rowcount
    return added


def refresh():
    """抓一次水利署資料。回傳 True 代表成功。"""
    now = db.now_tw()
    try:
        daily = fetch_all(config.DAILY_URL)
        status = fetch_all(config.STATUS_URL)
        if not status:
            raise RuntimeError("水情資料回傳 0 筆")
    except Exception as e:  # 斷線、逾時、格式錯誤
        with db.write_lock(), db.connect() as conn:
            fails = int(db.get_state(conn, "consecutive_fail", "0")) + 1
            db.set_state(conn, "consecutive_fail", fails)
            db.set_state(conn, "last_attempt_at", db.iso(now))
            db.set_state(conn, "last_error", str(e)[:300])
        log.warning("水利署資料抓取失敗（連續 %s 次）：%s", fails, e)
        return False
    with db.write_lock(), db.connect() as conn:
        n_res = save_daily(conn, daily)
        n_obs = save_status(conn, status)
        # 拿到真實資料後，清掉離線時用的預錄快照
        conn.execute("DELETE FROM observations WHERE source = 'mock'")
        db.set_state(conn, "source", "api")
        db.set_state(conn, "consecutive_fail", 0)
        db.set_state(conn, "last_attempt_at", db.iso(now))
        db.set_state(conn, "last_success_at", db.iso(now))
        db.set_state(conn, "last_error", None)
    log.info("水利署資料更新：水庫 %s 座，新增觀測 %s 筆", n_res, n_obs)
    return True


# ---------- 整理成前端格式 ----------
def source_status(conn):
    now = db.now_tw()
    last_success = db.parse_time(db.get_state(conn, "last_success_at"))
    fails = int(db.get_state(conn, "consecutive_fail", "0"))
    source = db.get_state(conn, "source", "api")
    stale = last_success is None or now - last_success > timedelta(hours=config.SOURCE_STALE_HOURS)
    return {
        "source": source,
        "last_success_at": db.iso(last_success),
        "last_attempt_at": db.get_state(conn, "last_attempt_at"),
        "stale": stale and source != "mock",
        "consecutive_fail": fails,
    }


def compute_rate(storage, capacity):
    if storage is None or not capacity:
        return None
    rate = storage / capacity * 100
    return round(rate, 2) if 0 <= rate <= config.MAX_RATE else None


def _latest(conn, reservoir_id, column=None):
    """最新一筆觀測；指定 column 時，找該欄位有值的最新一筆（用來以舊資料補缺）。"""
    where = f"AND {column} IS NOT NULL" if column else ""
    return conn.execute(f"""
        SELECT * FROM observations WHERE reservoir_id = ? {where}
        ORDER BY observed_at DESC LIMIT 1
    """, (reservoir_id,)).fetchone()


def reservoirs(conn):
    """每座水庫的最新資料。

    水利署 API 只回傳近 24 小時；沒有即時資料時，改用系統保存的「最新一筆舊資料」補上，
    並回傳 stale / filled 讓前端標註「舊資料」。
    """
    now = db.now_tw()
    out = []
    for r in conn.execute("SELECT * FROM reservoirs ORDER BY id").fetchall():
        newest = _latest(conn, r["id"])
        # 蓄水量：最新一筆有值的（可能比 newest 舊）
        storage_row = newest if newest and newest["effective_storage"] is not None else _latest(conn, r["id"], "effective_storage")
        level_row = newest if newest and newest["water_level"] is not None else _latest(conn, r["id"], "water_level")
        main = storage_row or newest          # 蓄水率以有蓄水量的那筆為準
        observed = db.parse_time(main["observed_at"]) if main else None
        newest_at = db.parse_time(newest["observed_at"]) if newest else None
        cap_at = db.parse_time(r["capacity_at"])
        lat, lng = COORDS.get(r["id"], (None, None))
        out.append({
            "id": r["id"], "name": r["name"] or f"水庫 {r['id']}", "region": region_of(r["id"]),
            "rate": compute_rate(main["effective_storage"] if main else None, r["capacity"]),
            "capacity": r["capacity"], "effective_storage": main["effective_storage"] if main else None,
            "water_level": level_row["water_level"] if level_row else None, "full_level": r["full_level"],
            "dead_level": r["dead_level"], "daily_inflow": r["daily_inflow"], "daily_outflow": r["daily_outflow"],
            "daily_at": r["daily_at"],
            "rainfall": main["rainfall"] if main else None, "inflow": main["inflow"] if main else None,
            "outflow": main["outflow"] if main else None,
            "observed_at": db.iso(observed), "capacity_at": db.iso(cap_at),
            "level_observed_at": level_row["observed_at"] if level_row else None,
            "age_hours": round((now - observed).total_seconds() / 3600, 1) if observed else None,
            "stale": bool(observed and now - observed > timedelta(hours=config.OBS_STALE_HOURS)),
            # 最新一筆沒有蓄水量，蓄水率改用更早的紀錄
            "filled": bool(storage_row and newest_at and observed < newest_at),
            "capacity_stale": bool(cap_at and now - cap_at > timedelta(days=config.CAPACITY_STALE_DAYS)),
            "lat": lat, "lng": lng, "source": main["source"] if main else "api",
        })
    return out


def is_good(r):
    """資料完整、時效內，才拿來判斷提醒。"""
    return r["rate"] is not None and not r["stale"] and not r["capacity_stale"]
