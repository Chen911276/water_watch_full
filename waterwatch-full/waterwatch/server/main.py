"""水見網站：API + 前端網頁 + 背景排程。"""
import hashlib
import json
import logging
import secrets
import threading
from contextlib import asynccontextmanager
from typing import List, Optional

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import alerts, config, db, demo, notify, wra

log = logging.getLogger("waterwatch")


def update_job():
    """抓資料 → 檢查提醒。第一次就連不上時，放示範快照讓網站仍可展示。"""
    if not wra.refresh() and demo.load_offline_snapshot():
        log.warning("無法連上水利署，暫時使用示範資料（畫面上會標示）")
    alerts.check_all()


@asynccontextmanager
async def lifespan(app):
    db.init()
    threading.Thread(target=update_job, daemon=True).start()
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(update_job, "interval", minutes=config.FETCH_INTERVAL_MINUTES, max_instances=1, coalesce=True)
    scheduler.start()
    notify.start_telegram_helper()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="水見｜台灣水庫水情", lifespan=lifespan, docs_url="/api/docs")


# ---------- 水情 ----------
@app.get("/api/water")
def water():
    with db.connect() as conn:
        items = wra.reservoirs(conn)
        if config.HIDE_NO_RATE:  # 沒有蓄水率（連舊資料都沒有）的水庫直接不顯示
            items = [r for r in items if r["rate"] is not None]
        return {"reservoirs": items, "status": wra.source_status(conn)}


@app.get("/api/history/{reservoir_id}")
def history(reservoir_id: str, days: int = 30):
    days = max(1, min(days, 90))
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM reservoirs WHERE id = ?", (reservoir_id,)).fetchone():
            raise HTTPException(404, "找不到這座水庫")
        return demo.history(conn, reservoir_id, days)


@app.get("/api/status")
def status():
    with db.connect() as conn:
        st = wra.source_status(conn)
        return {**st, "channels": notify.channels(), "alerts_paused": alerts.paused(conn)}


@app.post("/api/refresh")
def refresh():
    """手動立刻抓一次資料（例如 Demo 前）。"""
    update_job()
    return status()


# ---------- 通知訂閱 ----------
class SubscriptionIn(BaseModel):
    channel: str
    target: str
    reservoir_ids: List[str]
    threshold: float = 25
    consent: bool = False


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _public(sub):
    return {"channel": sub["channel"], "target": notify.mask(sub["channel"], sub["target"]),
            "reservoir_ids": json.loads(sub["reservoir_ids"]), "threshold": sub["threshold"],
            "active": bool(sub["active"]), "created_at": sub["created_at"]}


def _get_sub(conn, token):
    sub = conn.execute("SELECT * FROM subscriptions WHERE token_hash = ?", (_hash(token or ""),)).fetchone()
    if not token or not sub:
        raise HTTPException(404, "找不到此管理代碼對應的訂閱。")
    return sub


@app.post("/api/subscriptions")
def create_subscription(body: SubscriptionIn):
    if not body.consent:
        raise HTTPException(400, "請先勾選同意。")
    if not notify.channels().get(body.channel):
        raise HTTPException(400, "這個通知管道尚未開放。")
    target = body.target.strip()
    ids = sorted(set(body.reservoir_ids))
    if not ids or len(ids) > 100:
        raise HTTPException(400, "請選擇 1～100 座水庫。")
    if not 5 <= body.threshold <= 95:
        raise HTTPException(400, "提醒門檻需介於 5% 到 95%。")
    with db.connect() as conn:
        known = {r["id"] for r in conn.execute("SELECT id FROM reservoirs")}
    if set(ids) - known:
        raise HTTPException(400, "選擇的水庫中有不存在的代碼。")
    try:
        notify.validate_target(body.channel, target)
        notify.send(body.channel, target, f"✅ 水見水情提醒：測試訊息\n已訂閱 {len(ids)} 座水庫，蓄水率低於 {body.threshold:.0f}% 時通知你。")
    except notify.SendError as e:
        raise HTTPException(400, str(e))
    token = secrets.token_urlsafe(18)
    with db.write_lock(), db.connect() as conn:
        conn.execute("""INSERT INTO subscriptions (token_hash, channel, target, reservoir_ids, threshold, active, created_at)
                        VALUES (?, ?, ?, ?, ?, 1, ?)""",
                     (_hash(token), body.channel, target, json.dumps(ids), body.threshold, db.iso(db.now_tw())))
        sub = _get_sub(conn, token)
    return {"manage_token": token, "subscription": _public(sub)}


@app.get("/api/subscriptions/me")
def my_subscription(x_manage_token: Optional[str] = Header(None)):
    with db.connect() as conn:
        return _public(_get_sub(conn, x_manage_token))


@app.delete("/api/subscriptions/me", status_code=204)
def delete_subscription(x_manage_token: Optional[str] = Header(None)):
    with db.write_lock(), db.connect() as conn:
        sub = _get_sub(conn, x_manage_token)
        conn.execute("DELETE FROM alert_state WHERE subscription_id = ?", (sub["id"],))
        conn.execute("DELETE FROM subscriptions WHERE id = ?", (sub["id"],))
    return Response(status_code=204)


@app.post("/api/alerts/test")
def send_test(x_manage_token: Optional[str] = Header(None)):
    with db.connect() as conn:
        sub = _get_sub(conn, x_manage_token)
    try:
        notify.send(sub["channel"], sub["target"], "🔔 水見水情提醒：這是一則測試通知。")
    except notify.SendError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------- LINE Webhook（加好友或傳訊息時回覆 userId） ----------
@app.post("/api/line/webhook")
async def line_webhook(request: Request, x_line_signature: Optional[str] = Header(None)):
    body = await request.body()
    if not notify.line_signature_ok(body, x_line_signature):
        raise HTTPException(403, "簽章驗證失敗")
    notify.line_reply_user_id(json.loads(body or b"{}").get("events", []))
    return {"ok": True}


# ---------- 前端 ----------
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(f"{config.STATIC_DIR}/index.html")


app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
