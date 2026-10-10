(() => {
  'use strict';

  const DEFAULT_KEYWORDS = ['7-11 商品卡', '統一超商 商品卡', '7-ELEVEN 商品卡', '711 禮物卡', '統一超商 禮券'];
  const STALE_MS = 3 * 60 * 60 * 1000;
  const AUTO_RELOAD_MS = 10 * 60 * 1000;
  const SEEN_KEY = 'seen-deal-ids';
  const BASE_TITLE = document.title;

  const $ = (id) => document.getElementById(id);

  const UA = navigator.userAgent;
  const IS_ANDROID = /Android/i.test(UA);
  const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IN_LINE = /\bLine\//i.test(UA);
  const IN_APP_BROWSER = IN_LINE || /FBAN|FBAV|Instagram|MicroMessenger/i.test(UA);

  // 手機上點商品直接開蝦皮 App：
  // Android 用 intent:// 指定蝦皮 App（沒裝 App 時回到網頁版）；iPhone 的蝦皮網址本身就會開 App（Universal Link）
  function shopeeLink(url) {
    if (!IS_ANDROID) return { href: url, target: '_blank', rel: 'noopener noreferrer' };
    const u = new URL(url);
    return {
      href: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.shopee.tw;` +
        `S.browser_fallback_url=${encodeURIComponent(url)};end`,
    };
  }

  let data = null;
  let lastLoadedAt = 0;
  let newIds = new Set();
  // 上次造訪時看過的特價；只在開頁時讀一次，按重新整理才不會把「新」標記洗掉
  const seenAtStart = readSeen();

  function readSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      return raw ? new Set(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function writeSeen(ids) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch {
      /* 無痕模式等情況存不了，略過 */
    }
  }

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

  const money = (n) => `$${Math.round(n).toLocaleString('zh-TW')}`;

  function formatTime(iso) {
    return new Date(iso).toLocaleString('zh-TW', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function timeAgo(iso) {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return `${min} 分鐘前`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr} 小時前`;
    return `${Math.floor(hr / 24)} 天前`;
  }

  function showNotice(kind, title, ...body) {
    const box = $('notice');
    box.className = `notice${kind === 'error' ? ' error' : ''}`;
    box.replaceChildren(h('strong', null, title), ...body.filter(Boolean));
    box.hidden = false;
  }

  function renderNotice() {
    $('notice').hidden = true;
    const dataTime = data.dataUpdatedAt || data.updatedAt;

    if (data.status === 'error') {
      showNotice(
        'error',
        '最近一次自動查詢失敗',
        h('p', null, data.message || '未知錯誤'),
        dataTime && data.items.length ? h('p', null, `下面顯示的是 ${formatTime(dataTime)} 的資料。`) : null,
      );
    } else if (dataTime && Date.now() - new Date(dataTime).getTime() > STALE_MS) {
      showNotice(
        'warn',
        `資料已經 ${timeAgo(dataTime)}沒有更新`,
        h('p', null, '負責查詢的電腦可能沒開機，或排程停止了。可以先用下方「直接到蝦皮搜尋」手動查看。'),
      );
    } else if (data.ai?.message) {
      showNotice('warn', '這次沒有用到本機 AI', h('p', null, `${data.ai.message}。面額只用規則判斷，可能有些商品沒判斷出來。`));
    }
  }

  function sortItems(items, mode) {
    const list = [...items];
    if (mode === 'price') list.sort((a, b) => a.price - b.price);
    else if (mode === 'sales') list.sort((a, b) => b.sales - a.sales);
    // 可疑的特價排到後面，不要擋在真正划算的前面
    else list.sort((a, b) => !!a.warn - !!b.warn || (a.ratio ?? Infinity) - (b.ratio ?? Infinity) || a.price - b.price);
    return list;
  }

  function renderItem(it) {
    const meta = [it.official ? `官方｜${it.shop}` : it.shop, it.sales ?`已售 ${it.sales.toLocaleString('zh-TW')}` : '', it.rating ? `★${it.rating.toFixed(1)}` : '']
      .filter(Boolean)
      .join(' · ');
    const priceText = it.priceMax > it.price ? `${money(it.price)} – ${money(it.priceMax)}` : money(it.price);
    const img = /^https:\/\//.test(it.image)
      ? h('img', { class: 'thumb', src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'thumb' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'thumb' })), { once: true });
    const trusted = it.deal && !it.warn;

    return h('li', { class: `item${it.deal ? ' deal' : ''}` },
      h('a', shopeeLink(it.url),
        img,
        h('div', { class: 'body' },
          h('p', { class: 'title' }, it.title),
          meta ? h('p', { class: 'meta' }, meta) : null,
          h('div', { class: 'price-row' },
            h('span', { class: 'price' }, priceText),
            it.faceLabel ? h('span', { class: 'face' }, `面額 ${it.faceLabel}`) : null,
            it.zhe ? h('span', { class: `badge${trusted ? ' good' : ''}` }, it.zhe) : null,
            trusted && it.saving > 0 ? h('span', { class: 'badge good' }, `省 ${money(it.saving)}`) : null,
            it.shopeeDiscount > 0 ? h('span', { class: 'badge' }, `蝦皮 -${it.shopeeDiscount}%`) : null,
            newIds.has(it.id) ? h('span', { class: 'badge new' }, '新') : null),
          it.note ? h('p', { class: 'note' }, it.note) : null,
          it.warn ? h('p', { class: 'warn' }, `⚠ ${it.warn}`) : null)));
  }

  function renderLists() {
    const q = $('q').value.trim().toLowerCase();
    const mode = $('sort').value;
    const items = sortItems(data.items.filter((i) => !q || i.title.toLowerCase().includes(q)), mode);
    const deals = items.filter((i) => i.deal);
    const others = items.filter((i) => !i.deal);

    $('deals').replaceChildren(...deals.map(renderItem));
    $('deals-empty').hidden = deals.length > 0;
    $('deals-empty').textContent = q
      ? `沒有符合「${q}」的特價商品卡。`
      : '目前沒有低於面額的 7-11 商品卡，晚點再來看看。';
    $('others').replaceChildren(...others.map(renderItem));
    $('others-count').textContent = others.length;
    $('others-section').hidden = others.length === 0;
  }

  function render() {
    const dataTime = data.dataUpdatedAt || data.updatedAt;
    $('updated').textContent = dataTime
      ? `資料時間 ${formatTime(dataTime)}（${timeAgo(dataTime)}）`
      : '尚未開始自動查詢';

    renderNotice();

    const hasItems = data.items.length > 0;
    $('stats').hidden = !hasItems;
    $('controls').hidden = !hasItems;
    $('deals-section').hidden = !hasItems && data.status !== 'ok';

    // 統計只算可信的特價，折扣離譜的不算
    const deals = data.items.filter((i) => i.deal && !i.warn);
    const best = deals.reduce((m, i) => (m && m.ratio <= i.ratio ? m : i), null);
    $('stat-deals').textContent = deals.length;
    $('stat-best').textContent = best ? best.zhe : '–';
    $('stat-total').textContent = data.items.length;
    document.title = deals.length ? `(${deals.length}) ${BASE_TITLE}` : BASE_TITLE;
    $('ai-info').textContent = data.ai?.model && !data.ai.message
      ? `面額先用規則判斷，判斷不出來的交給本機 AI（${data.ai.model}）。`
      : '';

    renderLists();
  }

  function renderQuick() {
    const keywords = data?.keywords?.length ? data.keywords : DEFAULT_KEYWORDS;
    $('quick').replaceChildren(...keywords.map((k) => h('a', {
      class: 'chip',
      ...shopeeLink(`https://shopee.tw/search?keyword=${encodeURIComponent(k)}&order=asc&sortBy=price`),
    }, k)));
  }

  // LINE、Facebook 等 App 內建的瀏覽器不會把蝦皮連結交給蝦皮 App，提示改用手機的瀏覽器
  function renderAppTip() {
    if (IN_APP_BROWSER) {
      const external = new URL(location.href);
      external.searchParams.set('openExternalBrowser', '1'); // LINE 看到這個參數會改用外部瀏覽器開
      $('app-tip').replaceChildren(
        h('strong', null, '在 App 內建的瀏覽器裡，點商品不會跳到蝦皮 App'),
        IN_LINE
          ? h('p', null, h('a', { href: external.href }, '改用手機的瀏覽器開啟這個網頁'))
          : h('p', null, '請點右上角的選單，選「用瀏覽器開啟」。'));
      $('app-tip').hidden = false;
    } else if (IS_IOS) {
      $('ios-tip').hidden = false;
    }
  }

  async function load() {
    const btn = $('refresh');
    btn.disabled = true;
    btn.textContent = '讀取中…';
    try {
      const res = await fetch(`data/deals.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      data.items = Array.isArray(data.items) ? data.items : [];
      lastLoadedAt = Date.now();

      const dealIds = data.items.filter((i) => i.deal).map((i) => i.id);
      newIds = seenAtStart ? new Set(dealIds.filter((id) => !seenAtStart.has(id))) : new Set();
      if (data.status !== 'not_configured') writeSeen(dealIds);

      render();
    } catch (err) {
      $('updated').textContent = '讀取失敗';
      showNotice('error', '讀不到特價資料', h('p', null,
        `data/deals.json 載入失敗（${err.message}）。還沒查詢過的話，請先在電腦上執行 npm run update；如果是直接雙擊打開 index.html，請改用 npm run serve 或 GitHub Pages 的網址開啟。`));
    } finally {
      btn.disabled = false;
      btn.textContent = '重新整理';
      renderQuick();
    }
  }

  $('refresh').addEventListener('click', load);
  $('q').addEventListener('input', () => data && renderLists());
  $('sort').addEventListener('change', () => data && renderLists());
  // 手機上分頁常常一直開著，切回來時資料太舊就自動重抓
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadedAt > AUTO_RELOAD_MS) load();
  });

  renderAppTip();
  load();
})();
