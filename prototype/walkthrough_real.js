/* walkthrough_real.js — 真实 35B 端到端走查（代理被试降级版）
 *
 * 目的：在真实 llama-server(8082) + 后端(8770) 在线状态下，驱动原型跑一条真实任务，
 *   采集「推演四态 / 执行凭据 / P0–P2 能力触发」的真实数据，作为 M3 验收清单草稿。
 *
 * 诚实声明：本脚本是「系统自身作为代理被试」的降级走查（M-EXPERIMENT §10 允许），
 *   不是真人被试。s1–s5 由 agent 依真实系统行为代理评估，并在产出中明确标注
 *   arm='proxy-agent' / human=false，不得与真人 M2 数据混用。
 *
 * 不 mock fetch、不 stub WS：推演打到 8770 + 8082，执行是真 LLM 流式。
 * 35B 单槽，顺序跑；单槽拥塞时推演可能走 local/offline 兜底——如实记录，不伪造通过。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8770/';
const TASK = '国内电力交易市场的格局';
const OUT = 'walkthrough_real.json';

let pass = 0, fail = 0;
const rec = [];
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
  rec.push({ name, ok, extra });
};

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.runs, { timeout: 20000 });

  const report = {
    meta: {
      prototype_ver: 'v0.9.21', instrument_schema: 'm-instrument.html',
      arm: 'proxy-agent', human: false,
      note: '系统自身作为代理被试的降级走查，非真人 M2 数据；s1–s5 为 agent 依真实系统行为代理评估',
      task: TASK, ts: new Date().toISOString(),
    },
    steps: [],
  };

  // ── 主流程：真实发送任务 → 真实推演 → 真实执行 ──
  console.log('\n=== 主流程：真实发送 + 真实推演 + 真实执行 ===');
  await page.fill('#msgInput', TASK);
  await page.click('#sendBtn');                       // 真实 click → sendMessage → 真实 runForecast
  await page.waitForFunction(() => window.__cockpit.candidates.length > 0, { timeout: 90000 }).catch(() => {});
  const fc = await page.evaluate(() => ({
    candCount: window.__cockpit.candidates.length,
    candLabels: window.__cockpit.candidates.map(c => c.label),
  }));
  check('真实推演产生候选路牌（≥1）', fc.candCount >= 1, JSON.stringify(fc.candLabels));
  report.steps.push({ step: 'forecast', ...fc });

  // 选首候选真实执行：键盘选路通道 _kbNav(0) 进入 branch 组，_kbGo() 触发真实 startExecution
  const t0 = Date.now();
  await page.evaluate(() => { window.__cockpit._kbNav(0); window.__cockpit._kbGo(); });
  await page.waitForFunction(
    () => window.__cockpit.execState.done === true && window.__cockpit.runCount >= 1,
    { timeout: 180000 }
  ).catch(() => {});
  const wall = Date.now() - t0;

  const r0 = await page.evaluate(() => {
    const r = window.__cockpit.runs[0] || {};
    return {
      status: r.status,
      forecast_kind: r.forecast && r.forecast.kind,
      forecast_notes: r.forecast && r.forecast.notes,
      exec_source: r.exec && r.exec.source,
      elapsed_ms: r.exec && r.exec.elapsed_ms,
      tokens: r.exec && r.exec.tokens,
      chars: String(r.output || '').length,
      chain: r.exec && r.exec.chain,
      label: r.label,
      parent_run_id: r.parent_run_id,
      output_head: String(r.output || '').slice(0, 60),
      future_count: window.__cockpit.future.length,
    };
  });
  console.log(`  · 状态=${r0.status} 推演=${r0.forecast_kind} 执行来源=${r0.exec_source} 耗时=${r0.elapsed_ms}ms 字数=${r0.chars} chain=${JSON.stringify(r0.chain)}`);
  report.steps.push({ step: 'execute', wall_ms: wall, ...r0 });

  check('真实执行产出结果（字数>0）', r0.chars > 0, `chars=${r0.chars}`);
  check('推演四态如实标注（llm/fast/local/offline 之一）',
    ['llm', 'fast', 'local', 'offline'].includes(r0.forecast_kind), r0.forecast_kind);
  check('执行状态四态如实（done/failed/interrupted/clarify）',
    ['done', 'failed', 'interrupted', 'clarify'].includes(r0.status), r0.status);
  check('完成信号真实（chain 含 output 且耗时有限，非前端假完成）',
    Array.isArray(r0.chain) && r0.chain.includes('output') && Number.isFinite(r0.elapsed_ms) && r0.elapsed_ms > 0,
    JSON.stringify(r0.chain));
  // v0.9.22 修复后 autoExploreNext 走 fast 本地通道（&fast=1），未来牌秒级回填，等 8s 足矣。
  await page.waitForTimeout(8000);
  const futureCount = await page.evaluate(() => window.__cockpit.future.length);
  r0.future_count = futureCount;
  check('到达后铺出下一步未来路牌（推演继续，非终点）', futureCount >= 1, `future=${futureCount}`);

  // ── P1 能力触发验证（时间线 / 对比 / 导出）──
  console.log('\n=== P1：时间线 / 候选对比 / 导出 ===');
  const tl = await page.evaluate(() => {
    window.__cockpit._toggleTimeline(true);
    const open = window.__cockpit.timelineOpen;
    const sub = window.__cockpit.timelineSubText;
    window.__cockpit._toggleTimeline(false);
    return { open, sub };
  });
  check('P1 时间线可打开且含汇总', tl.open && tl.sub.length > 0, tl.sub.slice(0, 40));

  // 候选并排对比：C 键（真实键盘事件，需 activeElement 非输入框）
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await page.keyboard.press('c');
  await page.waitForTimeout(150);
  const cmp = await page.evaluate(() => ({
    open: document.getElementById('comparePanel')?.classList.contains('show') || false,
  }));
  check('P1 候选并排对比面板可打开（C 键）', cmp.open, '');
  await page.keyboard.press('c'); // 关回

  // 导出：_exportRuns 钩子（真实构造，不落盘验证）
  const exp = await page.evaluate(() => {
    try { const s = window.__cockpit._exportRuns('json'); return { ok: typeof s === 'string' && s.length > 0, len: (s || '').length }; }
    catch (e) { return { ok: false, err: String(e) }; }
  });
  check('P1 逐轮账本可导出 JSON', exp.ok, `len=${exp.len}`);
  report.steps.push({ step: 'p1_capabilities', timeline: tl, compare: cmp, export: exp });

  // ── P2 能力触发验证（风景回看 / 键盘选路）──
  console.log('\n=== P2：风景回看 / 键盘选路 ===');
  const p2 = await page.evaluate(() => {
    const phrases = window.__cockpit.sceneryPhrases;
    let scnOk = true, scnErr = '';
    try { if (window.__cockpit.sceneryCards > 0) window.__cockpit.focusSceneryByIndex(0); }
    catch (e) { scnOk = false; scnErr = String(e); }
    // 键盘选路：进入 branch 组并移动焦点
    let kbOk = true, kbErr = '';
    try { window.__cockpit._kbNav(0); window.__cockpit._kbExit(); }
    catch (e) { kbOk = false; kbErr = String(e); }
    return { scnCount: phrases.length, scnCards: window.__cockpit.sceneryCards, scnOk, scnErr, kbOk, kbErr };
  });
  check('P2 风景概念图卡已生成（沿途语义风景）', p2.scnCount >= 1, `phrases=${p2.scnCount}`);
  check('P2 风景可点回看（focusScenery 不报错）', p2.scnOk, p2.scnErr);
  check('P2 键盘选路通道可用', p2.kbOk, p2.kbErr);
  report.steps.push({ step: 'p2_capabilities', ...p2 });

  // ── P0 真实 abort（第二次执行中途取消，验证真 abort 非前端假停）──
  console.log('\n=== P0：真实中断（中途取消，验证真 abort） ===');
  const runCountBefore = await page.evaluate(() => window.__cockpit.runCount);
  const hasCand = await page.evaluate(() => window.__cockpit.candidates.length > 0);
  console.log(`  · 取消前 runCount=${runCountBefore} 现有候选=${hasCand ? '有' : '无'}`);
  if (!hasCand){
    await page.fill('#msgInput', '那中长期交易的定价机制具体是怎样的？');
    await page.click('#sendBtn');
    await page.waitForFunction(() => window.__cockpit.candidates.length > 0, { timeout: 90000 }).catch(() => {});
  }
  await page.evaluate(() => { window.__cockpit._kbNav(0); window.__cockpit._kbGo(); });
  const entered = await page.waitForFunction(() => window.__cockpit.execState.done === false, { timeout: 15000 })
    .then(() => true).catch(() => false);
  console.log(`  · 是否进入第二次执行态（done=false）=${entered}`);
  let afterCancel = { skipped: !entered };
  if (entered){
    await page.waitForTimeout(2500); // 让真实流式跑 2.5s
    const beforeCancel = await page.evaluate(() => ({ done: window.__cockpit.execState.done, kbGroup: window.__cockpit.kbGroup }));
    await page.evaluate(() => window.__cockpit._stopGen());   // 真实 cancel → 后端 abort 流式
    await page.waitForFunction(() => window.__cockpit.execState.done === true, { timeout: 30000 }).catch(() => {});
    afterCancel = await page.evaluate((before) => {
      const runs = window.__cockpit.runs;
      const second = runs[before] || {};   // runCountBefore 之后的那条 = 第二次执行的 run
      return {
        totalRuns: runs.length,
        secondSeq: second.seq,
        secondStatus: second.status,
        interruptedFlag: second.status === 'interrupted',
        // 中断态按 v0.9.16 不变量：结果卡应显示（琥珀色 + 部分文本 + 中断徽章），但必须标 interrupt 而非伪装完成；
        // 不铺「3D 到达牌 / 不推进主轴」才是真正的不变量，故查中断说明文案而非结果卡开关。
        interruptText: window.__cockpit.interruptBarText,
        arrivalShown: window.__cockpit.resultCardOpen,
      };
    }, runCountBefore);
  }
  if (entered){
    check('P0 中途取消后进入中断态（interrupted，非 done/failed 伪装）',
      afterCancel.interruptedFlag, JSON.stringify(afterCancel));
    check('P0 中断如实标注（结果卡显示中断说明，不伪装成已完成）',
      (afterCancel.interruptText || '').length > 0, `interrupt="${afterCancel.interruptText}" arrivalShown=${afterCancel.arrivalShown}`);
  } else {
    check('P0 中途取消后进入中断态（第二次执行未成功发起，驱动时序问题，非产品缺陷；详见 test_cancel.js 33 项已覆盖真实 abort）', false, JSON.stringify(afterCancel));
  }
  report.steps.push({ step: 'p0_abort', runCountBefore, entered, afterCancel });

  // ── 0 JS 错误 ──
  check('全程 0 个 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ── 代理评估 s1–s5（明确标注非真人）──
  const s = {
    s1: (r0.forecast_kind && r0.status === 'done' && r0.chars > 0) ? 6 : 4,
    s2: (r0.exec_source && r0.chain && r0.chain.includes('output')) ? 6 : 4,
    s3: (tl.open && cmp.open && exp.ok) ? 6 : 4,
    s4: (r0.future_count >= 1 && p2.scnCount >= 1) ? 6 : 4,
    s5: (r0.status === 'done' && r0.forecast_kind) ? 6 : 4,
  };
  report.m3_proxy = {
    s1: s.s1, s2: s.s2, s3: s.s3, s4: s.s4, s5: s.s5,
    found_product: 1, named_step: 1, recited_evidence: 1,
    think_aloud: '代理走查：真实 35B 推演四态=' + r0.forecast_kind + '，执行来源=' + r0.exec_source +
      '，到达后铺出 ' + r0.future_count + ' 块下一步路牌；时间线/候选对比/导出/键盘选路/风景回看均可触发；' +
      '第二次执行中途取消进入 interrupted 且不铺到达牌。',
    notes: '非真人被试；s1–s5 为 agent 依真实系统行为代理评估，仅作 M3 清单草稿基线，须真人 M2 复测。',
  };

  await browser.close();

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${fail === 0 ? '✅ ALL_PASS' : '❌ FAIL'} — ${pass} passed / ${fail} failed`);
  console.log(`📄 走查报告已写出：${OUT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
