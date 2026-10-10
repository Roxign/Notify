// 查一次蝦皮 → 判斷面額與折數（規則 + 本機 AI）→ 寫 data/deals.json → 上傳到 GitHub Pages。
// 用法：npm run update [-- --show] [--no-ai] [--no-publish]
//   --show        顯示瀏覽器視窗（除錯用）
//   --no-ai       不用本機 AI，只用規則判斷
//   --no-publish  不上傳到 GitHub
//   --offline     不連蝦皮，改用上次的搜尋結果（調整判斷規則時用）

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyzeItem, formatZhe, hasBrand, isExcluded, isRelevant, parseFaceValues } from './analyze.mjs';
import { KEYWORDS, LOG_FILE, OLLAMA_MODEL, PAGES_PER_KEYWORD, PROFILE_DIR, RADAR_HOME, RAW_FILE } from './config.mjs';
import { classifyItems, startOllama } from './llm.mjs';
import { publish } from './publish.mjs';
import { ShopeeAuthError, openBrowser, searchAll } from './shopee.mjs';

const args = new Set(process.argv.slice(2));
const OUT_FILE = fileURLToPath(new URL('../data/deals.json', import.meta.url));

async function createLogger() {
  await mkdir(RADAR_HOME, { recursive: true });
  try {
    if ((await stat(LOG_FILE)).size > 2_000_000) await rename(LOG_FILE, `${LOG_FILE}.old`);
  } catch {
    /* 還沒有紀錄檔 */
  }
  return (msg) => {
    const line = `[${new Date().toLocaleString('zh-TW', { hour12: false })}] ${msg}`;
    console.log(line);
    appendFile(LOG_FILE, `${line}\n`).catch(() => {});
  };
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// 規則判斷為主；規則看不懂的，用 AI 的判斷補上
function buildItems(raw, ai) {
  const items = [];
  for (const r of raw) {
    // $1 的「聊聊詢價」、沒庫存、明確是空卡或周邊的跳過
    if (r.price < 10 || r.stock === 0 || !hasBrand(r.title) || isExcluded(r.title)) continue;
    const a = ai.get(r.id);
    const relevant = a ? a.kind === 'sell' || (a.kind === 'unknown' && isRelevant(r.title)) : isRelevant(r.title);
    if (!relevant) continue;

    const base = { title: r.title, priceMin: r.price, priceMax: r.priceMax, variations: r.variations };
    let res = analyzeItem(base);
    let byAi = false;
    // 只有規則完全找不到面額時才用 AI 的；規則找到好幾個面額卻對不上價格時，AI 也只是用猜的
    if (res.ratio === null && a?.faces.length && parseFaceValues(r.title, r.variations).faces.length === 0) {
      const aiRes = analyzeItem({ ...base, parsed: { faces: a.faces, qty: a.qty } });
      if (aiRes.ratio !== null) {
        res = { ...aiRes, note: [aiRes.note, '面額由本機 AI 判斷'].filter(Boolean).join('，') };
        byAi = true;
      }
    }

    const { stock, variations, ...rest } = r;
    items.push({
      ...rest,
      face: res.face,
      faceLabel: res.faceLabel,
      ratio: res.ratio,
      zhe: res.ratio === null ? '' : formatZhe(res.ratio),
      saving: res.face === null ? null : Math.round(res.face - r.price),
      deal: res.deal,
      ai: byAi,
      note: res.note,
      warn: res.warn,
    });
  }
  return items.sort((x, y) => {
    if (x.deal !== y.deal) return x.deal ? -1 : 1;
    if (!x.warn !== !y.warn) return x.warn ? 1 : -1;
    return (x.ratio ?? Infinity) - (y.ratio ?? Infinity) || x.price - y.price;
  });
}

async function runAi(raw, log) {
  if (args.has('--no-ai')) return { results: new Map(), info: { model: null, message: '這次沒有使用 AI' } };
  const candidates = raw.filter((r) => r.price >= 10 && r.stock !== 0 && hasBrand(r.title) && !isExcluded(r.title));
  let ollama;
  try {
    ollama = await startOllama();
    const results = await classifyItems(candidates, log);
    return { results, info: { model: OLLAMA_MODEL, message: '' } };
  } catch (err) {
    log(`AI 判斷失敗，改用規則判斷：${err.message}`);
    return { results: new Map(), info: { model: OLLAMA_MODEL, message: `AI 判斷失敗：${err.message}` } };
  } finally {
    await ollama?.stop();
  }
}

async function main() {
  const log = await createLogger();
  const now = new Date().toISOString();
  log('開始查詢蝦皮 7-11 商品卡');

  let raw = null;
  let failure = null;
  let browser;
  try {
    if (args.has('--offline')) {
      raw = JSON.parse(await readFile(RAW_FILE, 'utf8'));
      log(`使用上次的搜尋結果（${raw.length} 件），沒有連線蝦皮`);
    } else {
      await mkdir(PROFILE_DIR, { recursive: true });
      browser = await openBrowser({ headless: !args.has('--show') });
      raw = await searchAll(browser.page, KEYWORDS, PAGES_PER_KEYWORD, log);
      await writeFile(RAW_FILE, JSON.stringify(raw));
      log(`共讀到 ${raw.length} 件商品`);
    }
  } catch (err) {
    failure = err instanceof ShopeeAuthError
      ? `${err.message}。請在電腦上執行 npm run login 重新登入蝦皮。`
      : `查詢蝦皮失敗：${err.message}`;
    log(failure);
  } finally {
    await browser?.context.close().catch(() => {});
  }

  let result;
  if (raw) {
    const { results, info } = await runAi(raw, log);
    const items = buildItems(raw, results);
    result = {
      status: 'ok',
      updatedAt: now,
      dataUpdatedAt: now,
      message: '',
      keywords: KEYWORDS,
      ai: info,
      stats: { scanned: raw.length, relevant: items.length, deals: items.filter((i) => i.deal && !i.warn).length },
      items,
    };
    log(`7-11 商品卡 ${items.length} 件，低於面額 ${result.stats.deals} 件`);
    for (const i of items.filter((x) => x.deal).slice(0, 10)) {
      log(`  ${i.zhe.padEnd(6)} $${i.price}（面額 ${i.faceLabel}）${i.warn ? '⚠ ' : ''}${i.title}`);
    }
  } else {
    // 查詢失敗就沿用上一次的資料，網頁上會顯示失敗原因
    const prev = await loadPrevious();
    result = {
      status: 'error',
      updatedAt: now,
      dataUpdatedAt: prev?.dataUpdatedAt ?? null,
      message: failure,
      keywords: KEYWORDS,
      ai: prev?.ai ?? null,
      stats: prev?.stats ?? null,
      items: prev?.items ?? [],
    };
  }

  await writeFile(OUT_FILE, JSON.stringify(result));
  log(`已寫入 data/deals.json（狀態：${result.status}）`);

  if (!args.has('--no-publish')) {
    try {
      await publish(log);
    } catch (err) {
      log(`上傳 GitHub 失敗：${err.message}`);
      process.exitCode = 1;
    }
  }
  if (result.status === 'error') process.exitCode = 1;
}

await main();
