const { resolveChromePath } = require('./chrome_helper');
// v0.9.32 · H2.2 镜像组 C 组回归：?mode=decorative
//   核心主张：呈现层与 B 组逐像素一致（不隐藏任何元素），但执行层未真实推进——
//   不发 execute / refine WS、不调 LLM，用本地伪执行走同一 handleWsMessage 路径。
//   数据诚实：账本 exec.decorative===true（source 仍为 llm 以维持呈现一致）。
//   默认路径（无 mode）不受影响，仍发真实 execute。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

let failures = 0;
function check(name, ok, extra){
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures++;
}

async function newPage(browser, url){
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__cockpit, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return page;
}
async function visibleMap(page){
  return page.evaluate(() => {
    const ids = ['resultCard','comparePanel','timelinePanel','progressHud','decisionChain','customDirInput','cmpToggle','timelineBtn','decisionBtn'];
    const out = {};
    ids.forEach(id => {
      const el = document.getElementById(id);
      out[id] = el ? getComputedStyle(el).display : 'no-el';
    });
    return out;
  });
}

async function main(){
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });

  // ── 1) 模式生效 + 呈现层与 B 一致 ────────────────────────────────
  const page = await newPage(browser, 'http://localhost:8770/?mode=decorative');
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  const modeOn = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('mode-decorative'),
    flag: window.__cockpit.decorativeMode === true,
  }));
  check('html.mode-decorative class 已生效', modeOn.cls === true, JSON.stringify(modeOn));
  check('window._decorativeMode 为真（经钩子可读）', modeOn.flag === true, JSON.stringify(modeOn));

  // 呈现层「逐像素一致」的严谨判据：C 组与 B 组初始可见状态逐项相等；且无 opaque/noLink class。
  // （面板初始收起 display:none 在 B 组也一样，不能据单个 none 判为被隐藏。）
  const cVis = await visibleMap(page);
  const clsCheck = await page.evaluate(() => ({
    opaque: document.documentElement.classList.contains('mode-opaque'),
    noLink: document.documentElement.classList.contains('mode-transparent-nolink'),
  }));
  check('C 组无 mode-opaque / transparent-nolink class',
    clsCheck.opaque === false && clsCheck.noLink === false, JSON.stringify(clsCheck));
  const bPage = await newPage(browser, 'http://localhost:8770/');
  const bVis = await visibleMap(bPage);
  await bPage.close();
  const visDiff = Object.keys(cVis).filter(k => cVis[k] !== bVis[k]);
  check('呈现层可见状态与 B 组逐项一致（逐像素一致）', visDiff.length === 0,
    visDiff.length ? `差异=${visDiff.map(k => `${k}:C=${cVis[k]},B=${bVis[k]}`).join(' | ')}` : JSON.stringify(cVis));

  // ── 2) 伪执行：不发真 WS execute，token 流照常，账本标 decorative ──
  const before = await page.evaluate(() => ({
    runs: window.__cockpit.runCount,
    wsExec: window.__cockpit.wsLog.filter(x => x.type === 'execute').length,
  }));
  await page.evaluate(() => window.__cockpit._decorStart());
  // 等 token 流开始（峰值前）
  await page.waitForFunction(() => {
    const t = document.querySelector('#taskBar .tb-item .tb-stream');
    return t && (t.textContent || '').length > 0;
  }, null, { timeout: 8000 }).catch(()=>{});
  const midWs = await page.evaluate(() => window.__cockpit.wsLog.filter(x => x.type === 'execute').length);
  check('C 组执行未发真实 execute WS', midWs === before.wsExec, `before=${before.wsExec} mid=${midWs}`);

  await page.waitForFunction((n) => window.__cockpit.runCount > n, before.runs, { timeout: 12000 }).catch(()=>{});
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => {
    const runs = window.__cockpit.runs;
    const last = runs[runs.length - 1] || {};
    return {
      runCount: window.__cockpit.runCount,
      wsExec: window.__cockpit.wsLog.filter(x => x.type === 'execute').length,
      wsRefine: window.__cockpit.wsLog.filter(x => x.type === 'refine').length,
      lastStatus: last.status,
      lastSource: last.exec && last.exec.source,
      lastDecorative: last.exec && last.exec.decorative,
      lastCompletion: last.exec && last.exec.completion,
      outputLen: String(last.output || '').length,
      cardShown: window.__cockpit.hasArrival,
    };
  });
  check('账本新增一轮', after.runCount === before.runs + 1, `before=${before.runs} after=${after.runCount}`);
  check('该轮 status=done（伪执行呈现为完成）', after.lastStatus === 'done', after.lastStatus);
  check('source 仍标 llm（呈现一致所需）', after.lastSource === 'llm', after.lastSource);
  check('exec.decorative===true（数据诚实正交标记）', after.lastDecorative === true, String(after.lastDecorative));
  check('completion=achieved（呈现一致）', after.lastCompletion === 'achieved', after.lastCompletion);
  check('伪产出有正文（非空）', after.outputLen > 50, `len=${after.outputLen}`);
  check('结果卡已打开（呈现层照常）', after.cardShown === true, String(after.cardShown));
  check('全程未发 execute WS', after.wsExec === before.wsExec, `before=${before.wsExec} after=${after.wsExec}`);

  // 导出研究数据：CSV/JSON 含 exec_decorative 且 summary 计数 >=1
  const exp = await page.evaluate(() => {
    const json = JSON.parse(window.__cockpit._exportRuns('json'));
    const csv = window.__cockpit._exportRuns('csv');
    return {
      summaryDecor: json.summary.exec_decorative,
      hasField: json.runs.some(r => r.exec && r.exec.decorative === true),
      csvHeader: csv.split('\n')[0],
    };
  });
  check('导出 summary.exec_decorative >= 1', exp.summaryDecor >= 1, String(exp.summaryDecor));
  check('导出某轮 exec.decorative=true', exp.hasField === true, String(exp.hasField));
  check('CSV 表头含 exec_decorative 列', exp.csvHeader.includes('exec_decorative'), exp.csvHeader.slice(-80));

  // ── 3) refine 也是伪执行：不发 refine WS，done 到账、账本标 decorative ──
  const refineBefore = await page.evaluate(() => ({
    runs: window.__cockpit.runCount,
    wsRefine: window.__cockpit.wsLog.filter(x => x.type === 'refine').length,
  }));
  await page.evaluate(() => window.__cockpit._injectRefineDone({
    ok:true, mode:'expand', output:'【演示展开】完整成果正文……', source:'llm',
    decorative:true, completion:'achieved', tokens:100, elapsed_ms:600,
  }));
  await page.waitForTimeout(200);
  const refineAfter = await page.evaluate(() => {
    const runs = window.__cockpit.runs;
    const last = runs[runs.length - 1] || {};
    return {
      runs: window.__cockpit.runCount,
      wsRefine: window.__cockpit.wsLog.filter(x => x.type === 'refine').length,
      decor: last.exec && last.exec.decorative,
      chain: last.exec && last.exec.chain,
    };
  });
  check('refine_done 走协议进账本', refineAfter.runs === refineBefore.runs + 1,
    `before=${refineBefore.runs} after=${refineAfter.runs}`);
  check('refine 轮 decorative=true', refineAfter.decor === true, String(refineAfter.decor));
  check('refine 轮链标 refine:expand', Array.isArray(refineAfter.chain)
    && refineAfter.chain.some(c => String(c).startsWith('refine:')), JSON.stringify(refineAfter.chain));
  check('未发真实 refine WS', refineAfter.wsRefine === refineBefore.wsRefine,
    `before=${refineBefore.wsRefine} after=${refineAfter.wsRefine}`);

  // ── 4) 中断：伪执行点停止 → interrupted，不写完成轨迹 ──────────────
  const intrBefore = await page.evaluate(() => window.__cockpit.runCount);
  await page.evaluate(() => window.__cockpit._decorStart());
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__cockpit._stopGen());
  await page.waitForTimeout(300);
  const intr = await page.evaluate(() => {
    const runs = window.__cockpit.runs;
    const last = runs[runs.length - 1] || {};
    return {
      runs: window.__cockpit.runCount,
      status: last.status,
      decor: last.exec && last.exec.decorative,
      interrupted: last.exec && last.exec.interrupted,
    };
  });
  check('中断进账本一轮', intr.runs === intrBefore + 1, `before=${intrBefore} after=${intr.runs}`);
  check('中断 status=interrupted（非 done）', intr.status === 'interrupted', intr.status);
  check('中断轮 decorative=true', intr.decor === true, String(intr.decor));
  check('中断轮 exec.interrupted=true', intr.interrupted === true, String(intr.interrupted));

  check('C 组页面 JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));
  await page.close();

  // ── 5) 默认路径守卫：无 mode 时 _decorStart 仍走真实 execute ─────────
  const dpage = await browser.newPage();
  await dpage.setViewportSize({ width: 1440, height: 900 });
  await dpage.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await dpage.waitForFunction(() => !!window.__cockpit, null, { timeout: 15000 });
  const guard = await dpage.evaluate(() => {
    const decorMode = window.__cockpit.decorativeMode;
    window.__cockpit._stubWs(true);           // 桩 WS：send 不外发，只记录
    window.__cockpit._decorStart();            // 真实 startExecution 入口
    const sent = window.__cockpit.wsLog.filter(x => x.type === 'execute').length;
    window.__cockpit._stopGen();               // 本地收尾，避免真调模型/残留
    window.__cockpit._endExec();
    return { decorMode, sent };
  });
  check('默认 URL 无 decorativeMode', guard.decorMode === false, String(guard.decorMode));
  check('默认路径仍发真实 execute WS', guard.sent >= 1, `sent=${guard.sent}`);
  await dpage.close();

  await browser.close();
  console.log(failures === 0
    ? '\n✓✓✓ H2.2 C 组（decorative）回归通过'
    : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
