"""示範資料：只用在「實測資料還不夠」或「完全連不上水利署」的時候，畫面上都會標示。

1. 歷史示範：水利署 API 只給近 24 小時，系統要每小時存檔，累積 30 天才有完整折線圖。
   還沒累積到的那段，用示範資料補上（不存進資料庫，每次即時產生），前端畫成虛線。
2. 離線示範：第一次啟動就連不上水利署、資料庫又是空的，就放一份示範快照，
   讓 Demo 還能進行。之後只要成功連上，就會自動清掉。
"""
import math
import random
from datetime import timedelta

from . import db

# 水庫代碼、名稱、有效容量（萬立方公尺），整理自水利署每日營運狀況
RESERVOIRS = [
    ("10201", "石門水庫", 20526.0), ("10203", "西勢水庫", 39.6), ("10204", "新山水庫", 995.96),
    ("10205", "翡翠水庫", 36997.6), ("10206", "榮華壩", 6.4), ("10211", "青潭堰", 69.6),
    ("10212", "直潭壩", 174.98), ("10401", "寶山水庫", 500.83), ("10405", "寶山第二水庫", 3383.71),
    ("10501", "永和山水庫", 2993.43), ("10503", "大埔水庫", 529.9), ("10601", "明德水庫", 1242.28),
    ("20101", "鯉魚潭水庫", 11548.6), ("20201", "德基水庫", 18154.94), ("20202", "石岡壩", 120.21),
    ("20405", "士林攔河堰", 68.23), ("20501", "霧社水庫", 2433.42), ("20502", "日月潭水庫", 11082.86),
    ("20503", "集集攔河堰", 713.81), ("20507", "武界壩", 60.0), ("20508", "明湖下池水庫", 836.04),
    ("20509", "湖山水庫", 5041.0), ("30301", "仁義潭水庫", 2459.19), ("30302", "蘭潭水庫", 919.7),
    ("30306", "內埔子水庫", 69.0), ("30401", "白河水庫", 1436.28), ("30403", "德元埤水庫", 229.8),
    ("30501", "烏山頭水庫", 7885.19), ("30502", "曾文水庫", 48654.0), ("30503", "南化水庫", 8180.9),
    ("30504", "鏡面水庫", 96.57), ("30601", "虎頭埤水庫", 106.1), ("30602", "鹽水埤水庫", 47.1),
    ("30802", "阿公店水庫", 1480.05), ("31201", "牡丹水庫", 2603.66), ("31301", "成功水庫", 121.0),
    ("50102", "興仁水庫", 74.0), ("50103", "東衛水庫", 32.3), ("50104", "赤崁地下水庫", 51.0),
    ("50105", "西安水庫", 23.6), ("50106", "七美水庫", 22.5), ("50108", "小池水庫", 20.5),
    ("50201", "太湖水庫", 148.08), ("50202", "田埔水庫", 48.62), ("50203", "陽明湖水庫", 27.65),
    ("50204", "山西水庫", 19.02), ("50205", "榮湖水庫", 35.96), ("50206", "擎天水庫", 23.65),
    ("50207", "金沙水庫", 43.47), ("50208", "蓮湖水庫", 5.07), ("50209", "菱湖水庫", 8.25),
    ("50210", "西湖水庫", 41.41), ("50212", "金湖水庫", 38.11), ("50213", "瓊林水庫", 29.32),
    ("50214", "蘭湖", 17.62), ("50301", "勝利水庫", 18.18), ("50302", "秋桂山水庫", 3.15),
    ("50305", "儲水沃水庫", 4.17), ("50306", "津沙水庫", 4.58), ("50308", "坂里水庫", 14.11),
    ("50309", "東湧水庫", 8.5), ("50310", "后沃水庫", 41.63),
]


def _rng(seed_text):
    return random.Random(sum(ord(c) * (i + 1) for i, c in enumerate(seed_text)))


def demo_rate(reservoir_id, days_ago, anchor):
    """以實測的第一筆為終點，往回推出平滑的示範曲線。"""
    rnd = _rng(reservoir_id)
    drift = rnd.uniform(-0.6, 0.4)            # 每天變化（百分點）
    phase = rnd.uniform(0, 6.28)
    value = anchor - drift * days_ago + 1.2 * math.sin(days_ago / 3 + phase) - 1.2 * math.sin(phase)
    return round(max(1, min(100, value)), 2)


def history(conn, reservoir_id, days):
    """近 N 天的蓄水率。實測不足的前段以示範資料補齊。"""
    from .wra import compute_rate
    now = db.now_tw()
    start = now - timedelta(days=days)
    res = conn.execute("SELECT capacity FROM reservoirs WHERE id = ?", (reservoir_id,)).fetchone()
    cap = res["capacity"] if res else None
    rows = conn.execute("""
        SELECT observed_at, effective_storage, source FROM observations
        WHERE reservoir_id = ? AND observed_at >= ? ORDER BY observed_at
    """, (reservoir_id, db.iso(start))).fetchall()
    # 離線示範快照（mock）也標成 demo，前端才會畫成虛線、不當成實測
    points = [{"observed_at": r["observed_at"], "rate": compute_rate(r["effective_storage"], cap),
               "source": "demo" if r["source"] == "mock" else r["source"]} for r in rows]
    points = [p for p in points if p["rate"] is not None]
    if not points:
        return {"points": [], "has_demo": False}
    real = [p for p in points if p["source"] != "demo"]
    if not real:  # 只有示範快照：整段都用示範資料
        anchor = points[-1]
        first, points = db.parse_time(anchor["observed_at"]), [anchor]
    else:
        first = db.parse_time(points[0]["observed_at"])
    demo, t = [], start
    while t < first - timedelta(hours=3):
        demo.append({"observed_at": db.iso(t), "rate": demo_rate(reservoir_id, (first - t).total_seconds() / 86400,
                                                                 points[0]["rate"]), "source": "demo"})
        t += timedelta(hours=6)
    if demo:  # 讓虛線接上實線
        demo.append({"observed_at": points[0]["observed_at"], "rate": points[0]["rate"], "source": "demo"})
    return {"points": demo + points, "has_demo": bool(demo)}


def load_offline_snapshot():
    """連不上水利署且資料庫是空的：放一份示範快照，前端會顯示「示範資料」橫幅。"""
    with db.write_lock(), db.connect() as conn:
        if conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]:
            return False
        now = db.now_tw()
        for rid, name, cap in RESERVOIRS:
            rnd = _rng(rid)
            rate = rnd.choice([rnd.uniform(15, 30), rnd.uniform(35, 98), rnd.uniform(50, 100)])
            conn.execute("INSERT OR IGNORE INTO reservoirs (id, name, capacity, capacity_at) VALUES (?, ?, ?, ?)",
                         (rid, name, cap, db.iso(now - timedelta(days=1))))
            conn.execute("""INSERT OR IGNORE INTO observations
                (reservoir_id, observed_at, effective_storage, water_level, source) VALUES (?, ?, ?, NULL, 'mock')""",
                         (rid, db.iso(now.replace(minute=0, second=0)), round(cap * rate / 100, 2)))
        db.set_state(conn, "source", "mock")
        db.set_state(conn, "last_success_at", db.iso(now))
    return True
