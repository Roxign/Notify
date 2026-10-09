(() => {
  'use strict';

  const DEFAULT_KEYWORDS = ['7-11 商品卡', '統一超商 商品卡', '7-ELEVEN 商品卡', '711 禮物卡', '統一超商 禮券'];
  const STALE_MS = 2 * 60 * 60 * 1000;
  const AUTO_RELOAD_MS = 10 * 60 * 1000;
  const SEEN_KEY = 'seen-deal-ids';
  const BASE_TITLE = document.title;

  const $ = (id) => document.getElementById(id);

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

  function readmeUrl() {
    const { hostname, pathname } = location;
    if (!hostname.endsWith('.github.io')) return null;
    const user = hostname.slice(0, -'.github.io'.length);
    const repo = pathname.split('/').filter(Boolean)[0] || hostname;
    return `https://github.com/${user}/${repo}#readme`;
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

    if (data.status === 'not_configured') {
      const url = readmeUrl();
      showNotice(
        'warn',
        '還沒設定蝦皮 API 金鑰，所以還不能自動查詢',
        '設定好之後，這頁就會每 30 分鐘自動更新特價清單：',
        h('ol', null,
          h('li', null, '到蝦皮分潤計畫（affiliate.shopee.tw）申請 Open API，取得 AppID 和 Secret'),
          h('li', null, '在 GitHub repo 的 Settings → Secrets and variables → Actions 新增 SHOPEE_APP_ID 與 SHOPEE_APP_SECRET'),
          h('li', null, '到 Actions 頁面手動執行一次「更新特價資料並部署」')),
        url ? h('p', null, '詳細步驟請看 ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'README')) : null,
        h('p', null, '在那之前，可以先用下方「直接到蝦皮搜尋」的連結手動查看。'),
      );
    } else if (data.status === 'error') {
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
        h('p', null, 'GitHub Actions 的排程可能被暫停了（repo 60 天沒有活動會自動停用），到 Actions 頁面重新啟用即可。'),
      );
    } else if (data.message) {
      showNotice('warn', '部分關鍵字查詢失敗', h('p', null, data.message));
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
    const meta = [it.shop, it.sales ? `已售 ${it.sales.toLocaleString('zh-TW')}` : '', it.rating ? `★${it.rating.toFixed(1)}` : '']
      .filter(Boolean)
      .join(' · ');
    const priceText = it.priceMax > it.price ? `${money(it.price)} – ${money(it.priceMax)}` : money(it.price);
    const img = /^https:\/\//.test(it.image)
      ? h('img', { class: 'thumb', src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'thumb' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'thumb' })), { once: true });
    const trusted = it.deal && !it.warn;

    return h('li', { class: `item${it.deal ? ' deal' : ''}` },
      h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' },
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

    renderLists();
  }

  function renderQuick() {
    const keywords = data?.keywords?.length ? data.keywords : DEFAULT_KEYWORDS;
    $('quick').replaceChildren(...keywords.map((k) => h('a', {
      class: 'chip',
      href: `https://shopee.tw/search?keyword=${encodeURIComponent(k)}&order=asc&sortBy=price`,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, k)));
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
        `data/deals.json 載入失敗（${err.message}）。如果是直接雙擊打開 index.html，請改用本機伺服器或 GitHub Pages 的網址開啟。`));
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

  load();
})();
