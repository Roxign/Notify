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

## 注意事項

- 電腦要開著、而且登入 Windows，排程才會跑；網頁超過 3 小時沒更新會顯示提示。
- 蝦皮登入過期或要求驗證時，網頁會顯示「需要重新登入」，在電腦上執行 `npm run login` 即可。
- 為了不被蝦皮當成機器人，每小時只查 5 個關鍵字、各 2 頁，每次搜尋之間會隨機等幾秒。請不要把頻率調得太高。
- 面額是自動判斷的，可能會判斷錯；下單前請點進商品確認面額和賣家評價。遠低於面額（例如 7 折以下）的「序號」很可能是詐騙，網頁會特別標示。
