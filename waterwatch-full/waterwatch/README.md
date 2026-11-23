# 水見｜台灣水庫水情（完整版）

串接經濟部水利署開放資料的台灣水庫水情網站，包含：

- 全台水庫地圖（金門、馬祖示意位置）、水庫卡片、分區篩選、搜尋、排序、我的關注
- 每座水庫 30 天蓄水率折線圖
- **需要注意**：已低於 25%，或依近 7 天趨勢預估 30 天內會低於 25% 的水庫
- **漲跌趨勢**：卡片上顯示近 24 小時變化
- **預估可撐天數**：詳情裡的趨勢分析
- **水情通知**：使用者自行訂閱 Discord、Telegram 或 LINE，蓄水率跌破門檻時提醒

## 快速開始

需要 Python 3.10 以上。

```bash
pip install -r requirements.txt
python run.py
```

打開瀏覽器輸入 **http://127.0.0.1:8000**（終端機視窗不要關）。

啟動後會立刻抓一次水利署資料，之後每 60 分鐘自動更新。
如果連不上水利署，會暫時改用**示範資料**，頁面最上方會有紫色橫幅標示，連上後自動恢復。

## 資料夾結構

```
run.py                 啟動程式
settings.example.env   設定檔範例（通知金鑰）
server/
  main.py      網站 API、背景排程
  wra.py       抓水利署資料、計算蓄水率
  alerts.py    水情提醒規則
  notify.py    Discord / Telegram / LINE 發送
  demo.py      示範資料（實測不足或離線時）
  coords.py    水庫座標、分區
  db.py        SQLite 資料庫
  config.py    設定
static/
  index.html  app.js  style.css   前端網頁
  taiwan.json                     台灣地圖輪廓
data/waterwatch.db                資料庫（第一次啟動自動建立）
```

## 設定通知

### Discord（不用設定，直接能用）
使用者在 Discord 頻道設定 →「整合」→「Webhook」→「新增 Webhook」→「複製網址」，貼到網站的「設定水情通知」就好。

### Telegram
1. 在 Telegram 找 **@BotFather**，傳 `/newbot`，照指示取名，拿到 **token**
2. 把 `settings.example.env` 複製一份改名成 `settings.env`，填入 `TELEGRAM_BOT_TOKEN=你的token`
3. 重新啟動 `python run.py`
4. 使用者對你的 Bot 傳 `/start`，**Bot 會自動回覆他的 chat_id**，貼到網站就能訂閱

### LINE（Messaging API）
> LINE Notify 已在 2025 年停止服務，所以這裡用的是 LINE 官方帳號（Messaging API）。

1. 到 **LINE Developers**（developers.line.biz）建立 Provider →「Messaging API channel」
2. 在 channel 的「Basic settings」複製 **Channel secret**；在「Messaging API」頁產生 **Channel access token**
3. 在 `settings.env` 填入 `LINE_CHANNEL_ACCESS_TOKEN=…`、`LINE_CHANNEL_SECRET=…`，重新啟動
4. 讓 LINE 能自動回覆使用者的 userId（建議）：
   - 網站要有對外的 https 網址，用 cloudflared 或部署到 Render 都可以
   - 在「Messaging API」頁把 **Webhook URL** 設為 `https://你的網址/api/line/webhook`，打開「Use webhook」
   - 使用者加官方帳號好友後，會自動收到自己的 userId（U 開頭 33 碼），貼到網站就能訂閱

### 提醒規則
- 跌破使用者設定的門檻時提醒一次
- 回升到「門檻 + 2%」以上，之後再跌破才重新提醒
- 同一水庫 24 小時內最多一則
- 缺值、過期，或水利署來源中斷超過 3 小時時暫停提醒

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/water` | 全部水庫最新水情 + 資料來源狀態 |
| GET | `/api/history/{id}?days=30` | 單一水庫歷史蓄水率（實測不足的前段以示範資料補上，標記 `demo`） |
| GET | `/api/status` | 資料來源狀態、可用的通知管道、是否暫停提醒 |
| POST | `/api/refresh` | 立刻重新抓資料 |
| POST | `/api/subscriptions` | 建立訂閱（會先發測試訊息），回傳管理代碼 |
| GET / DELETE | `/api/subscriptions/me` | 查詢 / 刪除自己的訂閱（標頭 `X-Manage-Token`） |
| POST | `/api/alerts/test` | 發送測試通知 |
| POST | `/api/line/webhook` | LINE 官方帳號 Webhook（回覆 userId） |

互動式 API 文件：http://127.0.0.1:8000/api/docs

## 資料怎麼算

- **蓄水率** = 有效蓄水量（水情資料，每小時）÷ 有效容量（每日營運狀況）× 100%。超過 150% 視為資料異常不顯示；超過 100% 時和水利署一樣以 100% 顯示
- **分區**：依水庫代碼開頭，1 北部、2 中部、3 南部、4 東部、5 離島
- **歷史資料**：水利署 API 只提供近 24 小時，系統每小時存檔累積。剛開始使用時，30 天折線圖的前段是示範資料，畫成虛線
- **漲跌、預估**：在前端計算，只用實測資料；實測還不滿 3 天時暫用示範資料，畫面上標「示範」
- **座標**：`server/coords.py` 是約略位置，只用來在地圖上標點
- **不留空白**：水利署資料有缺時，依序用下面的真實資料補上，並在畫面上標註
  1. 超過 36 小時沒更新 → 顯示系統保存的最新一筆舊資料，標「舊資料 · N 天前」
  2. 最新一筆沒有蓄水量 → 蓄水率改用較早的紀錄，標「蓄水量為較早紀錄」
  3. 最新一天沒有容量 → 用前幾天的容量
  4. 完全算不出蓄水率（攔河堰、沒有觀測、查無容量）→ **不顯示**這座水庫
     想全部顯示的話，在 `settings.env` 加一行 `HIDE_NO_RATE=0`，此時會改顯示有效蓄水量、水位、每日進水量或有效容量，並寫明原因
  - 系統**不會自己估算或編造**蓄水率；舊資料不會觸發通知

## 部署給別人看

- **臨時網址**：保持 `python run.py` 開著，另開一個終端機執行 `cloudflared tunnel --url http://localhost:8000`
- **固定網址（Render）**：上傳到 GitHub → Render 建立 Web Service
  - Build Command：`pip install -r requirements.txt`
  - Start Command：`python run.py`
  - 通知金鑰改在 Render 的 Environment Variables 設定，不要上傳 `settings.env`
  - 免費方案重新啟動時資料庫會清空，累積的歷史和訂閱都會不見

## 資料來源與授權

- 水庫資料：經濟部水利署開放資料（政府資料開放授權條款第 1 版）
  - 水庫水情資料 https://data.gov.tw/dataset/45501
  - 水庫每日營運狀況 https://data.gov.tw/dataset/41568
- 地圖輪廓：taiwan-atlas（MIT 授權，內政部直轄市、縣市界線簡化），見 `static/taiwan-atlas-LICENSE.txt`
- 依資料集要求，蓄水率不以綠、黃、橙、紅色表示；蓄水率不等於官方水情燈號
