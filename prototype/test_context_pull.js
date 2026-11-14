const { resolveChromePath } = require('./chrome_helper');
// v0.9.25 回归：风景→上下文闭环。验证用户在空间里「纳入」的关联能改变下一轮路牌，
// 且全程守住 P1–P4 不变量：不新增完成信号、不伪造、不碰相机/路牌几何/中断态、
// ?mode=opaque 仍隐藏信息层。走真实 8770 fast=1 链路（不占 35B 单槽）。
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const TOPIC = '分析风电功率预测误差';   // 主主题（含领域名词权重）
const TAG = '限电事件';                  // 用户从风景里主动纳入的关联（不在主主题里）

async function explore(page, question, tag){
  await page.evaluate(q => window.__cockpit.setContext(q), question);
  if (tag) await page.evaluate(t => window.__cockpit.addContextTag(t, '语义风景·第1轮'), tag);
  await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '', []));
  await page.waitForFunction(() => window.__cockpit.kbFutures.length >= 3, { timeout: 15000 });
  return page.evaluate(() => ({
    labels: window.__cockpit.kbFutures.map(x => x.label),
    badge: window.__cockpit.proofBadge,
    offRail: window.__cockpit.camOffRail,
    tagCount: window.__cockpit.contextTagCount,
  }));
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  console.log('\n[A] 主动纳入：标签条出现 + 上下文注入');
  await page.evaluate(q => window.__cockpit.setContext(q), TOPIC);
  await page.evaluate(t => window.__cockpit.addContextTag(t, '语义风景·第1轮'), TAG);
  const afterAdd = await page.evaluate(() => ({
    count: window.__cockpit.contextTagCount,
    hasChip: !!document.querySelector('#contextTags.show .ctag'),
    chipText: (document.querySelector('#contextTags .ctag') || {}).textContent || '',
    ctx: window.__cockpit.exploreContextText('', []),
  }));
  ok('contextTagCount = 1', afterAdd.count === 1, afterAdd.count);
  ok('标签条出现且含短语', afterAdd.hasChip && afterAdd.chipText.includes(TAG), afterAdd.chipText);
  ok('探索上下文已注入该关联', afterAdd.ctx.includes('(' + TAG + ')'), afterAdd.ctx.slice(0, 120));

  console.log('\n[B] 真实 API：fast=1 候选因注入关联而含该短语');
  const api = await (async () => {
    const ctx = await page.evaluate(() => window.__cockpit.exploreContextText('', []));
    const url = 'http://127.0.0.1:8770/api/forecast?context=' + encodeURIComponent(ctx) + '&k=5&fast=1';
    const r = await fetch(url);
    const d = await r.json();
    return { labels: (d.candidates || []).map(c => c.label), source: d.source };
  })();
  ok('API 返回 source=local（诚实标注）', api.source === 'local', api.source);
  ok('API 候选含注入的关联「' + TAG + '」', api.labels.some(l => l.includes(TAG)), api.labels);

  console.log('\n[C] 实景闭环（对照：无标签 vs 有标签）');
  await page.evaluate(() => window.__cockpit.clearContextTags());   // 复位到「未纳入」的干净态
  const neg = await explore(page, TOPIC, null);       // 不含标签
  ok('无标签时路牌不含「' + TAG + '」', !neg.labels.some(l => l.includes(TAG)), neg.labels);
  const pos = await explore(page, TOPIC, TAG);        // 纳入标签
  ok('纳入后路牌出现「' + TAG + '」', pos.labels.some(l => l.includes(TAG)), pos.labels);
  ok('凭证仍标本地（未冒充模型）', /本地|local|未参与/i.test(pos.badge), pos.badge);
  ok('3D 不变量：camOffRail≈0', pos.offRail < 0.05, pos.offRail);

  console.log('\n[D] 幂等 / 移除');
  await page.evaluate(t => window.__cockpit.addContextTag(t, '语义风景·第1轮'), TAG);
  const dup = await page.evaluate(() => window.__cockpit.contextTagCount);
  ok('重复纳入幂等（count 仍=1）', dup === 1, dup);
  await page.evaluate(t => window.__cockpit.removeContextTag(t), TAG);
  const removed = await page.evaluate(() => ({
    count: window.__cockpit.contextTagCount,
    hidden: !document.querySelector('#contextTags.show'),
  }));
  ok('移除后 count=0', removed.count === 0, removed.count);
  ok('移除后标签条隐藏', removed.hidden);

  console.log('\n[E] ?mode=opaque 隐藏信息层');
  const p2 = await browser.newPage();
  await p2.goto('http://127.0.0.1:8770/?mode=opaque', { waitUntil: 'load' });
  await p2.waitForTimeout(1000);
  await p2.evaluate(t => window.__cockpit.addContextTag(t, '语义风景'), TAG);
  await p2.waitForTimeout(200);
  const opaque = await p2.evaluate(() => {
    const el = document.getElementById('contextTags');
    return { display: getComputedStyle(el).display, count: window.__cockpit.contextTagCount };
  });
  ok('opaque 下 #contextTags 仍隐藏（display=none）', opaque.display === 'none', opaque);
  await p2.close();

  console.log('\n[F] 全程 0 个 JS 错误');
  ok('无 JS 运行时错误', errors.length === 0, errors.slice(0, 4));

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
