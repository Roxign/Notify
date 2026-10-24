// 分頁切換，以及「通關查詢」分頁：透過 ngrok 連到家裡電腦上的 bot.py
(() => {
  'use strict';

  const KEY_STORE = 'bot-api-key';
  const TAB_STORE = 'notify-tab';
  const STATUS_INTERVAL_MS = 20_000;
  // 本機預覽（npm run serve）時直接連本機的 bot，不經過 ngrok
  const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

  const $ = (id) => document.getElementById(id);

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* 無痕模式等情況存不了，略過 */
      }
    },
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false || c === '') continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const fmt = (iso) => (iso
    ? new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—');

  // ── 分頁切換 ──

  const views = { cards: $('view-cards'), customs: $('view-customs') };

  // 網址格式：#customs 或 #customs&key=密碼（LINE 傳「網頁」拿到的登入連結）
  function readHash() {
    const [view, ...rest] = location.hash.replace(/^#/, '').split('&');
    const params = new URLSearchParams(rest.join('&'));
    if (params.get('key')) {
      store.set(KEY_STORE, params.get('key'));
      history.replaceState(null, '', `${location.pathname}${location.search}#${view || 'customs'}`); // 密碼不要留在網址上
    }
    return views[view] ? view : null;
  }

  function showView(name) {
    for (const [k, el] of Object.entries(views)) {
      el.hidden = k !== name;
      $(`tab-${k}`).setAttribute('aria-selected', String(k === name));
    }
    store.set(TAB_STORE, name);
    if (location.hash.replace(/^#/, '') !== name) history.replaceState(null, '', `#${name}`);
    if (name === 'customs') activate();
    else deactivate();
  }

  for (const k of Object.keys(views)) $(`tab-${k}`).addEventListener('click', () => showView(k));
  window.addEventListener('hashchange', () => {
    const v = readHash();
    if (v) showView(v);
  });

  // ── 連線 ──

  class BotOffline extends Error {}
  class BadKey extends Error {}

  let botUrl = null;
  let botUrlUpdatedAt = null;

  async function loadBotUrl() {
    if (IS_LOCAL) {
      botUrl = 'http://localhost:5000';
      return;
    }
    const res = await fetch(`data/bot.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new BotOffline('還沒有 bot 的網址，bot 可能從來沒有啟動過');
    const info = await res.json();
    botUrl = info.url;
    botUrlUpdatedAt = info.updatedAt;
  }

  async function api(path, { method = 'GET', body, timeout = 15_000 } = {}, retried = false) {
    if (!botUrl) await loadBotUrl();
    // 連不上時，可能是 bot 重開、ngrok 換了網址：重新讀一次網址，有變就再試一次
    const retryWithNewUrl = async () => {
      if (retried || IS_LOCAL) return null;
      const old = botUrl;
      await loadBotUrl();
      return botUrl !== old ? api(path, { method, body, timeout }, true) : null;
    };

    let res;
    try {
      res = await fetch(botUrl + path, {
        method,
        headers: {
          'X-Api-Key': store.get(KEY_STORE) || '',
          'ngrok-skip-browser-warning': '1', // 不然 ngrok 免費版會回一個警告網頁
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error('bot 太久沒有回應');
      const retry = await retryWithNewUrl();
      if (retry) return retry;
      throw new BotOffline('連不到 bot');
    }

    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new BadKey(data?.error || '密碼錯誤');
    if (!data) {
      const retry = await retryWithNewUrl();
      if (retry) return retry;
      throw new BotOffline(`連不到 bot（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── 畫面 ──

  function showNotice(kind, title, ...body) {
    const box = $('bot-notice');
    box.className = `notice${kind === 'error' ? ' error' : ''}`;
    box.replaceChildren(h('strong', null, title), ...body.filter(Boolean));
    box.hidden = false;
  }

  function showKeyForm(message) {
    $('bot-main').hidden = true;
    $('key-card').hidden = false;
    $('bot-updated').textContent = '需要密碼';
    if (message) showNotice('error', message, h('p', null, '請重新輸入密碼。'));
    else $('bot-notice').hidden = true;
  }

  function handleError(err) {
    if (err instanceof BadKey) {
      store.set(KEY_STORE, null);
      showKeyForm(err.message);
    } else if (err instanceof BotOffline) {
      $('bot-updated').textContent = '連不到 bot';
      showNotice(
        'error',
        '連不到電腦上的 bot',
        h('p', null, `${err.message}。電腦可能沒開機、還沒登入 Windows，或 bot 正在重新啟動（大約 1 分鐘）。`),
        botUrlUpdatedAt ? h('p', null, `bot 網址最後更新：${fmt(botUrlUpdatedAt)}`) : null,
      );
    } else {
      showNotice('error', '發生錯誤', h('p', null, err.message));
    }
  }

  const SOURCE = { line: 'LINE', web: '網頁' };

  function renderTracking(list) {
    $('tracking-count').textContent = list.length;
    $('tracking-empty').hidden = list.length > 0;
    $('tracking').replaceChildren(...list.map((t) => {
      const stop = h('button', { type: 'button', class: 'btn small' }, '停止追蹤');
      stop.addEventListener('click', () => untrack(t.vsl, t.mft));
      const meta = [
        `開始 ${fmt(t.startedAt)}`,
        t.lastCheckedAt ? `上次查詢 ${fmt(t.lastCheckedAt)}` : '等待第一次查詢',
        `通知 ${t.subscribers} 人`,
        `來自${SOURCE[t.source] || t.source}`,
      ].join(' · ');
      return h('li', { class: 'track-item' },
        h('div', { class: 'track-head' }, h('span', { class: 'title' }, `通關 ${t.vsl} · 艙號 ${t.mft}`), stop),
        h('p', { class: 'meta' }, meta),
        h('p', { class: 'msg' }, t.latestMsg || '⏳ 搜尋中…'));
    }));
  }

  function renderInfo(s) {
    const w = s.webhook || {};
    const rows = [
      ['bot 網址', s.ngrokUrl || '—'],
      ['LINE webhook', w.ok === null || w.ok === undefined
        ? '尚未設定'
        : h('span', { class: w.ok ? 'ok' : 'bad' }, w.ok ? '✓ 正常' : `✗ ${w.message || '失敗'}`)],
      ['webhook 檢查時間', fmt(w.checkedAt)],
      ['bot 啟動時間', fmt(s.startedAt)],
      ['預設通知對象', `${s.devUsers} 人`],
      ['查詢狀態', s.searchBusy ? '正在查詢中' : '閒置'],
      ['網頁拿到網址的時間', IS_LOCAL ? '本機預覽，直接連 localhost:5000' : fmt(botUrlUpdatedAt)],
    ];
    $('bot-info').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  }

  let refreshing = false;
  async function refresh() {
    if (!store.get(KEY_STORE)) {
      showKeyForm();
      return;
    }
    if (refreshing) return;
    refreshing = true;
    $('bot-refresh').disabled = true;
    try {
      const s = await api('/api/status');
      $('key-card').hidden = true;
      $('bot-main').hidden = false;
      $('bot-notice').hidden = true;
      $('bot-updated').textContent = `已連線 · bot 啟動於 ${fmt(s.startedAt)}`;
      renderTracking(s.tracking);
      renderInfo(s);
      if ($('log-box').open) loadLogs();
    } catch (err) {
      handleError(err);
    } finally {
      refreshing = false;
      $('bot-refresh').disabled = false;
    }
  }

  function showResult(...children) {
    const box = $('search-result');
    box.className = 'result';
    box.replaceChildren(...children.filter(Boolean));
    box.hidden = false;
  }

  async function submitQuery(action) {
    const vsl = $('vsl').value.trim();
    const mft = $('mft').value.trim();
    const buttons = $('track-form').querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (action === 'track') {
        const r = await api('/api/track', { method: 'POST', body: { vsl, mft } });
        showResult(h('p', { class: r.added ? 'ok' : '' }, `${r.added ? '✓ ' : ''}${r.message}`));
        refresh();
      } else {
        showResult(h('p', { class: 'meta' }, '查詢中…通常要 10–60 秒，同時有追蹤在查的話會再久一點。'));
        const r = await api('/api/search', { method: 'POST', body: { vsl, mft }, timeout: 180_000 });
        const rows = (r.records || []).map((rec) => h('tr', null, rec.map((c) => h('td', null, c))));
        showResult(
          h('p', { class: 'meta' }, `${r.found ? '查到資料' : '查無資料'} · 花了 ${r.seconds} 秒 · 只查一次，沒有加入追蹤`),
          h('p', { class: 'msg' }, r.message),
          rows.length ? h('table', null, h('tbody', null, rows)) : null,
        );
      }
    } catch (err) {
      if (err instanceof BadKey || err instanceof BotOffline) handleError(err);
      else showResult(h('p', { class: 'bad' }, err.message));
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  async function untrack(vsl, mft) {
    if (!confirm(`停止追蹤 通關 ${vsl} · 艙號 ${mft}？`)) return;
    try {
      await api('/api/untrack', { method: 'POST', body: { vsl, mft } });
    } catch (err) {
      handleError(err);
    }
    refresh();
  }

  async function loadLogs() {
    try {
      const r = await api('/api/logs?lines=200');
      const pre = $('log');
      pre.textContent = r.lines.join('\n') || '（還沒有紀錄）';
      pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      $('log').textContent = `讀不到紀錄：${err.message}`;
    }
  }

  $('track-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitQuery(e.submitter?.dataset.action || 'track');
  });
  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    store.set(KEY_STORE, $('key-input').value.trim());
    $('key-input').value = '';
    refresh();
  });
  $('bot-refresh').addEventListener('click', refresh);
  $('log-box').addEventListener('toggle', () => $('log-box').open && loadLogs());
  $('logout').addEventListener('click', () => {
    store.set(KEY_STORE, null);
    showKeyForm();
  });
  $('webhook-sync').addEventListener('click', async () => {
    $('webhook-sync').disabled = true;
    try {
      const r = await api('/api/webhook/sync', { method: 'POST', timeout: 30_000 });
      showNotice(r.ok ? 'warn' : 'error', r.ok ? 'LINE webhook 已重新設定並測試成功' : 'LINE webhook 設定失敗',
        h('p', null, r.webhook?.message || r.webhook?.endpoint || ''));
      refresh();
    } catch (err) {
      handleError(err);
    } finally {
      $('webhook-sync').disabled = false;
    }
  });

  // 只在看「通關查詢」分頁、而且頁面在前景時定期更新
  let timer = null;
  function activate() {
    refresh();
    clearInterval(timer);
    timer = setInterval(() => document.visibilityState === 'visible' && refresh(), STATUS_INTERVAL_MS);
  }
  function deactivate() {
    clearInterval(timer);
    timer = null;
  }

  showView(readHash() || store.get(TAB_STORE) || 'cards');
})();
