# 7-11 商品卡特價雷達

打開網頁就能看到蝦皮上**低於面額**的 7-11 商品卡，按折數排好，點一下直接到商品頁。

**網頁：https://roxign.github.io/Notify/**

## 運作方式

蝦皮的搜尋要登入才能用，也會擋掉伺服器發出的查詢，所以查詢在你自己的電腦上跑：

```
Windows 工作排程器（每小時，電腦開著時）
  └─ npm run update（scripts/update.mjs）
       ├─ 用本機 Chrome（專用設定檔，登入過一次蝦皮）讀取搜尋結果     scripts/shopee.mjs
       ├─ 規則判斷面額和折數                                           scripts/analyze.mjs
       ├─ 規則看不懂的商品交給本機 AI（Ollama + qwen3.5:4b）判斷     scripts/llm.mjs
       │    └─ 是不是真的在賣商品卡（排除空卡、收購、周邊）、面額多少
       ├─ 寫出 data/deals.json
       └─ 把網頁和資料推到 GitHub 的 gh-pages 分支                    scripts/publish.mjs

手機打開 GitHub Pages 網址 → 讀取最新的 data/deals.json → 列出低於面額的商品卡
```

AI 的判斷只是補充：它給的面額一定要真的出現在標題或規格裡才會採用，而且每個商品只問一次（結果快取在 `E:\711-radar\llm-cache.json`）。

## 本機檔案位置

| 東西 | 位置 |
| --- | --- |
| Ollama 程式 | `E:\ollama` |
| AI 模型 | `E:\ollama\models` |
| 蝦皮登入用的 Chrome 設定檔 | `E:\711-radar\chrome-profile` |
| 執行紀錄 | `E:\711-radar\update.log` |

路徑可以在 `scripts/config.mjs` 改，或用環境變數 `RADAR_HOME`、`OLLAMA_DIR` 覆寫。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm run login` | 打開 Chrome 讓你登入蝦皮（第一次，或登入過期時） |
| `npm run update` | 馬上查一次並上傳 |
| `npm run update -- --show --no-publish` | 顯示瀏覽器視窗、不上傳（除錯用） |
| `npm run schedule` | 建立每小時自動執行的排程 |
| `npm run schedule -- --remove` | 移除排程 |
| `npm run serve` | 在 http://localhost:8000 預覽網頁 |
| `npm test` | 測試面額判斷規則 |

## GitHub Pages

- `main` 分支放程式碼；`gh-pages` 分支放網頁和資料，每次 `npm run update` 都會用一個新的 commit 整個覆蓋。
- Repo 的 **Settings → Pages** 設定為 **Deploy from a branch → gh-pages / (root)**。
- 推送用的是這台電腦 Git 存的 GitHub 帳號（Roxign）。

## LINE 報單追蹤 bot（bot.py）

LINE 傳「通關151197 艙號0169」給 bot，它會每分鐘查一次關港貿單一窗口的報單狀態，有變化就推播，放行後停止。

- 在背景執行：登入 Windows 時由工作排程器用 `pythonw` 啟動（沒有視窗）；排程每 5 分鐘檢查一次，bot 當掉的話 5 分鐘內會重新啟動（已在跑時不會重複開）。
- ngrok：啟動時沿用已在跑的 tunnel，沒有就自己開；之後每分鐘檢查，tunnel 斷了會重開。
- LINE webhook：拿到 ngrok 網址後，透過 Messaging API 自動把 webhook 改成 `<ngrok 網址>/callback` 並測試，不用再去 LINE Developers 後台手動貼。
- 追蹤中的報單會存到 `E:\line-bot\tracking.json`，電腦重開後會接著追蹤。
- 紀錄檔：`E:\line-bot\bot.log`

設定：

1. `pip install -r requirements.txt`
2. 把 `.env.example` 複製成 `.env`，填入 LINE 的 channel access token 和 channel secret（`.env` 不會上傳到 GitHub）
3. 建立背景排程：

   ```bash
   python bot.py --install-task
   ```

   之後每次登入 Windows 都會自動啟動。要馬上啟動：`schtasks /Run /TN LINE報單追蹤bot`；移除排程：`python bot.py --remove-task`。

手動在終端機執行 `python bot.py` 也可以（會同時在畫面上顯示紀錄）；背景版本已在跑的話，手動執行的會直接結束。除錯時可以加 `--no-publish`，不會把網址上傳到 GitHub。

### 網頁的「通關查詢」分頁

網頁上方的大按鈕可以切換「7-11 商品卡」和「通關查詢」。通關查詢分頁直接連到電腦上的 bot：

- 輸入通關號碼和艙號 →「加入追蹤」（有變化用 LINE 通知 `.env` 裡的 `DEV_USER_IDS`）或「只查一次」（除錯用，不追蹤、不發 LINE，會列出所有原始紀錄）
- 看追蹤中的報單、停止追蹤
- 除錯資訊：bot 網址、LINE webhook 狀態、紀錄檔，以及「重新設定 LINE webhook」按鈕

運作方式：bot 每次拿到新的 ngrok 網址，除了更新 LINE webhook，也會寫進 `data/bot.json` 並推到 gh-pages，網頁就是從這裡找到 bot。

安全性：網頁是公開的，所以 bot 的 `/api/*` 都要密碼（`.env` 的 `WEB_API_KEY`），而且只接受 `https://roxign.github.io` 和本機預覽的請求。登入方式：

- 在 LINE **私訊** bot「網頁」，會回一個已帶密碼的連結（只有 `DEV_USER_IDS` 裡的人會收到，群組裡不會回）
- 或打開網頁的通關查詢分頁，輸入 `.env` 裡的 `WEB_API_KEY`

用 `npm run serve` 本機預覽時，網頁會直接連 `http://localhost:5000`，不經過 ngrok。

## 注意事項

- 電腦要開著、而且登入 Windows，排程才會跑；網頁超過 3 小時沒更新會顯示提示。
- 蝦皮登入過期或要求驗證時，網頁會顯示「需要重新登入」，在電腦上執行 `npm run login` 即可。
- 為了不被蝦皮當成機器人，每小時只查 5 個關鍵字、各 2 頁，每次搜尋之間會隨機等幾秒。請不要把頻率調得太高。
- 面額是自動判斷的，可能會判斷錯；下單前請點進商品確認面額和賣家評價。遠低於面額（例如 7 折以下）的「序號」很可能是詐騙，網頁會特別標示。
