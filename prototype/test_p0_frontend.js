/* P0 结果可用性 · 前端回归（纯前端钩子，不依赖慢推理）
   1) 达成度徽章：achieved/partial/need_input 三档都渲染
   2) 交付层：有真实产出才显示 rcDeliver；复制/导出按钮存在
   3) 导出交付物预览：正文来自真实 output，带任务/达成度
   4) 迭代层：_injectRefineDone 把深化成果写回卡 + 进账本（parent 链）
   5) 判据进账本：completion/self_rating 落进 run.exec
   6) 无 JS 错误
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._injectRefineDone, null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
  const REAL = '协作指南：1. 代码评审：PR 需两人复核，24 小时内响应。2. 文档更新：随功能提交同步更新 README。3. 问题响应：值班同学 2 小时内认领并给出预计修复时间。';

  // 1) 达成度三档 + 交付区显示（achieved）
  const a = await page.evaluate((out) => {
    const c = window.__cockpit;
    c._rcSet({ ok:true, source:'llm', completion:'achieved', self_rating:'达成',
      label:'覆盖三个方面', context:'起草团队协作指南', output:out,
      elapsed_ms:5000, tokens:120, chain:['output'], tasks:[] });
    c._rcShow();
    return { completion: c.completion, text: c.completionText,
      shown: c.completionShown, deliver: c.deliverShown,
      badge: document.getElementById('rcCompletion').textContent,
      copyBtn: [...document.querySelectorAll('#rcActions button')].some(b => b.textContent.includes('复制')),
      expBtn: [...document.querySelectorAll('#rcActions button')].some(b => b.textContent.includes('导出')),
      expandTool: document.getElementById('rcExpandBtn') ? document.getElementById('rcExpandBtn').style.display : 'none' };
  }, REAL);
  check('achieved 达成度=目标达成', a.completion === 'achieved' && a.text === '目标达成', a);
  check('达成度徽章显示', a.shown && /目标达成/.test(a.badge), a.badge);
  check('有成果才显示深化工具区', a.deliver === true && a.expandTool !== 'none', a);
  check('复制按钮存在', a.copyBtn, a.copyBtn);
  check('导出成品按钮存在', a.expBtn, a.expBtn);

  // 2) 导出交付物预览
  const prev = await page.evaluate(() => window.__cockpit._exportDeliverablePreview());
  check('导出预览来自真实 output', prev && prev.text.includes('代码评审') && prev.hasTask, prev);
  check('导出预览带达成度', prev && prev.completion === 'achieved', prev);

  // 3) need_input 档不显示交付区（澄清卡不该假装能深化）
  const ni = await page.evaluate(() => {
    const c = window.__cockpit;
    c._showClarify('请提供销售数据');
    return { completion: c.completion, text: c.completionText, deliver: c.deliverShown };
  });
  check('need_input 档=待补输入', ni.completion === 'need_input' && ni.text === '待补输入', ni);
  check('澄清卡不显示深化工具', ni.deliver === false, ni);

  // 4) 迭代层：注入 refine_done → 写回卡 + 进账本（parent 链）
  const rf = await page.evaluate((out) => {
    const c = window.__cockpit;
    const base = { ok:true, source:'llm', completion:'achieved', label:'协作指南',
      context:'起草团队协作指南', output:out, elapsed_ms:5000, tokens:120,
      chain:['output'], tasks:[] };
    c._recordRun(base, 'done');   // 真实场景：到达牌 detail 已经过 recordRun
    c._rcSet(base);
    c._rcShow();
    const r = c._injectRefineDone({ output:'完整成果：一、代码评审流程……二、文档更新规范……三、问题响应 SLA……（此处为 500 字完整版）',
      self_rating:'达成', completion:'achieved', mode:'expand', source:'llm' });
    return r;
  }, REAL);
  check('深化成果写回结果卡', rf.output.includes('完整成果') && rf.output.length > 20, rf.output);
  check('深化后 completion=achieved', rf.completion === 'achieved', rf.completion);
  check('深化进账本（runs 增加）', rf.runs >= 1, rf.runs);
  check('深化链记账 refine:expand', rf.lastChain.some(x => String(x).startsWith('refine:')), rf.lastChain);
  check('深化带父轮 parent', rf.lastParent !== null, rf.lastParent);

  // 5) 账本导出含 completion 字段
  const exp = await page.evaluate(() => {
    const j = window.__cockpit._exportRuns('json');
    const o = JSON.parse(j);
    return { summary: o.summary, hasField: JSON.stringify(o.runs || []).includes('exec_completion') };
  });
  check('导出 summary 含达成度统计', 'completion_achieved' in exp.summary && 'refine_runs' in exp.summary, exp.summary);

  console.log('=== P0 结果可用性 · 前端回归 ===');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' → ' + JSON.stringify(r.detail))));
  const pass = results.every(r => r.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0,3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
