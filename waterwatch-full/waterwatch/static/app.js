/* 水見｜台灣水庫水情 — 前端只呼叫自己的後端 API */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const LOW = 25;               // 頁面顯示用的關注門檻（訂閱可自訂）
  let items = [], status = null, region = "全部", onlyLow = false, onlyFavs = false, loading = false;
  const ls = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  let favorites = ls.get("water-favorites", []);
  if (!Array.isArray(favorites)) favorites = [];

  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 1) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("zh-TW", { maximumFractionDigits: d }));
  // 後端時間為台灣時間（無時區），補上 +08:00 再交給瀏覽器
  const tw = (t) => (t ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t + "+08:00") : null);
  const time = (t, full = false) => (t ? tw(t).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", ...(full ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "無觀測時間");
  const good = (r) => r.percent !== null && !r.stale && !r.capacityStale;
  const low = (r) => good(r) && r.percent < LOW;
  // 說明這筆為什麼算不出可靠的蓄水率：[卡片短標, 詳情說明]；資料完整時回傳 null
  function reason(r) {
    if (!r.time) return ["水利署未提供觀測", "水利署水情 API 近 24 小時沒有這座水庫的觀測資料，系統也還沒有保存過它的舊資料（常見於攔河堰、小型壩與離島水庫）。水利署一有回傳就會自動顯示。"];
    if (r.stale) return [`舊資料 · ${ago(r.ageHours)}`, `水利署近 36 小時沒有更新這座水庫，這裡顯示系統保存的最新一筆舊資料（觀測時間 ${time(r.time, true)}，約 ${ago(r.ageHours)}）。數值可能已不代表現況。`];
    if (r.capacity === null && r.capacityTime === null) return ["查無有效容量", "水利署每日營運資料中查不到這座水庫的名稱與有效容量，因此無法計算蓄水率。"];
    if (r.storage === null) return ["只有水位資料", "水利署只提供水位，沒有有效蓄水量（攔河堰以引水為主、不蓄水），因此無法計算蓄水率。"];
    if (r.capacity === null) return ["查無有效容量", "水利署每日營運資料沒有這座水庫的有效容量，因此無法計算蓄水率。"];
    if (r.capacityStale) return ["容量資料逾 7 日", "有效容量資料超過 7 日未更新，計算出的蓄水率可能不準確。"];
    if (r.percent === null) return ["數值異常已略過", "計算出的蓄水率超過 150%，可能是容量資料錯誤或單位不一致，因此不顯示。"];
    return null;
  }
  function toast(t) { $("#toast").textContent = t; $("#toast").classList.add("visible"); setTimeout(() => $("#toast").classList.remove("visible"), 2800); }

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = body.detail;
      const e = new Error(Array.isArray(d) ? d.map((x) => x.msg).join("；") : d || `連線失敗（HTTP ${res.status}）`);
      e.status = res.status; throw e;
    }
    return body;
  }

  // 後端欄位 → 版型使用的欄位
  const adapt = (r) => ({
    // 與水利署官方一致：蓄水量超過有效容量時以 100% 顯示，實際計算值保留在 rawPercent
    id: r.id, name: r.name, region: r.region, percent: r.rate === null ? null : Math.min(r.rate, 100), rawPercent: r.rate, capacity: r.capacity, storage: r.effective_storage,
    level: r.water_level, fullLevel: r.full_level, rain: r.rainfall, inflow: r.inflow, outflow: r.outflow,
    time: r.observed_at, capacityTime: r.capacity_at, stale: r.stale, capacityStale: r.capacity_stale,
    lat: r.lat, lng: r.lng, source: r.source,
    filled: r.filled, ageHours: r.age_hours, levelTime: r.level_observed_at,
    deadLevel: r.dead_level, dayIn: r.daily_inflow, dayOut: r.daily_outflow, dayAt: r.daily_at,
  });
  // ---------- 不留空白：沒有蓄水率時，改顯示這座水庫手上有的其他真實數據 ----------
  const has = (v) => v !== null && v !== undefined;
  const md = (t) => (t ? tw(t).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }) : "");
  // 可用欄位（依優先順序）：[代號, 標籤, 數值, 單位, 小數位]
  const fields = (r) => [
    ["storage", "有效蓄水量", r.storage, "萬 m³", 1], ["level", "水位高度", r.level, "公尺", 2],
    ["capacity", "有效容量", r.capacity, "萬 m³", 1], ["dayIn", `進水量（${md(r.dayAt)}）`, r.dayIn, "萬 m³", 1],
    ["dayOut", `出水量（${md(r.dayAt)}）`, r.dayOut, "萬 m³", 1], ["fullLevel", "滿水位", r.fullLevel, "公尺", 2],
  ].filter((f) => has(f[2]));
  // 卡片主數字
  function primary(r) {
    if (has(r.percent)) return { key: "pct", label: "蓄水百分比", value: num(r.percent), unit: "%" };
    const f = fields(r)[0];
    if (!f) return { key: null, label: "蓄水百分比", value: "—", unit: "" };
    const why = f[0] === "storage" ? "（無容量，無法算百分比）" : f[0] === "level" ? "（無蓄水量資料）" : "（無觀測資料）";
    return { key: f[0], label: f[1] + why, value: num(f[2], f[4]), unit: f[3] };
  }
  // 卡片下方兩格：避開主數字已顯示的欄位，只放有值的
  function cells(r) {
    const k = primary(r).key, list = fields(r).filter((f) => f[0] !== k).slice(0, 2);
    if (!list.length) return '<div><span>資料狀態</span><b>水利署未提供其他數據</b></div>';
    return list.map((f) => `<div><span>${escape(f[1])}</span><b>${num(f[2], f[4])} <small>${f[3]}</small></b></div>`).join("");
  }
  // 資料距今多久：用來標註「舊資料 · 3 天前」
  const ago = (h) => (h === null || h === undefined ? "" : h < 48 ? `${Math.round(h)} 小時前` : `${Math.round(h / 24)} 天前`);

  // ---------- 地圖 ----------
  // 簡化地圖：不載入圖磚，只畫台灣本島、澎湖、馬祖的陸地輪廓（frontend/taiwan.json）
  const map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.25, zoomControl: false, attributionControl: false, minZoom: 6.5, maxZoom: 11 })
    .setView([23.7, 120.6], 7.5);
  L.control.zoom({ position: "bottomright", zoomInTitle: "放大", zoomOutTitle: "縮小" }).addTo(map);
  map.createPane("land").style.zIndex = 350;
  // 縣市名稱在陸地之上、水庫圓點之下，且不攔截滑鼠
  const labelPane = map.createPane("labels");
  labelPane.style.zIndex = 380; labelPane.style.pointerEvents = "none";
  // 離島示意位置：馬祖、金門實際離本島很遠，移到台灣海峽中的空白海面，以虛線框標示
  // 馬祖往南移到本島西北方；金門往東移到澎湖北方
  const INSETS = [
    { name: "馬祖", test: (lat, lng) => lat > 25.85 && lng < 120.6, dLat: -1.05, dLng: 0 },
    { name: "金門", test: (lat, lng) => lng < 118.7, dLat: 0, dLng: 1.05 },
  ];
  const place = (lat, lng) => {
    const s = INSETS.find((i) => i.test(lat, lng));
    return s ? [lat + s.dLat, lng + s.dLng] : [lat, lng];
  };
  fetch("/static/taiwan.json").then((r) => r.json()).then((geo) => {
    const kind = (f) => f.properties.kind || "land";
    const toLatLng = ([lng, lat]) => L.latLng(place(lat, lng));
    const land = L.geoJSON(geo, {
      pane: "land", interactive: false, coordsToLatLng: toLatLng, filter: (f) => kind(f) === "land",
      style: { color: "#c9d8da", weight: 1, fillColor: "#ffffff", fillOpacity: 1 },
    }).addTo(map);
    // 縣市界線
    L.geoJSON(geo, {
      pane: "land", interactive: false, coordsToLatLng: toLatLng, filter: (f) => kind(f) === "border",
      style: { color: "#d3dee0", weight: 1, dashArray: "3 3" },
    }).addTo(map);
    // 縣市名稱（面積小的市放大後才顯示，避免擠在一起）
    geo.features.filter((f) => kind(f) === "label").forEach((f) => {
      const [lng, lat] = f.geometry.coordinates;
      L.marker(place(lat, lng), {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "county-label" + (f.properties.minor ? " minor" : ""), html: escape(f.properties.name), iconSize: null }),
      }).addTo(map);
    });
    const syncLabels = () => $("#map").classList.toggle("zoomed-in", map.getZoom() >= 8.5);
    map.on("zoomend", syncLabels);
    INSETS.forEach(({ name }) => {
      const layer = land.getLayers().find((l) => l.feature.properties.name === name);
      if (!layer) return;
      const box = layer.getBounds().pad(0.25);
      L.rectangle(box, { pane: "land", interactive: false, color: "#9fb3b9", weight: 1, dashArray: "4 4", fill: false }).addTo(map);
      map.openTooltip(`${name}（示意位置）`, [box.getSouth(), box.getCenter().lng], { permanent: true, direction: "bottom", className: "inset-label" });
    });
    const b = land.getBounds();
    map.fitBounds(b, { padding: [16, 16] });
    map.setMaxBounds(b.pad(0.25));
    syncLabels();
  }).catch(() => { /* 輪廓載入失敗時仍可顯示圓點 */ });
  const markerLayer = L.layerGroup().addTo(map);
  const PURPLE = "#7c63a4", GRAY = "#bdc7cb";
  // 25%→100%：淺藍→深藍（不使用綠黃橙紅）
  function blue(p) {
    const t = Math.max(0, Math.min(1, (p - LOW) / (100 - LOW)));
    const a = [0x9f, 0xcb, 0xdc], b = [0x1f, 0x6a, 0x8f];
    return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  const colorOf = (r) => (!good(r) ? GRAY : low(r) ? PURPLE : blue(r.percent));
  function drawMarkers(list) {
    markerLayer.clearLayers();
    // 大的先畫，小水庫在上層才點得到
    [...list].filter((r) => r.lat != null).sort((a, b) => (b.capacity || 0) - (a.capacity || 0)).forEach((r) => {
      const radius = Math.max(6, Math.min(20, 4 + Math.sqrt(r.capacity || 1) / 12));
      const m = L.circleMarker(place(r.lat, r.lng), {
        radius, fillColor: colorOf(r), fillOpacity: good(r) ? 0.9 : 0.6,
        color: low(r) ? "#4d3a6e" : "#ffffff", weight: low(r) ? 2.5 : 1.5,
      });
      const tr = trends[r.id];
      m.bindTooltip(`<b>${escape(r.name)}</b><br>${r.percent === null ? `${escape(primary(r).label.replace(/（.*）/, ""))} ${primary(r).value} ${primary(r).unit}` : num(r.percent) + "%"}${good(r) ? "" : "・" + escape(reason(r)?.[0] ?? "待更新")}${tr && tr.change24 !== null ? `・24h ${trendText(tr.change24)}` : ""}${tr?.attention === "soon" ? `<br>${escape(tr.text)}` : ""}`, { direction: "top" });
      m.on("click", () => openDetail(r.id));
      m.addTo(markerLayer);
    });
  }

  // ---------- 趨勢分析：漲跌、預估可撐天數、需要注意 ----------
  // 全部在前端計算，資料來自既有的 /api/history，不需修改後端。
  const TREND_DAYS = 7;        // 用最近幾天推估下降速度
  const ATTENTION_DAYS = 30;   // 預估幾天內會低於門檻，就列入「需要注意」
  const MIN_SPAN_DAYS = 3;     // 實測資料至少跨幾天才推估，太短容易誤判
  const HOUR = 36e5, DAY = 864e5;
  let trends = {}, trendsAt = 0, trendsLoading = false;

  // 在 points 中找最接近 target 時間的一筆；差距超過 tolerance 就當作沒有
  function nearest(points, target, tolerance) {
    let best = null;
    for (const p of points) if (!best || Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
    return best && Math.abs(best.t - target) <= tolerance ? best : null;
  }
  // 最新一筆和「指定時間以前」那筆相比，差幾個百分點
  function changeOver(points, ms, tolerance) {
    if (points.length < 2) return null;
    const last = points.at(-1), prev = nearest(points.slice(0, -1), last.t - ms, tolerance);
    return prev ? last.y - prev.y : null;
  }
  // 最小平方法：平均每天變化幾個百分點
  function slopePerDay(points) {
    if (points.length < 6 || (points.at(-1).t - points[0].t) / DAY < MIN_SPAN_DAYS) return null;
    const xs = points.map((p) => (p.t - points[0].t) / DAY), ys = points.map((p) => p.y);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let sxy = 0, sxx = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
    return sxx ? sxy / sxx : null;
  }
  function forecast(r, slope) {
    if (!good(r)) return { days: null, text: "資料不足，無法推估" };
    if (low(r)) return { days: 0, text: `已低於 ${LOW}%` };
    if (slope === null) return { days: null, text: "資料累積中，尚無法推估" };
    if (slope > -0.05) return { days: null, text: "持平或上升中" };
    const days = Math.round((r.rawPercent - LOW) / -slope);
    return days > 365 ? { days: null, text: "一年內不會低於門檻" } : { days, text: `約 ${days} 天後低於 ${LOW}%` };
  }
  function analyze(r, h) {
    const toPts = (list) => list.filter((p) => p.rate !== null).map((p) => ({ t: tw(p.observed_at).getTime(), y: p.rate })).sort((a, b) => a.t - b.t);
    let pts = toPts(h.points.filter((p) => p.source !== "demo")), demo = false;
    // 實測累積不足時，改用含示範資料的序列，並在畫面上標示「示範」
    if ((!pts.length || (pts.at(-1).t - pts[0].t) / DAY < MIN_SPAN_DAYS) && h.has_demo) { pts = toPts(h.points); demo = true; }
    const recent = pts.length ? pts.filter((p) => p.t >= pts.at(-1).t - TREND_DAYS * DAY) : [];
    const slope = slopePerDay(recent);
    const f = forecast(r, slope);
    return {
      change24: changeOver(pts, DAY, 6 * HOUR), change7d: changeOver(pts, 7 * DAY, DAY),
      slope, days: f.days, text: f.text, demo,
      attention: low(r) ? "below" : f.days !== null && f.days <= ATTENTION_DAYS ? "soon" : null,
    };
  }
  // 一次最多同時抓 6 座的歷史資料，30 分鐘內不重複抓
  async function loadTrends(force = false) {
    if (trendsLoading || (!force && Date.now() - trendsAt < 30 * 60e3 && Object.keys(trends).length)) return;
    trendsLoading = true;
    const queue = items.filter(good), next = {};
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try { next[r.id] = analyze(r, await api(`/api/history/${encodeURIComponent(r.id)}?days=${TREND_DAYS + 1}`)); }
        catch { /* 單座失敗不影響其他水庫 */ }
      }
    };
    try { await Promise.all(Array.from({ length: 6 }, worker)); trends = next; trendsAt = Date.now(); }
    finally { trendsLoading = false; render(); }
  }
  // 漲跌小標籤：↑ 藍、↓ 深色（不使用紅綠）
  function trendChip(change, unit = "24h") {
    if (change === null || change === undefined) return "";
    if (Math.abs(change) < 0.05) return `<span class="trend flat">→ 持平<small>${unit}</small></span>`;
    return `<span class="trend ${change > 0 ? "up" : "down"}">${change > 0 ? "↑" : "↓"} ${num(Math.abs(change))}<small>${unit}</small></span>`;
  }
  const trendText = (c) => (c === null || c === undefined ? "" : Math.abs(c) < 0.05 ? "持平" : `${c > 0 ? "↑" : "↓"}${num(Math.abs(c))}`);
  function renderAttention() {
    const box = $("#attention-list"); if (!box) return;
    const ready = Object.keys(trends).length;
    const list = items.filter((r) => trends[r.id]?.attention)
      .sort((a, b) => (trends[a.id].days ?? 0) - (trends[b.id].days ?? 0) || a.percent - b.percent);
    $("#attention-count").textContent = ready ? `${list.length} 座` : "";
    box.innerHTML = !ready
      ? `<div class="watch-empty">${trendsLoading ? "正在分析近 7 天趨勢…" : "尚無趨勢資料"}</div>`
      : !list.length ? '<div class="watch-empty">目前沒有需要注意的水庫。</div>'
      : list.map((r) => { const t = trends[r.id]; return `<button class="watch-item ${t.attention}" data-detail="${escape(r.id)}">
          <span class="watch-main"><span class="location">${escape(r.region)} · ${escape(r.id)}</span><strong>${escape(r.name)}</strong>
          <span class="watch-reason">${escape(t.text)}${t.demo ? '<i class="demo-tag">示範</i>' : ""}</span></span>
          <span class="watch-side"><b>${num(r.percent)}<small>%</small></b>${trendChip(t.change24)}</span></button>`; }).join("");
  }
  function trendBox(r) {
    const t = trends[r.id];
    if (!good(r)) return "";
    if (!t) return `<div class="trend-box"><p class="help" style="margin:0">${trendsLoading ? "正在分析趨勢…" : "尚無趨勢資料。"}</p></div>`;
    const cell = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return `<div class="trend-box ${t.attention || ""}"><div class="chart-title"><h3>趨勢分析</h3>${t.demo ? '<span class="demo-tag">含示範資料</span>' : ""}</div>
      <dl class="trend-grid">${cell("近 24 小時", trendChip(t.change24, "") || "—")}${cell("近 7 天", trendChip(t.change7d, "") || "—")}${cell("預估", escape(t.text))}</dl>
      <p class="chart-note">${t.slope === null ? "預估需要至少 3 天的資料。" : `近 7 天平均每天${t.slope >= 0 ? "增加" : "減少"} <b>${num(Math.abs(t.slope), 2)}</b> 個百分點。`}預估假設維持目前速度，實際會受降雨與用水影響，僅供參考。${t.demo ? "實測資料尚未累積滿 3 天，暫以示範資料推估。" : ""}</p></div>`;
  }

  // ---------- 卡片 ----------
  function filtered() {
    const q = $("#search").value.trim();
    let visible = items.filter((r) => (region === "全部" || r.region === region) && (!q || r.name.includes(q) || r.id.includes(q)) && (!onlyLow || low(r)) && (!onlyFavs || favorites.includes(r.id)));
    const sort = $("#sort").value;
    // 依地區排序（預設）：地區代碼順序，缺少蓄水率的排在最後
    if (sort === "region") visible.sort((a, b) => (a.percent === null) - (b.percent === null) || a.id.localeCompare(b.id));
    if (sort === "low" || sort === "high") visible.sort((a, b) => (a.percent === null ? 1 : b.percent === null ? -1 : sort === "low" ? a.percent - b.percent : b.percent - a.percent));
    if (sort === "name") visible.sort((a, b) => a.name.localeCompare(b.name, "zh-TW"));
    // 預估最快低於門檻：已低於的排最前，其次依預估天數，無法推估的排最後
    if (sort === "forecast") visible.sort((a, b) => (trends[a.id]?.days ?? Infinity) - (trends[b.id]?.days ?? Infinity) || (a.percent ?? 999) - (b.percent ?? 999));
    return visible;
  }

  function render() {
    $("#fav-count").textContent = favorites.length;
    $("#stat-total").textContent = items.length;
    $("#stat-valid").textContent = items.filter((r) => r.percent !== null).length;
    $("#stat-low").textContent = items.filter(low).length;
    $("#stat-stale").textContent = items.filter((r) => !good(r)).length;
    const visible = filtered();
    $("#result-count").textContent = visible.length + " 座";
    $("#only-low").setAttribute("aria-pressed", onlyLow); $("#only-favs").setAttribute("aria-pressed", onlyFavs);
    $("#cards").innerHTML = visible.length ? visible.map((r) => `<article class="card ${low(r) ? "low" : ""} ${!good(r) ? "stale" : ""}"><div class="card-top"><div><p class="location">${escape(r.region)} · ${escape(r.id)}</p><button class="name" data-detail="${escape(r.id)}">${escape(r.name)}</button></div><button class="star ${favorites.includes(r.id) ? "saved" : ""}" data-star="${escape(r.id)}" aria-label="${favorites.includes(r.id) ? "取消關注" : "關注"}${escape(r.name)}" aria-pressed="${favorites.includes(r.id)}">${favorites.includes(r.id) ? "★" : "☆"}</button></div><div class="card-main"><div class="percent"><span>${escape(primary(r).label)}</span><strong class="${has(r.percent) ? "" : "alt"}">${primary(r).value}${primary(r).unit ? `<small>${primary(r).unit}</small>` : ""}</strong><br><div class="badge" ${good(r) ? "" : `title="${escape(reason(r)?.[1] ?? "")}"`}>${!good(r) ? escape(reason(r)?.[0] ?? "資料待更新") : low(r) ? "低於提醒門檻" : "25% 以上"}</div>${trendChip(trends[r.id]?.change24)}</div><div class="gauge" role="img" aria-label="蓄水率 ${r.percent === null ? "未知" : num(r.percent) + "%"}"><div class="water${r.percent === null ? " empty" : ""}" style="--fill:${r.percent === null ? 0 : Math.max(0, Math.min(r.percent, 100))}%"></div>${r.percent === null ? '<span class="gauge-note">無蓄水率</span>' : ""}</div></div><div class="card-data">${cells(r)}</div><div class="card-footer"><span>◷ ${r.time ? escape(time(r.time)) : r.dayAt ? `營運統計 ${escape(md(r.dayAt))}` : "無觀測時間"}${r.stale ? ` · <b class="old-tag">舊資料</b>` : r.filled ? ` · <b class="old-tag">蓄水量為較早紀錄</b>` : ""}</span><button data-detail="${escape(r.id)}">查看詳情 ↗</button></div></article>`).join("")
      : '<div class="empty">沒有符合條件的水庫。<button class="text-button" id="reset-filters">清除篩選</button></div>';
    $("#reset-filters")?.addEventListener("click", () => { region = "全部"; onlyLow = onlyFavs = false; $("#search").value = ""; document.querySelectorAll("[data-region]").forEach((b) => b.classList.toggle("selected", b.dataset.region === "全部")); render(); });
    // 地圖跟隨地區／關注／低水位篩選（不跟隨搜尋，避免地圖一直清空）
    drawMarkers(items.filter((r) => (region === "全部" || r.region === region) && (!onlyLow || low(r)) && (!onlyFavs || favorites.includes(r.id))));
    renderAttention();
    // 詳情視窗開著時，趨勢分析完成後即時更新
    if ($("#detail").open && detailId && $("#trend-slot")) { const r = items.find((x) => x.id === detailId); if (r) $("#trend-slot").innerHTML = trendBox(r); }
  }

  // ---------- 狀態 ----------
  function drawStatus() {
    const s = status;
    const mock = s.source === "mock";
    $("#sync-label").textContent = s.last_success_at ? `最近取得 ${time(s.last_success_at, true)} · 台灣時間` : "尚未取得資料";
    $("#live-source").textContent = mock ? "示範資料" : s.stale ? "資料待更新" : "即時資料";
    $("#live-desc").textContent = mock ? "無法連上水利署，暫以示範資料展示" : "經濟部水利署 · 每小時更新";
    $("#notice").hidden = !mock;
    $("#notice").textContent = "🧪 目前無法連上水利署，以下為示範資料 · 非即時水情 · 僅供展示";
    $("#error").hidden = !s.stale;
    $("#error").textContent = s.consecutive_fail
      ? `水利署來源暫時無法連線（已連續 ${s.consecutive_fail} 次失敗），以下為 ${time(s.last_success_at, true)} 取得的資料。已暫停水情提醒，請留意觀測時間。`
      : "資料超過 3 小時未更新，以下為上次取得資料。已暫停水情提醒，請留意觀測時間。";
  }

  async function load() {
    if (loading) return;
    loading = true; $("#refresh").disabled = true; $("#refresh").textContent = "↻ 更新中…";
    try {
      const d = await api("/api/water");
      items = d.reservoirs.map(adapt); status = d.status;
      drawStatus(); render();
      loadTrends();   // 背景分析趨勢，完成後自動更新畫面
    } catch (e) {
      $("#error").hidden = false; $("#error").textContent = "無法連線到本站伺服器：" + e.message; $("#sync-label").textContent = "連線暫時中斷";
      if (!items.length) $("#cards").innerHTML = '<div class="empty">暫時無法取得水庫資料。<br>請使用上方「重新整理」重試。</div>';
    } finally { loading = false; $("#refresh").disabled = false; $("#refresh").textContent = "↻ 重新整理"; }
  }

  // ---------- 詳情 + 30 天折線圖 ----------
  let chart, detailId = null;
  async function openDetail(id) {
    const r = items.find((x) => x.id === id); if (!r) return;
    detailId = id;
    $("#detail-content").innerHTML = `<p class="eyebrow">${escape(r.region)} / RESERVOIR ${escape(r.id)}</p><h2>${escape(r.name)}</h2>
      <div class="detail-percent" style="color:${r.stale ? "#7d8b92" : low(r) ? PURPLE : "inherit"}">${r.stale ? `<span class="old-tag" style="font-size:12px;vertical-align:middle;margin-right:10px">舊資料 · ${escape(ago(r.ageHours))}</span>` : ""}${has(r.percent) ? `${num(r.percent)}<small>%</small>` : `<span style="font-size:.55em">${primary(r).value}<small> ${primary(r).unit}</small></span><span class="help" style="display:block;font-size:12px;margin-top:4px">${escape(primary(r).label)}</span>`}</div>
      <p class="help">${!good(r) ? escape(reason(r)?.[1] ?? "資料不足或待更新。") + "本筆不會觸發提醒。" : low(r) ? "蓄水率低於 25% 關注門檻。" : "蓄水率以最新蓄水量與有效容量計算。"}${r.filled && !r.stale ? `<br>水利署最新一筆只有水位、沒有蓄水量，蓄水率改用系統保存的較早紀錄（${escape(time(r.time, true))}）。` : ""}${r.rawPercent > 100 ? `<br>目前蓄水量超過有效容量，實際計算值為 <b>${num(r.rawPercent)}%</b>；與水利署相同，以 100% 顯示。` : ""}</p>
      <div id="trend-slot">${trendBox(r)}</div>
      <div class="chart-title"><h3>近 30 天蓄水率</h3><span id="chart-range"></span></div>
      <div class="chart-wrap"><canvas id="chart" role="img" aria-label="${escape(r.name)} 近 30 天蓄水率折線圖"></canvas></div>
      <p class="chart-note" id="chart-note">載入中…</p>
      ${(() => {
        const rows = [["有效蓄水量", r.storage, " 萬 m³", 1], ["有效容量", r.capacity, " 萬 m³", 1], ["水位", r.level, " 公尺", 2], ["滿水位", r.fullLevel, " 公尺", 2], ["呆水位", r.deadLevel, " 公尺", 2], ["集水區累積雨量", r.rain, " 毫米", 1], ["進流量", r.inflow, " m³/秒", 2], ["總出流量", r.outflow, " m³/秒", 2], [`進水量（${md(r.dayAt)} 統計）`, r.dayIn, " 萬 m³", 1], [`出水量（${md(r.dayAt)} 統計）`, r.dayOut, " 萬 m³", 1]];
        const shown = rows.filter((x) => has(x[1])), missing = rows.filter((x) => !has(x[1]) && !x[0].includes("統計")).map((x) => x[0]);
        return `<dl class="detail-grid">${shown.map(([a, v, u, d]) => `<div><dt>${a}</dt><dd>${num(v, d)}${u}</dd></div>`).join("")}</dl>${missing.length ? `<p class="help">水利署未提供：${missing.join("、")}。</p>` : ""}`;
      })()}
      <p class="help">觀測時間：${escape(time(r.time, true))}<br>容量統計時間：${escape(time(r.capacityTime, true))}<br>時間均為台灣時間。蓄水量與容量可能來自不同統計時間；超過 100% 時以 100% 顯示。</p>`;
    if (!$("#detail").open) $("#detail").showModal();
    try {
      const h = await api(`/api/history/${encodeURIComponent(id)}?days=30`);
      if ($("#chart")) drawChart(h);
    } catch (e) { $("#chart-note").textContent = "歷史資料載入失敗：" + e.message; }
  }

  function drawChart(h) {
    chart?.destroy();
    const note = $("#chart-note");
    if (!h.points.length) { $(".chart-wrap").hidden = true; note.textContent = "此水庫尚無蓄水率紀錄（缺少蓄水量或有效容量資料）。"; return; }
    const xs = h.points.map((p) => tw(p.observed_at).getTime());
    const pick = (want) => h.points.map((p, i) => ({ x: xs[i], y: want(p.source) && p.rate !== null ? Math.min(p.rate, 100) : null }));
    const datasets = [];
    if (h.has_demo) datasets.push({ label: "示範資料（非實測）", data: pick((s) => s === "demo"), borderColor: "#b5a6cf", borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true });
    datasets.push({ label: "實測", data: pick((s) => s !== "demo"), borderColor: "#2c85ad", backgroundColor: "#2c85ad", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 });
    datasets.push({ label: "25% 關注門檻", data: [{ x: xs[0], y: LOW }, { x: xs.at(-1), y: LOW }], borderColor: PURPLE, borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0 });
    const tick = { color: "#8a9ba3", font: { family: "'Noto Sans TC', system-ui", size: 10 } };
    chart = new Chart($("#chart"), {
      type: "line", data: { datasets },
      options: {
        maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: { type: "linear", min: xs[0], max: xs.at(-1), grid: { display: false }, border: { color: "#e1e8e8" },
            ticks: { ...tick, maxTicksLimit: 6, callback: (v) => new Date(v).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric", timeZone: "Asia/Taipei" }) } },
          y: { suggestedMin: 0, suggestedMax: 100, grid: { color: "#eef1f2" }, border: { display: false }, ticks: { ...tick, stepSize: 25, callback: (v) => v + "%" } },
        },
        plugins: {
          legend: { position: "bottom", labels: { ...tick, boxWidth: 14, boxHeight: 2, padding: 12 } },
          tooltip: { backgroundColor: "#183c50", titleFont: tick.font, bodyFont: tick.font, callbacks: {
            title: (it) => new Date(it[0].parsed.x).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            label: (it) => ` ${it.dataset.label}：${it.parsed.y.toFixed(1)}%` } },
        },
      },
    });
    const days = Math.max(1, Math.round((xs.at(-1) - xs[0]) / 864e5));
    $("#chart-range").textContent = `${new Date(xs[0]).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })} – ${new Date(xs.at(-1)).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}`;
    note.innerHTML = h.has_demo
      ? "虛線為<b>示範資料</b>：水利署 API 僅提供近 24 小時，系統累積滿 30 天前以模擬資料展示；實線為實測。"
      : `實測資料，目前累積約 ${days} 天。系統每小時自動存檔。`;
  }

  // ---------- 通知訂閱 ----------
  const CH = {
    discord: { name: "Discord", label: "2. Discord Webhook 網址", type: "password", ph: "https://discord.com/api/webhooks/…",
      info: "Discord 提醒會送到你指定的文字頻道。",
      how: ["如何取得 Webhook？", "在你有管理權限的 Discord 伺服器，開啟文字頻道設定 → 整合 → Webhook → 新增 Webhook → 複製 Webhook 網址。請勿貼在公開訊息中。"] },
    line: { name: "LINE", label: "2. LINE userId", type: "text", ph: "U 開頭，共 33 碼",
      info: "LINE 提醒由本站官方帳號（Messaging API）推播給你。LINE Notify 已停止服務。",
      how: ["如何取得 userId？", "先加入本站 LINE 官方帳號為好友，官方帳號會自動回覆你的 userId（U 開頭 33 碼）；沒收到的話，傳任意訊息給它即可。"] },
    telegram: { name: "Telegram", label: "2. Telegram chat_id", type: "text", ph: "例如 123456789 或 @my_channel",
      info: "Telegram 提醒由本站 Bot 傳送給你或你的頻道。",
      how: ["如何取得 chat_id？", "先對本站 Bot 傳送 /start，Bot 會回覆你的 chat_id。若要送到頻道，請把 Bot 加為頻道管理員並填入 @頻道名稱。"] },
  };
  let channel = "discord", available = { discord: true };
  const token = () => ls.get("manageToken", null);

  function chooseChannel(c) {
    channel = c;
    document.querySelectorAll("[data-channel]").forEach((b) => { const on = b.dataset.channel === c; b.classList.toggle("chosen", on); b.setAttribute("aria-checked", on); });
    const d = CH[c];
    $("#target-label").textContent = d.label; $("#target").type = d.type; $("#target").placeholder = d.ph; $("#target").value = "";
    $("#target-help summary").textContent = d.how[0]; $("#target-help p").textContent = d.how[1];
    $("#channel-info").textContent = d.info;
  }
  document.querySelectorAll("[data-channel]").forEach((b) => (b.onclick = () => {
    const c = b.dataset.channel;
    if (!available[c]) { $("#channel-info").textContent = `${CH[c].name} 尚未連接。需由網站管理者設定${c === "line" ? " LINE 官方帳號的 Channel access token" : " Telegram Bot token"}後才會開放。`; return; }
    chooseChannel(c);
  }));
  $("#threshold").oninput = (e) => ($("#threshold-out").textContent = e.target.value + "%");

  function showSubscription(sub) {
    if (!sub) { $("#subscription-status").textContent = "尚未訂閱"; return; }
    const names = sub.reservoir_ids.map((id) => items.find((r) => r.id === id)?.name || id);
    $("#subscription-status").innerHTML = `<p class="help" style="margin:0">已訂閱：<b>${escape(CH[sub.channel]?.name || sub.channel)}</b>（${escape(sub.target)}）· ${names.length} 座水庫 · 門檻 <b>${num(sub.threshold, 0)}%</b>${sub.active ? "" : " · 已暫停"}<br>重新儲存會以新設定取代目前的訂閱。</p>
      <div class="sub-actions"><button type="button" class="secondary" id="send-test">發送測試通知</button><button type="button" class="secondary danger" id="unsubscribe">取消訂閱並刪除通知資料</button></div>`;
    document.querySelectorAll("#reservoir-options input").forEach((i) => (i.checked = sub.reservoir_ids.includes(i.value)));
    $("#threshold").value = sub.threshold; $("#threshold-out").textContent = num(sub.threshold, 0) + "%";
    $("#send-test").onclick = async (e) => {
      e.target.disabled = true;
      try { await api("/api/alerts/test", { method: "POST", headers: { "X-Manage-Token": token() }, body: "{}" }); toast("測試通知已送出"); }
      catch (err) { $("#form-message").textContent = err.message; } finally { e.target.disabled = false; }
    };
    $("#unsubscribe").onclick = async (e) => {
      e.target.disabled = true;
      try { await api("/api/subscriptions/me", { method: "DELETE", headers: { "X-Manage-Token": token() } }); ls.del("manageToken"); showSubscription(null); $("#token-box").innerHTML = ""; $("#form-message").textContent = "通知設定與通知目標已刪除。"; }
      catch (err) { $("#form-message").textContent = err.message; e.target.disabled = false; }
    };
  }

  async function loadSubscription(t) {
    try { showSubscription(await api("/api/subscriptions/me", { headers: { "X-Manage-Token": t } })); return true; }
    catch (e) { if (e.status === 404 && t === token()) ls.del("manageToken"); return false; }
  }

  async function openNotify() {
    $("#notify").showModal(); $("#form-message").textContent = ""; $("#token-box").innerHTML = ""; $("#consent").checked = false;
    const opts = items.filter((r) => r.percent !== null).sort((a, b) => a.id.localeCompare(b.id));
    $("#reservoir-options").innerHTML = opts.length ? opts.map((r) => `<label><input type="checkbox" value="${escape(r.id)}" ${favorites.includes(r.id) ? "checked" : ""}>${escape(r.name)}</label>`).join("") : "請先取得水庫資料，再設定通知。";
    try {
      const s = await api("/api/status");
      available = s.channels || available;
      document.querySelectorAll("[data-channel]").forEach((b) => { b.querySelector("small").textContent = available[b.dataset.channel] ? "可設定" : "尚未連接"; });
      $("#monitor-status").textContent = s.alerts_paused
        ? "⚠ 資料來源目前中斷或過期，自動提醒暫停中；恢復後會自動重新檢查。"
        : `最近背景檢查：${time(s.last_attempt_at, true)}；系統每小時檢查一次。`;
    } catch { $("#monitor-status").textContent = "無法取得背景檢查狀態。"; }
    if (!available[channel]) channel = "discord";
    chooseChannel(channel);
    if (!(token() && await loadSubscription(token()))) showSubscription(null);
  }
  $("#notify-top").onclick = openNotify; $("#notify-bottom").onclick = openNotify;

  $("#notification-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $(".submit"), ids = [...document.querySelectorAll("#reservoir-options input:checked")].map((i) => i.value);
    const target = $("#target").value.trim();
    if (!ids.length) return ($("#form-message").textContent = "請至少選擇一座水庫。");
    if (!target) return ($("#form-message").textContent = "請填寫通知目標。");
    if (!$("#consent").checked) return ($("#form-message").textContent = "請勾選同意後再儲存。");
    button.disabled = true; button.textContent = "正在連線測試…";
    try {
      const old = token();
      const r = await api("/api/subscriptions", { method: "POST", body: JSON.stringify({ channel, target, reservoir_ids: ids, threshold: Number($("#threshold").value), consent: true }) });
      if (old) await api("/api/subscriptions/me", { method: "DELETE", headers: { "X-Manage-Token": old } }).catch(() => {});
      const saved = ls.set("manageToken", r.manage_token);
      $("#form-message").textContent = `訂閱已儲存，測試訊息已送到 ${CH[channel].name}。`;
      $("#token-box").innerHTML = `<div class="token-box">你的<b>管理代碼</b>${saved ? "已存在此瀏覽器" : "（此瀏覽器無法儲存，請務必自行保存）"}。換裝置或清除瀏覽資料後，需要它才能修改或取消訂閱：<code>${escape(r.manage_token)}</code></div>`;
      $("#target").value = ""; $("#consent").checked = false;
      showSubscription(r.subscription);
    } catch (err) { $("#form-message").textContent = err.message || "連線失敗，請稍後重試。"; }
    finally { button.disabled = false; button.textContent = "連線測試並儲存訂閱"; }
  };

  $("#restore").onclick = async () => {
    const t = $("#restore-token").value.trim(); if (!t) return;
    if (await loadSubscription(t)) { ls.set("manageToken", t); $("#restore-token").value = ""; toast("已載入訂閱"); }
    else $("#form-message").textContent = "找不到此管理代碼對應的訂閱。";
  };

  // ---------- 事件 ----------
  document.querySelectorAll("[data-region]").forEach((b) => (b.onclick = () => { region = b.dataset.region; document.querySelectorAll("[data-region]").forEach((n) => n.classList.toggle("selected", n === b)); render(); }));
  $("#search").oninput = render; $("#sort").onchange = render; $("#refresh").onclick = load;
  $("#only-low").onclick = () => { onlyLow = !onlyLow; render(); };
  $("#only-favs").onclick = () => { onlyFavs = !onlyFavs; render(); };
  $("#nav-favs").onclick = () => { onlyFavs = true; render(); $("#reservoirs").scrollIntoView(); };
  ["grid", "list"].forEach((v) => ($("#view-" + v).onclick = () => { $("#cards").classList.toggle("list", v === "list"); ["grid", "list"].forEach((n) => $("#view-" + n).setAttribute("aria-pressed", n === v)); }));
  $("#cards").onclick = (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const id = star.dataset.star;
      favorites = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
      if (!ls.set("water-favorites", favorites)) toast("瀏覽器無法保存收藏，本次使用仍可關注。");
      render(); return;
    }
    const b = e.target.closest("[data-detail]"); if (b) openDetail(b.dataset.detail);
  };
  document.querySelectorAll("dialog").forEach((d) => {
    d.querySelector(".close").onclick = () => d.close();
    d.addEventListener("click", (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
  });
  $("#detail").addEventListener("close", () => { chart?.destroy(); chart = null; detailId = null; });
  $("#attention-list").onclick = (e) => { const b = e.target.closest("[data-detail]"); if (b) openDetail(b.dataset.detail); };

  load();
  setInterval(() => { if (!document.hidden) load(); }, 300000);
})();
