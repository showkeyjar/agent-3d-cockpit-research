/* 三轮审查前端回归：断点2/3/4/5/10
   2) onExecuteDone 透传后端 completion → 账本/结果卡用后端判据
   3) refine/synthesize 通道 error/断线/超时复位，不死锁
   4) synthesized 进账本/CSV/summary；collectRealOutputs 排除综合轮
   5) refine 完成后交付/追问入口保留（refine_pending 不再永久隐藏）
   10) clarify 不推进 3D 主轴（journey 不增长）
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
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._injectExecuteDoneForTest,
                             null, { timeout: 20000 });
  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

  // ── 断点2：后端 completion 透传 ──
  const c2 = await page.evaluate(() => {
    const c = window.__cockpit;
    const a = c._injectExecuteDoneForTest({ completion:'need_input', output:'待补输入正文', source:'llm' });
    const b = c._injectExecuteDoneForTest({ completion:'partial', output:'部分产出正文', source:'local' });
    return { a, b };
  });
  check('断点2：execute_done 的 need_input 透传进账本（非 fallback 成 achieved）',
    c2.a.completion === 'need_input', c2.a);
  check('断点2：need_input 同步进结果卡',
    c2.a.cardCompletion === 'need_input', c2.a);
  check('断点2：partial 透传（source=local 不被 fallback 抬高）',
    c2.b.completion === 'partial', c2.b);

  // ── 断点3：refine 通道复位，不死锁 ──
  const c3 = await page.evaluate(() => {
    const c = window.__cockpit;
    c._stubWs(true);
    c._armRefineTimeoutForTest();
    const busyAfterArm = c.refineBusy;
    // 模拟后端 error：走 handleWsMessage 的 error 分支应复位 refine 通道
    c._injectWs({ type:'error', msg:'测试错误' });
    const busyAfterError = c.refineBusy;
    // 再武装一次，直接用复位钩子验证（覆盖断线/超时共用的复位入口）
    c._armRefineTimeoutForTest();
    c._resetRefineBusyForTest();
    const busyAfterReset = c.refineBusy;
    return { busyAfterArm, busyAfterError, busyAfterReset };
  });
  check('断点3：refine 武装后 busy=true',
    c3.busyAfterArm.busy === true, c3.busyAfterArm);
  check('断点3：error 分支复位 refine（busy/pending 均清零）',
    c3.busyAfterError.busy === false && c3.busyAfterError.pending === false, c3.busyAfterError);
  check('断点3：统一复位入口清零 busy',
    c3.busyAfterReset.busy === false && c3.busyAfterReset.pending === false, c3.busyAfterReset);

  // ── 断点4：synthesized 进账本/CSV/summary；素材排除综合轮 ──
  const c4 = await page.evaluate(() => {
    const c = window.__cockpit;
    // 注入一次 synthesize 完成（带 synthesized 标记）
    c._injectRefineDone({ mode:'synthesize', output:'综合终版正文，用于验证导出标记', completion:'achieved' });
    const synthDetail = c.synthDetail;
    const exp = c.exportRunsPreview;
    const synthFlags = exp.synthFlags;
    // 素材收集不应包含 synthesized 轮
    const parts = c.synthReadyParts;
    return { synthDetail, exp, synthFlags, parts };
  });
  check('断点4：synthesize 结果标 synthesized=true',
    c4.synthDetail.synthesized === true, c4.synthDetail);
  check('断点4：导出账本含 exec_synthesized 标记（至少一条）',
    c4.synthFlags.some(f => f.synthesized === true), c4.synthFlags);
  check('断点4：CSV 表头含 exec_synthesized 列',
    c4.exp.csvHasSynthCol === true, c4.exp.csvHasSynthCol);
  check('断点4：summary 统计 synthesize_runs >= 1',
    (c4.exp.summary.synthesize_runs || 0) >= 1, c4.exp.summary);
  // 素材排除综合轮：若综合轮被当素材，parts 会含刚注入的终版文本长度
  const synthLen = '综合终版正文，用于验证导出标记'.length;
  check('断点4：collectRealOutputs 排除 synthesized 轮（终版不混入原始素材）',
    !c4.parts.some(p => p.len === synthLen), c4.parts);

  // ── 断点9（复核补充）：前端消费 material_truncated，不谎称「综合全部轮次」──
  const c9 = await page.evaluate(() => {
    const c = window.__cockpit;
    c._injectRefineDone({ mode:'synthesize', output:'截断后综合的终版正文',
      completion:'partial', material_truncated:true });
    return { note:c.synthDetail.note, detail:c.synthDetail };
  });
  check('断点9：截断时 note 不谎称「综合全部真实成果」',
    !/综合本次旅程全部/.test(c9.note) && /截断/.test(c9.note), c9.note);
  check('断点9：截断时 material_truncated 写入 detail',
    c9.detail.material_truncated === true, c9.detail);

  // ── 断点5：refine 完成后交付/追问入口保留 ──
  const c5 = await page.evaluate(() => {
    const c = window.__cockpit;
    // 先铺一个真实成果卡，确认交付区可见
    c._rcSet({ ok:true, source:'llm', output:'原始成果正文足够长可以用来展开', completion:'achieved', mode:'choice', label:'测试' });
    c._rcShow();
    const before = c.deliverShown;
    // refine 展开后，交付区仍应可见（旧版 refine_pending 会永久隐藏）
    c._injectRefineDone({ mode:'expand', output:'展开后的完整成果正文，足够长', completion:'achieved' });
    const after = c.deliverShown;
    const followBtn = !!(document.getElementById('rcFollowBtn'));
    return { before, after, followBtn };
  });
  check('断点5：refine 前交付区可见', c5.before === true, c5.before);
  check('断点5：refine 后交付区仍可见（追问入口不消失）',
    c5.after === true, c5.after);
  check('断点5：追问按钮存在于 DOM', c5.followBtn === true, c5.followBtn);

  // ── 断点10：clarify 不推进 3D 主轴 ──
  const c10 = await page.evaluate(() => {
    const c = window.__cockpit;
    const clarify = c._finishAtForTest(0, { clarify:true, ok:true, output:'请提供数据' });
    const normal = c._finishAtForTest(1, { clarify:false, ok:true, output:'真实产出' });
    return { clarify, normal };
  });
  check('断点10：clarify 不 push journey（主轴不增长）',
    c10.clarify.jAfter === c10.clarify.jBefore, c10.clarify);
  check('断点10：非 clarify 正常 push journey（对照，主轴 +1）',
    c10.normal.jAfter === c10.normal.jBefore + 1, c10.normal);

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== 三轮审查前端回归（断点2/3/4/5/10）===');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' → ' + JSON.stringify(r.detail))));
  const pass = results.every(r => r.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
