"""設定：從 settings.env 讀取（沒有這個檔案也能跑，只是通知管道會比較少）。"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env_file(path):
    """讀取 KEY=VALUE 格式的設定檔，已經設定的環境變數優先。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(os.path.join(ROOT, "settings.env"))

# ---------- 水利署開放資料 ----------
STATUS_URL = "https://opendata.wra.gov.tw/api/v2/2be9044c-6e44-4856-aad5-dd108c2e6679"  # 水庫水情資料（每小時）
DAILY_URL = "https://opendata.wra.gov.tw/api/v2/51023e88-4c76-4dbc-bbb9-470da690d539"   # 水庫每日營運狀況（名稱、有效容量）

FETCH_INTERVAL_MINUTES = int(os.getenv("FETCH_INTERVAL_MINUTES", "60"))
OBS_STALE_HOURS = 36          # 觀測超過幾小時算「待更新」
CAPACITY_STALE_DAYS = 7       # 容量資料超過幾天算「待更新」
SOURCE_STALE_HOURS = 3        # 多久沒成功抓到資料，就暫停提醒
MAX_RATE = 150                # 算出超過 150% 視為資料異常
HIDE_NO_RATE = os.getenv("HIDE_NO_RATE", "1") == "1"   # 算不出蓄水率的水庫不顯示（改成 0 就會全部顯示）

# ---------- 通知 ----------
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
ALERT_REARM_MARGIN = 2.0      # 回升到「門檻 + 2%」以上才重新提醒
ALERT_COOLDOWN_HOURS = 24     # 同一水庫 24 小時內最多一則

# ---------- 網站 ----------
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DB_PATH = os.getenv("DB_PATH", os.path.join(ROOT, "data", "waterwatch.db"))
STATIC_DIR = os.path.join(ROOT, "static")
