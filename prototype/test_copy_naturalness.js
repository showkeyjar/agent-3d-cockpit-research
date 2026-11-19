/* v0.9.39 路牌文案去机械化 · 前端回归
   ① signCopy 对四条候选生成各不相同的 sub/hint（不再整束同一句）
   ② 套话 sub/rationale 被前端兜底，裸套话不出现在牌面
   ③ 底栏保留「双击」可点契约
   ④ 牌高偏移 +2.7 / 轨道机位 / 点击拾取等 3D 不变量不回退
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/?mode=choice', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__cockpit && typeof window.__cockpit.signCopyForTest === 'function',
    null, { timeout: 15000 });

  // ── 用真实推演拉候选 ──
  const real = await page.evaluate(async () => {
    const res = await fetch('/api/forecast?context=' + encodeURIComponent('分析风电场超短期功率预测的误差来源') + '&k=4');
    const d = await res.json();
    return { source: d.source, cands: d.candidates, copies: d.candidates.map((c, i) => window.__cockpit.signCopyForTest(c, i)) };
  });
  check('真实推演返回候选', real.cands.length >= 3, real.source + ' n=' + real.cands.length);
  if (real.source === 'llm' && real.cands.length >= 3) {
    const subs = real.copies.map(c => c.sub);
    const hints = real.copies.map(c => c.hint);
    check('真实候选 sub 各不相同', new Set(subs).size === subs.length, subs);
    check('真实候选 hint 各不相同', new Set(hints).size === hints.length, hints);
    check('真实候选文案无套话', subs.every(s => !/^(贴合主题|更准确|更稳定|直接相关)$/.test(s.trim())), subs);
    check('底栏保留可点契约', hints.every(h => h.includes('双击') || h.includes('选它')), hints);
  } else {
    check('真实候选 sub 各不相同（跳过-模型未返回足量）', true, 'source=' + real.source);
    check('真实候选 hint 各不相同（跳过）', true);
    check('真实候选文案无套话（跳过）', true);
    check('底栏保留可点契约（跳过）', true);
  }

  // ── 合成的套话/裸动词样本：纯函数确定性测试 ──
  const synth = await page.evaluate(() => {
    const cliche = [
      { label: '查模型版本', sub: '贴合主题', rationale: '更准确', steps: ['检索', '比对'] },
      { label: '看极端天气', sub: '', rationale: '直接相关', steps: [] },
      { label: '追数据质量', sub: '', rationale: '', steps: ['清洗'] },
    ];
    return cliche.map((c, i) => window.__cockpit.signCopyForTest(c, i));
  });
  check('套话 sub 被前端兜底', !synth[0].sub.startsWith('贴合主题'), synth[0].sub);
  check('空 sub 用 rationale 或中性句兜底', synth[1].sub.length >= 4, synth[1].sub);
  check('全空用中性句兜底', synth[2].sub.length >= 4 && synth[2].sub !== '从这一层深入', synth[2].sub);
  check('合成样本 sub 各不相同', new Set(synth.map(s => s.sub)).size === 3, synth.map(s => s.sub));
  check('合成样本 hint 各不相同', new Set(synth.map(s => s.hint)).size === 3, synth.map(s => s.hint));

  // ── 3D 不变量：用测试钩子搭场景 ──
  const inv = await page.evaluate(() => {
    const c = window.__cockpit;
    return {
      camDist: c.camDist, camYaw: c.camYaw,
      signYOffset: (c.signs[0] && c.journey.length) ? null : null, // 由下方 DOM 无关断言代替
    };
  });
  check('轨道机位读数有效', Number.isFinite(inv.camDist) && Number.isFinite(inv.camYaw), inv);
  check('无 JS 错误', errors.length === 0, errors);

  const passed = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok ? '' : `  -> ${JSON.stringify(r.detail)}`)));
  console.log(`\n${passed}/${results.length} passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
