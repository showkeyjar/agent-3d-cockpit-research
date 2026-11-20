const { resolveChromePath } = require('./chrome_helper');
// v0.9.48 回归：类型分流+终态。
// 事实问答/列举类「答完即止」——到达后不自动铺下一批路（断死循环）；
// 用户显式点「继续探索」才续探；开放任务(choice)仍保留自动续探。
// 不碰账本/达成度/机位/指纹环/真实执行——只验证行为分流。
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const T = (ctx, mode, kind) => page.evaluate(a => window.__cockpit.isTerminalTaskForTest(a[0], a[1], a[2]), [ctx, mode, kind]);

  console.log('\n[A] 确定性终态判定（isTerminalTask）');
  ok('事实列举-有哪些算法 (choice) → 终态', await T('目前有哪些常见的主流风机功率预测算法', 'choice', 'general') === true);
  ok('事实列举-什么是 (choice) → 终态', await T('什么是卡尔曼滤波', 'choice', 'general') === true);
  ok('定义问句 → 终态', await T('_gru 的定义', 'choice', 'general') === true);
  ok('后端 direct → 终态', await T('随便一句话', 'direct', 'general') === true);
  ok('开放分析任务 (choice) → 非终态', await T('分析近6个月销售数据找出异常月份', 'choice', 'analysis') === false);
  ok('含预测但为多步产出 → 非终态', await T('预测未来7天风电功率并生成报告', 'choice', 'analysis') === false);
  ok('顺序流程 sequential → 非终态', await T('有哪些算法', 'sequential', 'general') === false);
  ok('起草类写作 → 非终态', await T('写一段连贯的话', 'choice', 'compose') === false);
  ok('空上下文 → 非终态', await T('', 'choice', 'general') === false);

  console.log('\n[B] 到达续探门控（shouldAutoExplore，与真实收尾同一处真相）');
  const SAE = (p, detail, terminal) => page.evaluate(a => window.__cockpit.shouldAutoExploreForTest(a[0], a[1], a[2]), [p, detail, terminal]);
  ok('终态+有位置 → 不自动续探', await SAE([8,0,8], {clarify:false}, true) === false);
  ok('非终态+有位置 → 自动续探', await SAE([8,0,8], {clarify:false}, false) === true);
  ok('澄清 → 终态与否都不续探', await SAE([8,0,8], {clarify:true}, false) === false);
  ok('无位置 → 不续探', await SAE(null, {clarify:false}, false) === false);

  console.log('\n[B2] 结果卡终态 UI / 钩子');
  const hookOk = await page.evaluate(() => ({
    isTerminal: typeof window.__cockpit.isTerminalTaskForTest === 'function',
    termVisible: typeof window.__cockpit.rcTerminalVisible === 'boolean',  // getter 返回 boolean
    contAvail: typeof window.__cockpit.continueExploringForTest === 'function',
  }));
  ok('终态测试钩子齐全', hookOk.isTerminal && hookOk.termVisible && hookOk.contAvail, hookOk);

  const card = await page.evaluate(() => window.__cockpit._showTerminalCardForTest());
  ok('终态卡头显示「问题已解答」', card.title === '问题已解答', card.title);
  ok('终态说明条可见', card.termBar === true, card.termBar);
  ok('动作区含「继续探索相关方向」按钮', /继续探索相关方向/.test(card.actions), card.actions);

  console.log('\n[C] 显式续探函数可用（不报错、返回 true）');
  const cont = await page.evaluate(() => { try { return window.__cockpit.continueExploringForTest(); } catch(e){ return 'ERR:' + e.message; } });
  ok('continueExploringFromCard 可调用', cont === true, cont);

  console.log('\n[D] 无 JS 错误');
  ok('pageerror/console.error = 0', errors.length === 0, errors.slice(0,3));

  console.log(`\n结果: ${pass}/${pass+fail} 通过`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
