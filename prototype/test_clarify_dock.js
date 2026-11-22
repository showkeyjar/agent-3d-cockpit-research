/* v0.9.33 回归：clarify 底部悬浮回答条（解决「右上角信息栏太隐蔽」）
   1) 普通状态 dock 隐藏；clarify 时 dock 显示在输入框正上方、问题文本同步、自动聚焦
   2) 底部 dock 入口提交答案 → 拼进 _lastContext（[用户补充]/用户答）、dock 随之隐藏
   3) 右上结果卡入口仍可用（兼容既有习惯），复用同一提交逻辑
   4) 回车提交、空答案不提交
   5) 普通卡打开/收起结果卡 → dock 复位隐藏（不残留）
   注意：_showClarify 的 idx=-1 会走 runForecast 退化分支，提交后不深究推演结果，
   只断言「答案已拼进上下文 + dock 已隐藏」这一确定性行为。
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

  // 1) 初始：dock 隐藏
  const init = await page.evaluate(() => window.__cockpit.clarifyDock);
  check('初始 dock 隐藏', init && init.shown === false, init);

  // 2) clarify：dock 显示在输入框上方、问题同步、聚焦
  await page.evaluate(() => window.__cockpit._showClarify('请提供销售量数据'));
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => window.__cockpit.clarifyDock);
  check('clarify 时 dock 显示', shown && shown.shown === true, shown);
  check('dock 在输入框上方（不与输入栏重叠）', shown && shown.aboveInputBar === true,
    { rect: shown && shown.rect, inputBarTop: shown && shown.inputBarTop });
  check('dock 问题文本同步模型提问', shown && /请提供销售量数据/.test(shown.question), shown && shown.question);
  check('dock 输入框自动聚焦', shown && shown.focused === true, shown && shown.focused);
  check('dock 水平居中（贴合输入栏）',
    shown && Math.abs((shown.rect.left + shown.rect.width / 2) - 640) < 30,
    shown && shown.rect);

  // 3) 底部 dock 入口提交
  await page.fill('#dockAnswerInput', '一月到三月各 100/120/150 件');
  await page.click('#dockAnswerBtn');
  const afterDockSubmit = await page.evaluate(() => ({
    ctx: window.__cockpit.lastContextText,
    dock: window.__cockpit.clarifyDock,
  }));
  check('dock 提交：答案拼进上下文（用户答）',
    /用户答：一月到三月各 100\/120\/150 件/.test(afterDockSubmit.ctx), afterDockSubmit.ctx.slice(-120));
  check('dock 提交：上下文含模型问',
    /模型问：请提供销售量数据/.test(afterDockSubmit.ctx), afterDockSubmit.ctx.slice(-120));
  check('dock 提交后 dock 隐藏', afterDockSubmit.dock && afterDockSubmit.dock.shown === false, afterDockSubmit.dock);
  await page.waitForTimeout(400);   // 等 runForecast 退化分支稳定

  // 4) 右上结果卡入口仍可用（复用同一逻辑）
  await page.evaluate(() => window.__cockpit._showClarify('再提供成本数据'));
  await page.waitForTimeout(150);
  await page.fill('#rcAnswerInput', '成本 80 每件');
  await page.click('#rcAnswerBtn');
  const afterRcSubmit = await page.evaluate(() => ({
    ctx: window.__cockpit.lastContextText,
    dock: window.__cockpit.clarifyDock,
  }));
  check('右上入口提交：答案拼进上下文', /用户答：成本 80 每件/.test(afterRcSubmit.ctx), afterRcSubmit.ctx.slice(-100));
  check('右上入口提交后 dock 也隐藏', afterRcSubmit.dock && afterRcSubmit.dock.shown === false, afterRcSubmit.dock);
  await page.waitForTimeout(400);

  // 5) 回车提交 + 空答案不提交
  await page.evaluate(() => window.__cockpit._showClarify('问题三'));
  await page.waitForTimeout(150);
  const ctxBefore = await page.evaluate(() => window.__cockpit.lastContextText);
  await page.fill('#dockAnswerInput', '   ');
  await page.press('#dockAnswerInput', 'Enter');
  const ctxAfterEmpty = await page.evaluate(() => window.__cockpit.lastContextText);
  check('空答案回车不提交', ctxAfterEmpty === ctxBefore, { before: ctxBefore.slice(-60), after: ctxAfterEmpty.slice(-60) });
  await page.fill('#dockAnswerInput', '回车答案');
  await page.press('#dockAnswerInput', 'Enter');
  const ctxAfterEnter = await page.evaluate(() => window.__cockpit.lastContextText);
  check('非空答案回车可提交', /用户答：回车答案/.test(ctxAfterEnter), ctxAfterEnter.slice(-100));
  await page.waitForTimeout(400);

  // 6) 普通卡（非 clarify）打开 → dock 复位隐藏（不残留上一次 clarify 的作答框）
  await page.evaluate(() => window.__cockpit._showClarify('问题四'));
  await page.waitForTimeout(100);
  // 铺一个普通到达结果（setupTestArrival 会写 _arrivalResults(-2)），再幂等打开普通卡
  await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__cockpit.openResultCard && window.__cockpit.openResultCard());
  await page.waitForTimeout(150);
  const afterOpen = await page.evaluate(() => window.__cockpit.clarifyDock);
  check('普通卡打开时 dock 不残留显示', afterOpen && afterOpen.shown === false, afterOpen);
  // 收起结果卡 → dock 也隐藏
  await page.evaluate(() => window.__cockpit._showClarify('问题五'));
  await page.waitForTimeout(100);
  const beforeHide = await page.evaluate(() => window.__cockpit.clarifyDock);
  check('收起前 dock 显示', beforeHide && beforeHide.shown === true, beforeHide);
  await page.evaluate(() => window.__cockpit._rcHide());
  await page.waitForTimeout(100);
  const afterHide = await page.evaluate(() => window.__cockpit.clarifyDock);
  check('收起结果卡后 dock 隐藏', afterHide && afterHide.shown === false, afterHide);

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== v0.9.33 clarify 底部回答条回归 ===');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' → ' + JSON.stringify(r.detail))));
  const pass = results.every(r => r.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
