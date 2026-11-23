/* v0.9.34 回归：clarify 选项式快捷回答（按任务类型给诚实回答策略，点选填入可编辑）
   1) 快捷按钮仅在 clarify 时出现；按 task_kind 分组（compose/analysis/general 文案不同）
   2) 点选只填入输入框并聚焦（不自动提交），quickSource 标记置位
   3) 点选后可编辑再提交，上下文标注为「用户答（快捷选项）」（研究数据可分辨）
   4) 手动输入（不点快捷）仍标注为「用户答」，来源不被误标
   5) 空答案不提交；非 clarify / 收起结果卡 → dock 与快捷按钮复位隐藏
   注意：_showClarify 的 idx=-1 走 runForecast 退化分支，提交后只断言上下文拼接这一确定性行为。
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/?test=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._showClarify, null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
  const dock = () => page.evaluate(() => window.__cockpit.clarifyDock);
  const ctx = () => page.evaluate(() => window.__cockpit.lastContextText);

  // 1) 初始：dock 隐藏、快捷按钮为空
  const init = await dock();
  check('初始 dock 隐藏', init && init.shown === false, init);
  check('初始无快捷按钮', init && Array.isArray(init.quickOptions) && init.quickOptions.length === 0, init && init.quickOptions);

  // 2) compose 类：快捷选项含「起草/直接给成果」语义，不索要数据
  await page.evaluate(() => window.__cockpit._showClarify('请说明团队工具栈', 'compose'));
  await page.waitForTimeout(150);
  const c = await dock();
  check('compose：3 个快捷选项', c && c.quickOptions.length === 3, c && c.quickOptions);
  check('compose：选项含起草语义（不要数据直接写）',
    c && c.quickOptions.some(t => /起草|直接给成果|不等数据/.test(t)), c && c.quickOptions);
  check('compose：快捷来源初始未置位', c && c.quickSource === false, c && c.quickSource);

  // 3) 点选：填入输入框 + 自动聚焦 + 不自动提交（上下文未变）+ 来源置位
  const ctxBeforePick = await ctx();
  await page.click('#cdQuick .cd-quick-btn:nth-of-type(1)');
  const afterPick = await page.evaluate(() => ({
    value: document.getElementById('dockAnswerInput').value,
    focused: document.activeElement === document.getElementById('dockAnswerInput'),
    ctx: window.__cockpit.lastContextText,
    dock: window.__cockpit.clarifyDock,
  }));
  check('点选：填入输入框', afterPick.value && afterPick.value.length > 0, afterPick.value);
  check('点选：输入框聚焦', afterPick.focused === true, afterPick.focused);
  check('点选：不自动提交（上下文不变）', afterPick.ctx === ctxBeforePick, { before: ctxBeforePick.slice(-50), after: afterPick.ctx.slice(-50) });
  check('点选：来源标记为快捷选项', afterPick.dock.quickSource === true, afterPick.dock.quickSource);

  // 4) 编辑后提交：上下文标注「用户答（快捷选项）」
  await page.fill('#dockAnswerInput', afterPick.value + '（稍作修改）');
  await page.click('#dockAnswerBtn');
  const afterQuickSubmit = await ctx();
  check('快捷提交：上下文标注「用户答（快捷选项）」',
    /用户答（快捷选项）：/.test(afterQuickSubmit), afterQuickSubmit.slice(-140));
  check('快捷提交：编辑后的答案完整拼入',
    /（稍作修改）/.test(afterQuickSubmit), afterQuickSubmit.slice(-140));
  await page.waitForTimeout(400);

  // 5) analysis 类：选项含补数据/公开数据/带假设语义，与 compose 不同
  await page.evaluate(() => window.__cockpit._showClarify('请提供 ERA5 数据', 'analysis'));
  await page.waitForTimeout(150);
  const a = await dock();
  check('analysis：3 个快捷选项', a && a.quickOptions.length === 3, a && a.quickOptions);
  check('analysis：选项含补数据/假设语义',
    a && a.quickOptions.some(t => /数据|假设|公开/.test(t)), a && a.quickOptions);
  check('analysis：来源标记已复位（新回合）', a && a.quickSource === false, a && a.quickSource);
  check('analysis 选项 ≠ compose 选项',
    a && c && JSON.stringify(a.quickOptions) !== JSON.stringify(c.quickOptions),
    { analysis: a && a.quickOptions, compose: c && c.quickOptions });

  // 6) general 类：回退到通用选项
  await page.evaluate(() => window.__cockpit._showClarify('随便问问', 'general'));
  await page.waitForTimeout(150);
  const g = await dock();
  check('general：3 个快捷选项', g && g.quickOptions.length === 3, g && g.quickOptions);
  check('general：选项含现有信息/假设语义',
    g && g.quickOptions.some(t => /现有信息|假设|先做/.test(t)), g && g.quickOptions);

  // 7) 手动输入（不点快捷）→ 标注「用户答」，不被误标为快捷
  await page.fill('#dockAnswerInput', '这是手打的答案');
  await page.click('#dockAnswerBtn');
  const afterManual = await ctx();
  check('手动提交：标注「用户答」',
    /用户答：这是手打的答案/.test(afterManual), afterManual.slice(-100));
  check('手动提交：不含快捷标注',
    !/用户答（快捷选项）：这是手打的答案/.test(afterManual), afterManual.slice(-100));
  await page.waitForTimeout(400);

  // 8) 空答案不提交（点选后清空）
  await page.evaluate(() => window.__cockpit._showClarify('空答案测试', 'compose'));
  await page.waitForTimeout(150);
  await page.click('#cdQuick .cd-quick-btn:nth-of-type(1)');
  await page.fill('#dockAnswerInput', '   ');
  const beforeEmpty = await ctx();
  await page.press('#dockAnswerInput', 'Enter');
  const afterEmpty = await ctx();
  check('空答案回车不提交', afterEmpty === beforeEmpty, { before: beforeEmpty.slice(-60), after: afterEmpty.slice(-60) });

  // 9) 非 clarify / 收起 → dock 与快捷按钮复位隐藏
  await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__cockpit.openResultCard && window.__cockpit.openResultCard());
  await page.waitForTimeout(150);
  const afterOpen = await dock();
  check('普通卡打开：dock 不残留', afterOpen && afterOpen.shown === false, afterOpen);
  await page.evaluate(() => window.__cockpit._showClarify('收起测试'));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__cockpit._rcHide());
  await page.waitForTimeout(100);
  const afterHide = await dock();
  check('收起结果卡：dock 隐藏', afterHide && afterHide.shown === false, afterHide);

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== v0.9.34 clarify 选项式快捷回答回归 ===');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' → ' + JSON.stringify(r.detail))));
  const pass = results.every(r => r.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
