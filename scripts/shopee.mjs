// 用本機 Chrome（獨立的設定檔，登入過一次蝦皮）讀取搜尋結果。
// 搜尋請求是在蝦皮自己的頁面裡發出的，跟你平常用瀏覽器逛蝦皮一樣。

import { chromium } from 'playwright-core';
import { PROFILE_DIR, REQUEST_DELAY_MS } from './config.mjs';

export class ShopeeAuthError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(REQUEST_DELAY_MS[0] + Math.random() * (REQUEST_DELAY_MS[1] - REQUEST_DELAY_MS[0]));

export const searchPageUrl = (keyword) => `https://shopee.tw/search?keyword=${encodeURIComponent(keyword)}`;

const searchApiPath = (keyword, page) =>
  `/api/v4/search/search_items?by=relevancy&keyword=${encodeURIComponent(keyword)}` +
  `&limit=60&newest=${page * 60}&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2`;

export async function openBrowser({ headless = true } = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: null,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  if (headless) {
    // 無頭模式的 User-Agent 會帶「HeadlessChrome」，換成一般 Chrome 的寫法
    const ua = (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
    await context.setExtraHTTPHeaders({ 'User-Agent': ua });
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, 'userAgent', { get: () => value });
    }, ua);
  }
  return { context, page };
}

export function isBlockedUrl(url) {
  return /\/buyer\/login|\/verify\//.test(url);
}

// 在蝦皮頁面裡呼叫搜尋 API，回傳 { status, data }
export async function fetchSearchPage(page, keyword, pageIndex) {
  return page.evaluate(async (apiPath) => {
    const res = await fetch(apiPath, { credentials: 'include' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 回應 */
    }
    return { status: res.status, data };
  }, searchApiPath(keyword, pageIndex));
}

function toRawItem(b) {
  const money = (v) => (Number(v) > 0 ? Number(v) / 100000 : 0);
  const display = money(b.item_card_display_price?.price);
  const min = money(b.price_min) || money(b.price);
  const price = display && min ? Math.min(display, min) : display || min;
  return {
    id: String(b.itemid),
    title: b.name || '',
    price,
    priceMax: Math.max(money(b.price_max), price),
    shopeeDiscount: Number(b.raw_discount) || 0,
    sales: Number(b.historical_sold) || 0,
    stock: Number(b.stock) || 0,
    shop: b.shop_name || '',
    official: Boolean(b.is_official_shop),
    rating: Number(b.item_rating?.rating_star) || 0,
    image: b.image ? `https://down-tw.img.susercontent.com/file/${b.image}` : '',
    url: `https://shopee.tw/product/${b.shopid}/${b.itemid}`,
    variations: (b.tier_variations || []).flatMap((t) => t.options || []).filter(Boolean),
  };
}

export async function searchAll(page, keywords, pagesPerKeyword, log = console.log) {
  await page.goto(searchPageUrl(keywords[0]), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(4000);
  if (isBlockedUrl(page.url())) {
    throw new ShopeeAuthError('蝦皮要求登入或驗證');
  }

  const items = new Map();
  for (const keyword of keywords) {
    for (let p = 0; p < pagesPerKeyword; p++) {
      const { status, data } = await fetchSearchPage(page, keyword, p);
      if (status === 403 || data?.error === 90309999 || data?.is_login === false) {
        throw new ShopeeAuthError(`蝦皮擋下了搜尋（HTTP ${status}${data?.error ? `，錯誤碼 ${data.error}` : ''}）`);
      }
      if (status !== 200 || !data || data.error) {
        throw new Error(`搜尋「${keyword}」失敗（HTTP ${status}${data?.error ? `，錯誤碼 ${data.error}` : ''}）`);
      }
      const list = (data.items || []).map((i) => i.item_basic).filter(Boolean);
      for (const b of list) items.set(String(b.itemid), toRawItem(b));
      log(`  「${keyword}」第 ${p + 1} 頁：${list.length} 筆`);
      await randomDelay();
      if (data.nomore || list.length === 0) break;
    }
  }
  return [...items.values()];
}
