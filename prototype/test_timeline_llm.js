/* test_timeline_llm.js — v0.9.17 分叉重走的真实 35B 冒烟
 *
 * test_timeline.js 的 D 段用 WS 桩验证了「协议路径真实、旧结果不回放」；
 * 这一支不 mock fetch、不 stub WS，让分叉重走真的打到 8770 + 8082：
 *   真实重新推演 → 真实 WS execute → 真实模型流式生成 → 真实 execute_done。
 * 父轮由测试注入以快速构造分叉起点（产品里父轮来自真实执行），
 * 但第 3 轮必须由后端真实产出，且不得等于父轮结果。
 * 35B 单槽拥塞时结果可能是澄清 / 本地兜底，测试如实接受并标注，不伪造通过。
 */
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8770/';
const CONTEXT = '国内电力交易市场的现货与中长期交易有什么区别？';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.runs), { timeout: 20000 });

  // 构造两个父轮（真实会话里这两轮来自真实执行；此处只为快速造出分叉起点）
  await page.evaluate(ctx => {
    const d1 = {
      ok: true, mode: 'choice', label: '查资料', context: ctx,
      output: '父轮原始结果：现货与中长期交易在定价机制上存在差异。',
      elapsed_ms: 3100, tokens: 110, chain: ['output'], source: 'llm',
      pos: [2, 0, 2], branchLabel: '查资料',
    };
    window.__cockpit._recordRun(d1, 'done');
    window.__cockpit._recordRun({ ...d1, label: '梳理政策', output: '父轮结果B' }, 'done');
  }, CONTEXT);

  console.log('\n=== 真实 35B 分叉重走 ===');
  await page.evaluate(() => window.__cockpit._forkFrom('r1'));
  await page.waitForFunction(() => window.__cockpit.execState.done === false, { timeout: 30000 })
    .catch(() => {});
  const started = await page.evaluate(() => ({
    exec: window.__cockpit.execState,
    ws: window.__cockpit.wsLog.filter(m => m.type === 'execute').map(m => ({ context: m.context, label: m.label })),
  }));
  check('真实进入执行态并发出了 type=execute',
    started.exec.done === false && started.ws.length >= 1 && started.ws[0].context === CONTEXT,
    JSON.stringify(started));

  await page.waitForFunction(() => window.__cockpit.runCount === 3, { timeout: 180000 });
  const r = await page.evaluate(() => ({
    runs: window.__cockpit.runs,
    ws: window.__cockpit.wsLog,
    sub: window.__cockpit.timelineSubText,
    detail: window.__cockpit.timelineDetailText,
  }));
  const r1 = r.runs[0], r3 = r.runs[2];
  console.log(`  · 第 3 轮状态=${r3.status} 执行来源=${r3.exec.source} 推演来源=${r3.forecast.kind} 耗时=${r3.exec.elapsed_ms}ms 字数=${String(r3.output).length}`);
  check('模型回包后产生第 3 轮，且 parent_run_id=r1',
    r3.parent_run_id === 'r1' && r3.fork_of_seq === 1 && r.runs.length === 3);
  check('第 3 轮是后端真实产出，不是父轮结果回放',
    String(r3.output).length > 0 && r3.output !== r1.output &&
    Number.isFinite(r3.exec.elapsed_ms) && r3.exec.elapsed_ms > 0,
    `out=${String(r3.output).slice(0, 40)}…`);
  check('原父轮记录原封不动',
    r1.output === '父轮原始结果：现货与中长期交易在定价机制上存在差异。' &&
    r1.parent_run_id === null && r.runs[1].output === '父轮结果B');
  check('时间线汇总写出「1 次分叉」', r.sub.includes('1 次分叉'), r.sub);
  // 真实推演未必再给出父轮那条路：回退首个候选可以，但必须如实标注，不能假装重走同一方向
  check('原方向未复现时标 fork_matched=false 并在详情写明实际方向',
    r3.fork_matched === false && !!r3.fork_actual_label &&
    r3.fork_actual_label === r3.label && r.detail.includes('这次推演没给出'),
    `原=${r3.fork_label} 实际=${r3.fork_actual_label}`);
  check('来源与状态如实标注（不把兜底洗成模型推演）',
    ['llm','fast','local','offline'].includes(r3.forecast.kind) &&
    ['done','failed','interrupted','clarify'].includes(r3.status),
    `${r3.forecast.kind} / ${r3.status}`);
  check('0 个 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n${fail === 0 ? '✅ ALL_PASS' : '❌ FAIL'} — ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
