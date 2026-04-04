# 🔥 VIRAL SPOTS — 爆紅店家探測器

找出 Google Maps 評論異常暴增的餐廳、咖啡廳、酒吧，並偵測可疑的人為操控行為。

---

## 🚀 快速開始

### 1. 安裝依賴套件

```bash
npm install
```

### 2. 設定 API Key

複製 `.env.example` 為 `.env`，填入你的 Google Places API Key：

```bash
cp .env.example .env
```

編輯 `.env`：
```
GOOGLE_PLACES_API_KEY=你的 API Key
PORT=3000
```

### 3. 設定前端地圖 API Key

打開 `public/index.html`，找到這一行：

```html
<script src="https://maps.googleapis.com/maps/api/js?key=REPLACE_WITH_YOUR_KEY_FOR_MAPS...
```

將 `REPLACE_WITH_YOUR_KEY_FOR_MAPS` 替換為你的 API Key（需啟用 Maps JavaScript API）。

### 4. 啟動伺服器

```bash
npm start
# 或開發模式（自動重啟）：
npm run dev
```

打開瀏覽器：http://localhost:3000

---

## 🔑 Google API 需啟用的服務

在 [Google Cloud Console](https://console.cloud.google.com/) 需啟用：

- **Maps JavaScript API** — 前端地圖顯示
- **Places API** — 搜尋店家與取得評論
- **Maps Static API**（選用）— 靜態地圖截圖

---

## 📊 爆紅偵測邏輯

### 爆紅指數（0–100）
- 近兩週新增 5+ 則評論 → +40 分
- 近一個月新增 8+ 則評論 → +20 分

### 可疑程度（0–100）
- 評論中出現大量相似關鍵詞 → +40 分
- 近期評論全為 5 星 → +30 分
- 多則評論來自無大頭貼帳號 → +15 分

---

## 🗂️ 專案結構

```
viral-spots/
├── server/
│   └── index.js          # Node.js 後端（Express）
├── public/
│   ├── index.html        # 主頁面
│   ├── css/style.css     # 黑色主題樣式
│   └── js/app.js         # 前端邏輯 + 地圖
├── .env.example          # 環境變數範本
├── package.json
└── README.md
```

---

## 💡 未來可擴充

- 加入 Instagram hashtag 搜尋（官方 Graph API）
- 排程每日更新評論數據
- 收藏清單功能（localStorage 或資料庫）
- 評論時間軸圖表（Chart.js）
