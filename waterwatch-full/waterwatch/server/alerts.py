"""水情提醒：每次抓完資料後檢查所有訂閱。

規則（和網頁上的說明一致）：
- 跌破門檻時提醒一次
- 回升到「門檻 + 2%」以上，之後再跌破才重新提醒
- 同一水庫 24 小時內最多一則
- 缺值、過期，或水利署來源中斷時不發送
"""
import json
import logging
from datetime import timedelta

from . import config, db, notify, wra

log = logging.getLogger("waterwatch")


def paused(conn):
    st = wra.source_status(conn)
    return st["stale"] or st["source"] == "mock"


def check_all():
    with db.connect() as conn:
        if paused(conn):
            log.info("資料來源中斷或為示範資料，暫停提醒")
            return 0
        data = {r["id"]: r for r in wra.reservoirs(conn)}
        subs = conn.execute("SELECT * FROM subscriptions WHERE active = 1").fetchall()
    sent = 0
    now = db.now_tw()
    for sub in subs:
        for rid in json.loads(sub["reservoir_ids"]):
            r = data.get(rid)
            if not r or not wra.is_good(r):
                continue
            with db.write_lock(), db.connect() as conn:
                st = conn.execute("SELECT * FROM alert_state WHERE subscription_id = ? AND reservoir_id = ?",
                                  (sub["id"], rid)).fetchone()
                armed = st["armed"] if st else 1
                last = db.parse_time(st["last_sent_at"]) if st else None
                if r["rate"] >= sub["threshold"] + config.ALERT_REARM_MARGIN:
                    armed = 1
                fire = (r["rate"] < sub["threshold"] and armed
                        and (last is None or now - last >= timedelta(hours=config.ALERT_COOLDOWN_HOURS)))
                if fire:
                    text = (f"💧 水見水情提醒\n{r['name']} 蓄水率 {r['rate']:.1f}%，"
                            f"低於你設定的 {sub['threshold']:.0f}%。\n觀測時間：{r['observed_at'].replace('T', ' ')}（台灣時間）")
                    try:
                        notify.send(sub["channel"], sub["target"], text)
                        armed, last, sent = 0, now, sent + 1
                    except notify.SendError as e:
                        log.warning("提醒發送失敗（訂閱 %s）：%s", sub["id"], e)
                conn.execute("""
                    INSERT INTO alert_state (subscription_id, reservoir_id, armed, last_sent_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(subscription_id, reservoir_id) DO UPDATE SET armed = excluded.armed, last_sent_at = excluded.last_sent_at
                """, (sub["id"], rid, armed, db.iso(last)))
    if sent:
        log.info("已發送 %s 則水情提醒", sent)
    return sent
