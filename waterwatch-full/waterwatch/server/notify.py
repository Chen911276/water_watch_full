"""通知管道：Discord、Telegram、LINE。"""
import base64
import hashlib
import hmac
import logging
import re
import threading
import time

import requests

from . import config

log = logging.getLogger("waterwatch")


class SendError(Exception):
    pass


def channels():
    """哪些管道可以用：Discord 不需設定；Telegram、LINE 要在 settings.env 填金鑰。"""
    return {"discord": True, "telegram": bool(config.TELEGRAM_BOT_TOKEN), "line": bool(config.LINE_CHANNEL_ACCESS_TOKEN)}


# ---------- 檢查通知目標格式 ----------
DISCORD_RE = re.compile(r"^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$")
TELEGRAM_RE = re.compile(r"^(-?\d{3,20}|@[A-Za-z][\w]{3,})$")
LINE_RE = re.compile(r"^U[0-9a-f]{32}$")


def validate_target(channel, target):
    rules = {
        "discord": (DISCORD_RE, "Discord Webhook 網址格式不正確，應為 https://discord.com/api/webhooks/… 開頭。"),
        "telegram": (TELEGRAM_RE, "Telegram chat_id 格式不正確，應為數字（例如 123456789）或 @頻道名稱。"),
        "line": (LINE_RE, "LINE userId 格式不正確，應為 U 開頭、共 33 碼。"),
    }
    if channel not in rules:
        raise SendError("不支援的通知管道。")
    pattern, message = rules[channel]
    if not pattern.match(target):
        raise SendError(message)


def mask(channel, target):
    """畫面上顯示時遮住大部分內容，避免外洩。"""
    if channel == "discord":
        return "Discord Webhook …" + target[-4:]
    return target[:3] + "…" + target[-3:] if len(target) > 8 else target


# ---------- 發送 ----------
def send(channel, target, text):
    try:
        if channel == "discord":
            r = requests.post(target, json={"content": text[:1900]}, timeout=10)
        elif channel == "telegram":
            r = requests.post(f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage",
                              json={"chat_id": target, "text": text}, timeout=10)
        elif channel == "line":
            r = requests.post("https://api.line.me/v2/bot/message/push",
                              headers={"Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}"},
                              json={"to": target, "messages": [{"type": "text", "text": text[:4900]}]}, timeout=10)
        else:
            raise SendError("不支援的通知管道。")
    except requests.RequestException as e:
        raise SendError(f"無法連線到 {channel}：{e.__class__.__name__}") from e
    if r.status_code >= 300:
        hint = {"discord": "請確認 Webhook 網址正確且尚未刪除。",
                "telegram": "請確認已先對 Bot 傳送 /start，且 chat_id 正確。",
                "line": "請確認已加入官方帳號為好友，且 userId 正確。"}[channel]
        raise SendError(f"測試訊息發送失敗（HTTP {r.status_code}）。{hint}")


# ---------- Telegram：對 Bot 傳 /start，Bot 回覆 chat_id ----------
def telegram_helper_loop():
    if not config.TELEGRAM_BOT_TOKEN:
        return
    api = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}"
    offset = None
    log.info("Telegram Bot 已啟動：使用者傳 /start 會收到自己的 chat_id")
    while True:
        try:
            r = requests.get(f"{api}/getUpdates", params={"timeout": 50, "offset": offset}, timeout=60)
            for u in r.json().get("result", []):
                offset = u["update_id"] + 1
                msg = u.get("message") or u.get("channel_post") or {}
                chat = msg.get("chat", {})
                if chat.get("id") is not None:
                    requests.post(f"{api}/sendMessage", json={
                        "chat_id": chat["id"],
                        "text": f"👋 這裡是水見水情提醒。\n你的 chat_id 是：{chat['id']}\n把它貼到水見網站的「設定水情通知」就可以了。"},
                        timeout=10)
        except Exception as e:  # 網路中斷時稍後重試
            log.debug("Telegram 輪詢暫時失敗：%s", e)
            time.sleep(10)


def start_telegram_helper():
    threading.Thread(target=telegram_helper_loop, daemon=True).start()


# ---------- LINE：加好友或傳訊息時，官方帳號回覆 userId ----------
def line_signature_ok(body: bytes, signature: str) -> bool:
    if not config.LINE_CHANNEL_SECRET or not signature:
        return False
    digest = hmac.new(config.LINE_CHANNEL_SECRET.encode(), body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), signature)


def line_reply_user_id(events):
    for ev in events:
        user_id = ev.get("source", {}).get("userId")
        token = ev.get("replyToken")
        if ev.get("type") in ("follow", "message") and user_id and token:
            requests.post("https://api.line.me/v2/bot/message/reply",
                          headers={"Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}"},
                          json={"replyToken": token, "messages": [{"type": "text", "text":
                                f"👋 這裡是水見水情提醒。\n你的 userId 是：\n{user_id}\n把它貼到水見網站的「設定水情通知」就可以了。"}]},
                          timeout=10)
