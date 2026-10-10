// 用本機 Ollama 模型判斷規則看不懂的商品：是不是真的在賣 7-11 商品卡、面額多少。
// 結果依「商品 ID + 標題」快取，同一個商品只問一次。

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LLM_CACHE_FILE, OLLAMA_DIR, OLLAMA_MODEL, OLLAMA_MODELS, OLLAMA_URL } from './config.mjs';
import { faceAppearsIn, isPlausibleFace } from './analyze.mjs';

const BATCH_SIZE = 8;
const CACHE_TTL_DAYS = 30;
const KINDS = ['sell', 'buy', 'collectible', 'other', 'unknown'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `你負責整理蝦皮的商品資料。對每個商品判斷：
1. kind：
   - "sell"：在賣可以拿來消費的 7-11（統一超商）商品卡、禮券、禮物卡或電子序號
   - "buy"：收購、徵求、代收
   - "collectible"：空卡、無餘額的卡、收藏用的卡、卡套或其他周邊
   - "other"：其他商品，例如全家或其他商店的禮券、icash、跟 7-11 商品卡無關的東西
   - "unknown"：資訊不足，無法判斷
2. faces：每張卡的面額（新台幣整數）。只能填標題或規格裡真的有寫的金額；有好幾種面額就全部列出；看不出來就給空陣列。
   折數（例如 9折、95折）、運費、滿額門檻、折價金額都不是面額。
3. qty：一次購買包含幾張，沒寫就是 1。
每個輸入商品都要回傳一筆，id 照抄。`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          faces: { type: 'array', items: { type: 'integer' } },
          qty: { type: 'integer' },
        },
        required: ['id', 'kind', 'faces', 'qty'],
      },
    },
  },
  required: ['items'],
};

async function ping() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Ollama 沒在跑就自己啟動，回傳 stop()；原本就在跑的不會去關它
export async function startOllama() {
  if (await ping()) return { stop: async () => {} };
  const exe = path.join(OLLAMA_DIR, 'ollama.exe');
  if (!existsSync(exe)) throw new Error(`找不到 ${exe}`);
  const child = spawn(exe, ['serve'], {
    env: { ...process.env, OLLAMA_MODELS, OLLAMA_HOST: new URL(OLLAMA_URL).host },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await ping()) {
      return {
        stop: async () => {
          // 先卸載模型釋放顯示卡記憶體，再結束整個 Ollama 程序樹
          await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            body: JSON.stringify({ model: OLLAMA_MODEL, keep_alive: 0 }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {});
          await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => r()));
        },
      };
    }
  }
  child.kill();
  throw new Error('Ollama 啟動逾時');
}

async function askModel(batch) {
  const input = batch.map((it) => ({ id: it.id, title: it.title, variations: it.variations.slice(0, 20) }));
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      format: SCHEMA,
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return JSON.parse(body.message?.content || '{}').items || [];
}

// AI 的回答只是參考：種類要在清單內、面額要合理且真的出現在標題或規格裡
function sanitize(answer, item) {
  const kind = KINDS.includes(answer?.kind) ? answer.kind : 'unknown';
  const faces = [...new Set((answer?.faces || []).map(Number))]
    .filter((f) => isPlausibleFace(f) && faceAppearsIn(f, item.title, item.variations))
    .sort((a, b) => a - b);
  const qty = Number.isInteger(answer?.qty) && answer.qty >= 1 && answer.qty <= 50 ? answer.qty : 1;
  return { kind, faces, qty };
}

const cacheKey = (it) =>
  `${it.id}:${createHash('sha1').update(`${it.title}|${it.variations.join('|')}`).digest('hex').slice(0, 12)}`;

async function loadCache() {
  try {
    return JSON.parse(await readFile(LLM_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400_000;
  const kept = Object.fromEntries(Object.entries(cache).filter(([, v]) => v.seenAt >= cutoff));
  await mkdir(path.dirname(LLM_CACHE_FILE), { recursive: true });
  await writeFile(LLM_CACHE_FILE, JSON.stringify(kept));
}

// 回傳 Map<itemId, { kind, faces, qty }>
export async function classifyItems(items, log = console.log) {
  const cache = await loadCache();
  const now = Date.now();
  const results = new Map();
  const todo = [];
  for (const it of items) {
    const hit = cache[cacheKey(it)];
    if (hit && hit.model === OLLAMA_MODEL) {
      hit.seenAt = now;
      results.set(it.id, hit.answer);
    } else {
      todo.push(it);
    }
  }
  log(`  AI 判斷：快取 ${results.size} 筆，新商品 ${todo.length} 筆`);

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const started = Date.now();
    const answers = new Map((await askModel(batch)).map((a) => [String(a.id), a]));
    for (const it of batch) {
      if (!answers.has(it.id)) continue; // 模型漏回的下次再問
      const answer = sanitize(answers.get(it.id), it);
      results.set(it.id, answer);
      cache[cacheKey(it)] = { model: OLLAMA_MODEL, answer, seenAt: now };
    }
    log(`  AI 判斷 ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    await saveCache(cache);
  }
  await saveCache(cache);
  return results;
}
