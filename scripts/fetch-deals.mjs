// 透過蝦皮分潤計畫 Open API 搜尋 7-11 商品卡，算出折數後寫到 data/deals.json。
// 由 GitHub Actions 定時執行；金鑰放在 repo 的 Secrets，不會出現在網頁上。

import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { analyzeItem, formatZhe, isRelevant } from './analyze.mjs';

const ENDPOINT = process.env.SHOPEE_API_ENDPOINT || 'https://open-api.affiliate.shopee.tw/graphql';
const APP_ID = (process.env.SHOPEE_APP_ID || '').trim();
const SECRET = (process.env.SHOPEE_APP_SECRET || '').trim();
// 上一次部署的資料；這次查詢失敗時沿用，網頁才不會變空白
const PREVIOUS_URL = process.env.PREVIOUS_URL || '';

const KEYWORDS = ['7-11 商品卡', '統一超商 商品卡', '7-ELEVEN 商品卡', '711 禮物卡', '統一超商 禮券'];
const PAGES_PER_KEYWORD = 2;
const PAGE_SIZE = 50;
const FIELDS = 'itemId productName priceMin priceMax priceDiscountRate imageUrl productLink shopName sales ratingStar';

const OUT_DIR = new URL('../data/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callApi(query) {
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHash('sha256').update(APP_ID + timestamp + payload + SECRET).digest('hex');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('；'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body.data;
}

async function searchKeyword(keyword, page) {
  const query =
    `{productOfferV2(keyword:${JSON.stringify(keyword)},sortType:1,page:${page},limit:${PAGE_SIZE})` +
    `{nodes{${FIELDS}}pageInfo{page limit hasNextPage}}}`;
  const data = await callApi(query);
  return data?.productOfferV2 ?? { nodes: [], pageInfo: { hasNextPage: false } };
}

async function collectNodes() {
  const nodes = new Map();
  const errors = [];
  for (const keyword of KEYWORDS) {
    for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
      try {
        const result = await searchKeyword(keyword, page);
        for (const n of result.nodes ?? []) nodes.set(String(n.itemId), n);
        if (!result.pageInfo?.hasNextPage) break;
      } catch (err) {
        errors.push(`「${keyword}」第 ${page} 頁：${err.message}`);
        break;
      } finally {
        await sleep(300);
      }
    }
  }
  if (nodes.size === 0 && errors.length) throw new Error(errors[0]);
  return { nodes: [...nodes.values()], errors };
}

function toItem(n) {
  const price = Number(n.priceMin);
  const priceMax = Number(n.priceMax) || price;
  const a = analyzeItem({ title: n.productName, priceMin: price, priceMax });
  return {
    id: String(n.itemId),
    title: n.productName,
    shop: n.shopName || '',
    price,
    priceMax,
    image: n.imageUrl || '',
    url: n.productLink,
    sales: Number(n.sales) || 0,
    rating: Number(n.ratingStar) || 0,
    shopeeDiscount: Number(n.priceDiscountRate) || 0,
    face: a.face,
    faceLabel: a.faceLabel,
    ratio: a.ratio,
    zhe: a.ratio === null ? '' : formatZhe(a.ratio),
    saving: a.face === null ? null : Math.round(a.face - price),
    deal: a.deal,
    note: a.note,
    warn: a.warn,
  };
}

// 可信的特價在前、可疑的特價其次、其他最後
function byBestDeal(a, b) {
  if (a.deal !== b.deal) return a.deal ? -1 : 1;
  if (!a.warn !== !b.warn) return a.warn ? 1 : -1;
  if (a.deal) return a.ratio - b.ratio;
  return a.price - b.price;
}

async function loadPrevious() {
  if (!PREVIOUS_URL) return null;
  try {
    const res = await fetch(`${PREVIOUS_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const prev = await res.json();
    return Array.isArray(prev.items) && prev.items.length ? prev : null;
  } catch {
    return null;
  }
}

async function main() {
  const now = new Date().toISOString();
  const base = { updatedAt: now, keywords: KEYWORDS };
  let result;

  if (!APP_ID || !SECRET) {
    result = { ...base, status: 'not_configured', message: '尚未設定 SHOPEE_APP_ID / SHOPEE_APP_SECRET', items: [] };
  } else {
    try {
      const { nodes, errors } = await collectNodes();
      const items = nodes.filter((n) => isRelevant(n.productName)).map(toItem).sort(byBestDeal);
      result = {
        ...base,
        status: 'ok',
        dataUpdatedAt: now,
        message: errors.length ? `部分查詢失敗：${errors.join('；')}` : '',
        stats: { scanned: nodes.length, relevant: items.length, deals: items.filter((i) => i.deal).length },
        items,
      };
    } catch (err) {
      const prev = await loadPrevious();
      result = {
        ...base,
        status: 'error',
        message: err.message,
        dataUpdatedAt: prev?.dataUpdatedAt ?? null,
        stats: prev?.stats ?? null,
        items: prev?.items ?? [],
      };
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('deals.json', OUT_DIR), JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);

  console.log(`狀態：${result.status}${result.message ? `（${result.message}）` : ''}`);
  if (result.stats) {
    console.log(`掃描 ${result.stats.scanned} 件，7-11 商品卡 ${result.stats.relevant} 件，低於面額 ${result.stats.deals} 件`);
  }
  for (const i of result.items.filter((x) => x.deal).slice(0, 10)) {
    console.log(`  ${i.zhe}  $${i.price}（面額 ${i.faceLabel}）${i.title}`);
  }
}

await main();
