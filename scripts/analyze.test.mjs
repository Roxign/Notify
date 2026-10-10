import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRelevant, parseFaceValues, analyzeItem, formatZhe, faceAppearsIn } from './analyze.mjs';

test('isRelevant：認得各種 7-11 商品卡寫法', () => {
  assert.ok(isRelevant('【7-11】統一超商 商品卡 500元'));
  assert.ok(isRelevant('７－１１ 數位商品卡 $1,000'));
  assert.ok(isRelevant('7-ELEVEN 禮物卡 面額300'));
  assert.ok(isRelevant('711 電子禮券 100元 現貨'));
  assert.ok(isRelevant('小七 商品券 200元'));
});

test('isRelevant：排除周邊與其他卡', () => {
  assert.ok(!isRelevant('7-11 商品卡 卡套 收納夾'));
  assert.ok(!isRelevant('7-11 icash2.0 限量卡'));
  assert.ok(!isRelevant('全家 商品卡 500元'));
  assert.ok(!isRelevant('2017-11 出版 禮物卡 收藏')); // 日期裡的 7-11
});

test('parseFaceValues：面額與數量', () => {
  assert.deepEqual(parseFaceValues('7-11 商品卡 500元'), { faces: [500], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11商品卡 $1,000 x2'), { faces: [1000], qty: 2 });
  assert.deepEqual(parseFaceValues('統一超商商品卡 100元 10張'), { faces: [100], qty: 10 });
  assert.deepEqual(parseFaceValues('７－１１商品卡 面額：３００'), { faces: [300], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 100/500/1000元'), { faces: [100, 500, 1000], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 $100 $500 $1000'), { faces: [100, 500, 1000], qty: 1 });
});

test('parseFaceValues：真實標題的寫法', () => {
  assert.deepEqual(parseFaceValues('7-11商品卡 面額50、 35  使用無期限'), { faces: [35, 50], qty: 1 });
  assert.deepEqual(parseFaceValues('湊免運 7-11商品卡 面額35/50 -'), { faces: [35, 50], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 50元', ['35元', '50元']), { faces: [35, 50], qty: 1 });
  assert.deepEqual(parseFaceValues('湊免運 7-11商品卡 35元 50元 / 單張'), { faces: [35, 50], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 面額50張 無使用期限 商品卡'), { faces: [50], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 500元 運費60元'), { faces: [500], qty: 1 });
});

test('isRelevant：排除已用完的空卡', () => {
  assert.ok(!isRelevant('7-11 統一超商 50元 商品卡 餘額卡 已使用無餘額供收藏'));
});

test('parseFaceValues：促銷字樣不算面額', () => {
  assert.deepEqual(parseFaceValues('7-11 商品卡 500元 滿1000折50'), { faces: [500], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 1000元 送100元'), { faces: [1000], qty: 1 });
});

test('parseFaceValues：中文數字面額', () => {
  assert.deepEqual(parseFaceValues('統一超商 商品卡 面額伍佰元 現貨'), { faces: [500], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 禮券 一千元'), { faces: [1000], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 禮券 三百元 兩張'), { faces: [300], qty: 1 });
});

test('parseFaceValues：標題沒寫面額時看規格', () => {
  assert.deepEqual(parseFaceValues('7-11 商品卡 電子序號', ['100元', '500元', '1000']), { faces: [100, 500, 1000], qty: 1 });
  assert.deepEqual(parseFaceValues('7-11 商品卡 500元', ['1張', '2張']), { faces: [500], qty: 1 });
});

test('faceAppearsIn：AI 給的面額要真的出現在文字裡', () => {
  assert.ok(faceAppearsIn(500, '7-11 商品卡 $500'));
  assert.ok(faceAppearsIn(1000, '7-11 商品卡 $1,000'));
  assert.ok(faceAppearsIn(300, '7-11 商品卡', ['300元']));
  assert.ok(!faceAppearsIn(500, '7-11 商品卡 1500元'));
  assert.ok(!faceAppearsIn(100, '7-11 商品卡 各種面額'));
});

test('analyzeItem：使用外部判斷的面額', () => {
  const r = analyzeItem({ title: '7-11 數位禮物', priceMin: 470, priceMax: 470, parsed: { faces: [500], qty: 1 } });
  assert.equal(r.face, 500);
  assert.equal(r.ratio, 0.94);
  assert.equal(r.deal, true);
});

test('analyzeItem：低於面額', () => {
  const r = analyzeItem({ title: '7-11 商品卡 500元', priceMin: '475', priceMax: '475' });
  assert.equal(r.face, 500);
  assert.equal(r.ratio, 0.95);
  assert.equal(r.deal, true);
  assert.equal(r.warn, '');
});

test('analyzeItem：數量相乘', () => {
  const r = analyzeItem({ title: '7-11 商品卡 100元 x5', priceMin: '480', priceMax: '480' });
  assert.equal(r.face, 500);
  assert.equal(r.faceLabel, '$100 × 5');
  assert.equal(r.ratio, 0.96);
  assert.equal(r.deal, true);
});

test('analyzeItem：原價或高於面額不算特價', () => {
  assert.equal(analyzeItem({ title: '7-11 商品卡 500元', priceMin: '500', priceMax: '500' }).deal, false);
  assert.equal(analyzeItem({ title: '7-11 商品卡 500元', priceMin: '520', priceMax: '520' }).deal, false);
});

test('analyzeItem：折扣離譜時加警告', () => {
  const r = analyzeItem({ title: '7-11 商品卡 1000元', priceMin: '300', priceMax: '300' });
  assert.equal(r.deal, true);
  assert.ok(r.warn);
});

test('analyzeItem：多規格且最低價離譜時不判斷', () => {
  const r = analyzeItem({ title: '7-11 商品卡 1000元', priceMin: '95', priceMax: '950' });
  assert.equal(r.ratio, null);
  assert.equal(r.deal, false);
});

test('analyzeItem：多種面額用保守推估', () => {
  const r = analyzeItem({ title: '7-11 商品卡 $100 $500 $1000', priceMin: '95', priceMax: '960' });
  assert.equal(r.ratio, 0.96);
  assert.equal(r.deal, true);
  assert.equal(r.face, null);
  assert.equal(r.faceLabel, '$100 / $500 / $1000');
});

test('analyzeItem：沒在賣的大面額不拿來比', () => {
  const r = analyzeItem({ title: '全家/7-11超商 商品卡93折', priceMin: 30, priceMax: 47, parsed: { faces: [35, 50, 100], qty: 1 } });
  assert.equal(r.ratio, 0.94);
});

test('analyzeItem：看不出面額', () => {
  const r = analyzeItem({ title: '7-11 商品卡 各種面額 現貨', priceMin: '100', priceMax: '1000' });
  assert.equal(r.ratio, null);
  assert.equal(r.deal, false);
});

test('formatZhe', () => {
  assert.equal(formatZhe(0.95), '95折');
  assert.equal(formatZhe(0.9), '9折');
  assert.equal(formatZhe(0.925), '92.5折');
  assert.equal(formatZhe(1), '原價');
  assert.equal(formatZhe(1.04), '比面額貴 4%');
});
