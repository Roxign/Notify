# 7-11 商品卡特價雷達

打開網頁就能看到蝦皮上**低於面額**的 7-11 商品卡，按折數排好，點一下直接到商品頁。

## 運作方式

蝦皮會擋掉網頁直接查詢的請求（沒有登入跟驗證會被回 403），而且 API 金鑰不能放在公開的網頁裡，所以查詢改在 GitHub Actions 上跑：

```
GitHub Actions（每 30 分鐘）
  └─ scripts/fetch-deals.mjs
       ├─ 用蝦皮分潤計畫 Open API 搜尋「7-11 商品卡」等關鍵字
       ├─ 從標題判斷面額，和售價比較算出折數（scripts/analyze.mjs）
       └─ 產生 data/deals.json
  └─ 把網頁和 data/deals.json 部署到 GitHub Pages

你打開網頁 → 讀取最新的 data/deals.json → 列出低於面額的商品卡
```

查詢失敗時網頁會繼續顯示上一次的資料，並標示失敗原因；GitHub 也會寄信通知。

## 架設步驟

### 1. 推到 GitHub

在 GitHub 建一個 **public** 的 repo（免費帳號的 Pages 只支援 public repo），然後：

```bash
git remote add origin https://github.com/<你的帳號>/<repo 名稱>.git
git push -u origin main
```

### 2. 開啟 GitHub Pages

Repo → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

### 3. 申請蝦皮 Open API 金鑰

1. 到 [蝦皮分潤計畫](https://affiliate.shopee.tw/) 註冊並登入
2. 在後台找到 **Open API**，申請後取得 **AppID** 和 **Secret**

### 4. 把金鑰放進 GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**，新增兩個：

| Name | Value |
| --- | --- |
| `SHOPEE_APP_ID` | 你的 AppID |
| `SHOPEE_APP_SECRET` | 你的 Secret |

### 5. 執行一次

Repo → **Actions → 更新特價資料並部署 → Run workflow**。跑完後打開：

```
https://<你的帳號>.github.io/<repo 名稱>/
```

之後每 30 分鐘會自動更新。可以把網址加到手機主畫面，隨時點開來看。

> 還沒設定金鑰之前，網頁也能開，會顯示設定提示和「直接到蝦皮搜尋」的連結。

## 調整

| 想改什麼 | 改哪裡 |
| --- | --- |
| 搜尋關鍵字、每個關鍵字查幾頁 | `scripts/fetch-deals.mjs` 的 `KEYWORDS`、`PAGES_PER_KEYWORD` |
| 更新頻率 | `.github/workflows/update-deals.yml` 的 `cron`（UTC 時間） |
| 哪些標題算 7-11 商品卡、怎麼判斷面額 | `scripts/analyze.mjs`（改完跑 `npm test`） |

## 本機測試

```bash
npm test
```

```bash
npm run serve
```

然後打開 http://localhost:8000 。要用本機抓真實資料，先設好環境變數 `SHOPEE_APP_ID`、`SHOPEE_APP_SECRET` 再執行 `npm run fetch`。

## 注意事項

- 面額是從商品標題自動判斷的，可能會判斷錯；下單前請點進商品確認面額和賣家評價。
- 遠低於面額（例如 7 折以下）的「序號」很可能是詐騙，網頁會特別標示警告。
- Public repo 如果 60 天沒有任何 commit，GitHub 會自動暫停排程；網頁會提示資料過舊，到 Actions 頁面按一下重新啟用即可。
