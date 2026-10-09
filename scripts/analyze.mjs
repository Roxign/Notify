// 從蝦皮商品標題判斷是不是 7-11 商品卡、面額多少，並和售價比較算出折數。

const BRAND = /(?<!\d)7\s*[-_.]?\s*11(?!\d)|7\s*-?\s*eleven|seven\s*-?\s*eleven|統一超商|小七/i;
const CARD = /商品卡|禮物卡|禮品卡|禮卡|禮券|商品券|提貨券|兌換券|電子券/;
const EXCLUDE = /卡套|卡夾|卡包|卡冊|收納|貼紙|手機殼|鑰匙圈|吊飾|公仔|模型|集點|icash|悠遊卡|一卡通|空卡/i;

// 「滿1000」「折100」「送50元」這類促銷字樣不是面額，先拿掉
const PROMO = /(?:滿|現折|折抵|折價|折|送|贈|回饋|抵用|抵)\s*(?:NT\$?|\$)?\s*\d+\s*(?:元|圓)?/gi;

const AMOUNT_PATTERNS = [
  /(?:NT\$?|\$)\s*(\d{2,5})(?!\d)/gi,
  /(?<![\d.])(\d{2,5})\s*(?:元|圓|塊)/g,
  /面額\s*[:：]?\s*(\d{2,5})(?!\d)/g,
];

// 「100/500/1000元」這種一次列好幾個面額的寫法
const AMOUNT_LIST = /((?:\d{2,5}\s*[/、|]\s*)+\d{2,5})\s*(?:元|圓)/g;

const QTY_PATTERNS = [
  /(?<=[\d元圓\s])[x×*]\s*(\d{1,2})(?!\d)/gi,
  /(?<!\d)(\d{1,2})\s*(?:張|入|份)/g,
];

// 折扣大到這種程度，多半是詐騙或標題判斷錯誤
const SUSPICIOUS_RATIO = 0.7;

function normalize(title) {
  return String(title || '')
    .normalize('NFKC')
    .replace(/[‐‑‒–—―－]/g, '-')
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
}

function matchAll(text, patterns) {
  const values = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) values.push(Number(m[1]));
  }
  return values;
}

export function isRelevant(title) {
  const t = normalize(title);
  return BRAND.test(t) && CARD.test(t) && !EXCLUDE.test(t);
}

export function parseFaceValues(title) {
  const t = normalize(title).replace(PROMO, ' ');
  const listed = [...t.matchAll(AMOUNT_LIST)].flatMap((m) => m[1].match(/\d+/g).map(Number));
  const faces = [...new Set([...matchAll(t, AMOUNT_PATTERNS), ...listed])]
    .filter((v) => v >= 50 && v <= 20000 && v % 50 === 0)
    .sort((a, b) => a - b);
  const qtys = [...new Set(matchAll(t, QTY_PATTERNS))].filter((q) => q >= 1 && q <= 50);
  // 數量寫法互相矛盾時當作不知道
  const qty = qtys.length === 0 ? 1 : qtys.length === 1 ? qtys[0] : null;
  return { faces, qty };
}

// 0.95 → "95折"、0.9 → "9折"、0.925 → "92.5折"、1 → "原價"
export function formatZhe(ratio) {
  if (ratio >= 1.005) return `比面額貴 ${Math.round((ratio - 1) * 100)}%`;
  if (ratio >= 0.995) return '原價';
  const pct = Math.round(ratio * 1000) / 10;
  return pct % 10 === 0 ? `${pct / 10}折` : `${pct}折`;
}

export function analyzeItem({ title, priceMin, priceMax }) {
  const lo = Number(priceMin);
  const hi = Number(priceMax) || lo;
  const { faces, qty } = parseFaceValues(title);
  const result = { face: null, faceLabel: '', ratio: null, deal: false, note: '', warn: '' };

  if (!lo || faces.length === 0 || qty === null) {
    result.note = '標題看不出面額';
    return result;
  }

  if (faces.length === 1) {
    const face = faces[0] * qty;
    const ratio = lo / face;
    // 多規格商品的最低價可能是別的面額，折扣大得離譜就不採信
    if (lo !== hi && ratio < SUSPICIOUS_RATIO) {
      result.note = '多規格商品，無法判斷面額';
      return result;
    }
    result.face = face;
    result.faceLabel = qty > 1 ? `$${faces[0]} × ${qty}` : `$${faces[0]}`;
    result.ratio = ratio;
    if (lo !== hi) result.note = '多規格商品，以最低價計算';
  } else {
    // 標題列了好幾種面額（例如 100/500/1000 元）：最低價對最小面額、最高價對最大面額，取較保守的那個
    if (lo === hi || qty !== 1) {
      result.note = '多種面額，無法判斷';
      return result;
    }
    const ratio = Math.max(lo / faces[0], hi / faces[faces.length - 1]);
    if (ratio < SUSPICIOUS_RATIO) {
      result.note = '多種面額，無法判斷';
      return result;
    }
    result.faceLabel = faces.map((f) => `$${f}`).join(' / ');
    result.ratio = ratio;
    result.note = '多種面額，折數為推估值';
  }

  result.ratio = Math.round(result.ratio * 10000) / 10000;
  result.deal = result.ratio < 0.995;
  if (result.ratio < SUSPICIOUS_RATIO) {
    result.warn = '折扣異常大，可能是詐騙或面額判斷錯誤，購買前請仔細確認賣家';
  }
  return result;
}
