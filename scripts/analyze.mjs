// 從蝦皮商品標題判斷是不是 7-11 商品卡、面額多少，並和售價比較算出折數。

const BRAND = /(?<!\d)7\s*[-_.]?\s*11(?!\d)|7\s*-?\s*eleven|seven\s*-?\s*eleven|統一超商|小七/i;
const CARD = /商品卡|禮物卡|禮品卡|禮卡|禮券|商品券|提貨券|兌換券|電子券/;
const EXCLUDE = /卡套|卡夾|卡包|卡冊|收納|貼紙|手機殼|鑰匙圈|吊飾|公仔|模型|集點|icash|悠遊卡|一卡通|空卡|無餘額|餘額卡|供收藏/i;

// 「滿1000」「折100」「送50元」「運費60」這類字樣不是面額，先拿掉
const PROMO = /(?:滿|現折|折抵|折價|折|送|贈|回饋|抵用|抵|運費)\s*(?:NT\$?|\$)?\s*\d+\s*(?:元|圓)?/gi;

const AMOUNT_PATTERNS = [
  /(?:NT\$?|\$)\s*(\d{2,5})(?!\d)/gi,
  /(?<![\d.])(\d{2,5})\s*(?:元|圓|塊)/g,
  /面額\s*[:：]?\s*(\d{2,5})(?!\d)/g,
];

// 「100/500/1000元」「面額35/50」這種一次列好幾個面額的寫法
const AMOUNT_LISTS = [
  /((?:\d{2,5}\s*[/、|]\s*)+\d{2,5})\s*(?:元|圓)/g,
  /面額\s*[:：]?\s*((?:\d{2,5}\s*[/、,，|]\s*)+\d{2,5})(?!\d)/g,
];

const QTY_PATTERNS = [
  /(?<=[\d元圓\s])[x×*]\s*(\d{1,2})(?!\d)/gi,
  /(?<!面額\s*)(?<!\d)(\d{1,2})\s*(?:張|入|份)/g, // 「面額50張」的 50 是面額不是張數
];

// 折扣大到這種程度，多半是詐騙或標題判斷錯誤
const SUSPICIOUS_RATIO = 0.7;

const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 貳: 2, 兩: 2, 三: 3, 參: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const ZH_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 萬: 10000 };

// 「伍佰元」「一千元」「五百」→ 阿拉伯數字（只轉後面接 元/圓/面額 的，避免把「一張」之類也轉掉）
function zhAmountsToDigits(text) {
  const chars = Object.keys(ZH_DIGITS).join('') + Object.keys(ZH_UNITS).join('');
  return text.replace(new RegExp(`([${chars}]{2,})(?=\\s*(?:元|圓|塊))`, 'g'), (m) => {
    let total = 0;
    let digit = 0;
    for (const ch of m) {
      if (ch in ZH_DIGITS) digit = ZH_DIGITS[ch];
      else {
        total += (digit || 1) * ZH_UNITS[ch];
        digit = 0;
      }
    }
    return String(total + digit);
  });
}

function normalize(title) {
  return zhAmountsToDigits(
    String(title || '')
      .normalize('NFKC')
      .replace(/[‐‑‒–—―－]/g, '-')
      .replace(/(\d),(\d{3})(?!\d)/g, '$1$2'),
  );
}

function matchAll(text, patterns) {
  const values = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) values.push(Number(m[1]));
  }
  return values;
}

export function hasBrand(title) {
  return BRAND.test(normalize(title));
}

// 空卡、卡套這類明確的排除字樣，不管 AI 怎麼判斷都排除
export function isExcluded(title) {
  return EXCLUDE.test(normalize(title));
}

export function isRelevant(title) {
  const t = normalize(title);
  return BRAND.test(t) && CARD.test(t) && !EXCLUDE.test(t);
}

// 7-11 商品卡有 35 元這種小面額，所以只要求是 5 的倍數
export const isPlausibleFace = (v) => Number.isInteger(v) && v >= 30 && v <= 20000 && v % 5 === 0;

function facesIn(text) {
  const t = normalize(text).replace(PROMO, ' ');
  const listed = AMOUNT_LISTS.flatMap((re) => [...t.matchAll(re)].flatMap((m) => m[1].match(/\d+/g).map(Number)));
  return [...matchAll(t, AMOUNT_PATTERNS), ...listed];
}

// 標題和規格選項（例如「100元」「$500」或單純的「1000」）裡的面額都算
export function parseFaceValues(title, variations = []) {
  const found = facesIn(title);
  for (const opt of variations) {
    const bare = normalize(opt).match(/^\s*\$?\s*(\d{2,5})\s*$/);
    found.push(...(bare ? [Number(bare[1])] : facesIn(opt)));
  }
  const faces = [...new Set(found)].filter(isPlausibleFace).sort((a, b) => a - b);
  const qtys = [...new Set(matchAll(normalize(title), QTY_PATTERNS))].filter((q) => q >= 1 && q <= 50);
  // 數量寫法互相矛盾時當作不知道
  const qty = qtys.length === 0 ? 1 : qtys.length === 1 ? qtys[0] : null;
  return { faces, qty };
}

// 檢查 AI 給的面額真的有出現在標題或規格裡，避免它自己編數字
export function faceAppearsIn(face, title, variations = []) {
  const text = normalize([title, ...variations].join(' '));
  return new RegExp(`(?<!\\d)${face}(?!\\d)`).test(text);
}

// 0.95 → "95折"、0.9 → "9折"、0.925 → "92.5折"、1 → "原價"
export function formatZhe(ratio) {
  if (ratio >= 1.005) return `比面額貴 ${Math.round((ratio - 1) * 100)}%`;
  if (ratio >= 0.995) return '原價';
  const pct = Math.round(ratio * 1000) / 10;
  return pct % 10 === 0 ? `${pct / 10}折` : `${pct}折`;
}

// parsed：外部（例如本機 AI）已經判斷好的 { faces, qty }；沒給就用規則從標題判斷
export function analyzeItem({ title, priceMin, priceMax, variations = [], parsed }) {
  const lo = Number(priceMin);
  const hi = Number(priceMax) || lo;
  const { faces, qty } = parsed ?? parseFaceValues(title, variations);
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
    // 最高價遠低於最大面額，表示那個面額其實沒在賣（例如 $30~47 卻寫了 100 元），不拿來比
    const sold = [...faces];
    while (sold.length > 1 && hi / sold[sold.length - 1] < SUSPICIOUS_RATIO) sold.pop();
    const ratio = Math.max(lo / sold[0], hi / sold[sold.length - 1]);
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
  } else if (faces.length > 1 && result.ratio < 0.85) {
    result.warn = '多種面額的折數是推估的，不一定準，請點進去確認各規格的價格';
  }
  return result;
}
