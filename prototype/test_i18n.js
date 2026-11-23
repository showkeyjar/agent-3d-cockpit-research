/* test_i18n.js — FI-08（v0.9.52）界面 i18n 核心界面层回归
 *
 * 验证：默认中文零改动；?lang=en 切英文（HUD/按钮/凭据/状态词）；?lang=zh 与无参数一致；
 *   缺 key / 未命中动态文案零回退；路牌与产物内容不被 UI 字典翻译；默认中文模式测试全兼容。
 * 纯前端静态检查，不占模型槽。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const BASE = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errors = [];

  // ── A. 默认中文：零改动 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpitLang, null, { timeout: 20000 });
    const s = await page.evaluate(() => ({
      lang: window.__cockpitLang,
      nav: document.querySelector('#headbar b').textContent.trim(),
      timeline: document.getElementById('timelineBtn').textContent.trim(),
      think: document.getElementById('thinkText').textContent.trim(),
    }));
    check('A1 默认语言为中文', s.lang === 'zh', JSON.stringify(s.lang));
    check('A2 HUD 标题仍中文', s.nav.includes('语义空间导航'), s.nav);
    check('A3 按钮仍中文', s.timeline.includes('时间线'), s.timeline);
    check('A4 状态词仍中文', s.think.includes('思考中'), s.think);
    await page.close();
  }

  // ── B. ?lang=en：核心界面层切英文 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '?lang=en&test=1', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpitLang, null, { timeout: 20000 });
    await sleep(150);
    const s = await page.evaluate(() => ({
      lang: window.__cockpitLang,
      nav: document.querySelector('#headbar b').textContent.trim(),
      timeline: document.getElementById('timelineBtn').textContent.trim(),
      model: document.getElementById('modelBtn').textContent.trim(),
      think: document.getElementById('thinkText').textContent.trim(),
      save: document.getElementById('mpSave').textContent.trim(),
      apiHint: document.getElementById('mpApiKey').getAttribute('placeholder'),
      tNav: window.t('navTitle'),
      tMissing: window.t('__not_a_key__'),
      Lknown: window.L('模型推演'),
      Lunknown: window.L('这句不在字典里'),
    }));
    check('B1 ?lang=en 生效', s.lang === 'en', JSON.stringify(s.lang));
    check('B2 HUD 标题英文化', s.nav.includes('Semantic Navigation'), s.nav);
    check('B3 按钮英文化', /Timeline/.test(s.timeline) && /Model/.test(s.model), `${s.timeline} / ${s.model}`);
    check('B4 状态词英文化', /Thinking/.test(s.think), s.think);
    check('B5 模型面板按钮英文化', /Save/.test(s.save), s.save);
    check('B6 placeholder 英文化', /blank/i.test(s.apiHint || ''), s.apiHint);
    check('B7 t() 取词正确', s.tNav === 'Semantic Navigation', s.tNav);
    check('B8 缺 key 零回退（返回 key 本身，非空）', !!s.tMissing, JSON.stringify(s.tMissing));
    check('B9 L() 已知文案英文化', /Model/.test(s.Lknown), s.Lknown);
    check('B10 L() 未知文案原样返回（零回退）', s.Lunknown === '这句不在字典里', s.Lunknown);
    await page.close();
  }

  // ── C. ?lang=zh 与默认一致 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '?lang=zh', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpitLang, null, { timeout: 20000 });
    const s = await page.evaluate(() => ({
      lang: window.__cockpitLang,
      nav: document.querySelector('#headbar b').textContent.trim(),
    }));
    check('C1 ?lang=zh 保持中文', s.lang === 'zh' && s.nav.includes('语义空间导航'), JSON.stringify(s));
    await page.close();
  }

  // ── D. 凭据徽章英文切换（中文模式仍原文，保证旧测试兼容）──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '?lang=en&test=1', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpitLang, null, { timeout: 20000 });
    const en = await page.evaluate(() => ({
      llm: window.L('模型推演'),
      local: window.L('⚠ 本地兜底'),
      fast: window.L('本地预览'),
    }));
    check('D1 凭据徽章英文化', /Model/.test(en.llm) && /fallback/i.test(en.local) && /preview/i.test(en.fast), JSON.stringify(en));
    await page.close();

    const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page2.goto(BASE, { waitUntil: 'load' });
    await page2.waitForFunction(() => window.__cockpit && window.__cockpitLang, null, { timeout: 20000 });
    const zh = await page2.evaluate(() => ({ local: window.L('⚠ 本地兜底'), llm: window.L('模型推演') }));
    check('D2 中文模式凭据保持原文（旧断言兼容）', zh.local === '⚠ 本地兜底' && zh.llm === '模型推演', JSON.stringify(zh));
    await page2.close();
  }

  // ── E. i18n 不碰 3D / 账本 / 执行 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '?lang=en&test=1', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, null, { timeout: 20000 });
    const s = await page.evaluate(() => ({
      has3D: !!(window.__cockpit.THREE && window.__cockpit.camera),
      hasLedger: Array.isArray(window.__cockpit.runs || window.__cockpit.candidates),
      hasExec: !!window.__cockpit.execState,
    }));
    check('E1 3D / 账本 / 执行钩子仍在（i18n 纯呈现层）',
      s.has3D && s.hasLedger && s.hasExec, JSON.stringify(s));
    await page.close();
  }

  check('F 全程 0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`\n=== test_i18n: ${pass} PASS / ${fail} FAIL ===`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
