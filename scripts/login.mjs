// 打開專用的 Chrome 視窗讓你登入蝦皮。登入資訊只存在這台電腦的 Chrome 設定檔裡。
// 用法：npm run login

import { mkdir } from 'node:fs/promises';
import { KEYWORDS, PROFILE_DIR } from './config.mjs';
import { fetchSearchPage, isBlockedUrl, openBrowser } from './shopee.mjs';

const TIMEOUT_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(PROFILE_DIR, { recursive: true });
const { context, page } = await openBrowser({ headless: false });
let closed = false;
context.on('close', () => (closed = true));

await page.goto('https://shopee.tw/buyer/login?next=https%3A%2F%2Fshopee.tw%2F', { waitUntil: 'domcontentloaded' });
await page.bringToFront();
console.log('請在跳出的 Chrome 視窗登入蝦皮（如果要求驗證也請一併完成）。');
console.log('登入成功後這個視窗會自動關閉。');

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (!closed && Date.now() < deadline) {
  await sleep(3000);
  if (closed) break;
  try {
    const url = page.url();
    if (!url.startsWith('https://shopee.tw') || isBlockedUrl(url)) continue;
    const { status, data } = await fetchSearchPage(page, KEYWORDS[0], 0);
    if (status === 200 && data && !data.error && Array.isArray(data.items)) {
      ok = true;
      break;
    }
  } catch {
    // 頁面跳轉中，等下一輪
  }
}

if (ok) {
  console.log('✓ 已登入，搜尋測試成功。之後可以執行 npm run update。');
  await sleep(1500);
} else if (closed) {
  console.log('視窗被關閉了，還沒確認登入成功。需要時再執行一次 npm run login。');
} else {
  console.log('等了 30 分鐘還沒登入成功，先結束。需要時再執行一次 npm run login。');
}
if (!closed) await context.close();
process.exit(ok ? 0 : 1);
