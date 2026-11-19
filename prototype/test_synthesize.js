/* v0.9.35 回归：多轮成果综合成最终答案（发现1）
   1) 素材收集：只取 status=done && source=llm && !decorative && output 非空；去重
   2) startSynthesize：发 WS refine mode=synthesize，prior_output 含所有真实轮原文、被截断保护
   3) 综合结果渲染：injectRefineDone(mode=synthesize) → synthDetail 标记 synthesized、chain=synthesize、
      无单一父轮、不新铺到达牌、不改机位
   4) 无真实成果时不发起；decorative 轮不混入素材
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
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.startSynthesizeForTest, null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

  // 1) 空账本：无素材
  let parts = await page.evaluate(() => window.__cockpit.synthReadyParts);
  check('空账本：无素材', parts.length === 0, parts);

  // 2) 铺多轮：真 done / 重复真 done / partial / clarify / local / decorative
  await page.evaluate(() => {
    const c = window.__cockpit;
    const base = { mode:'choice', label:'起草', idx:0, context:'起草一份协作指南' };
    c._recordRun({ ...base, ok:true, source:'llm', output:'成果甲：代码评审条款ABC', completion:'achieved' }, 'done');
    c._recordRun({ ...base, ok:true, source:'llm', output:'成果甲：代码评审条款ABC', completion:'achieved' }, 'done'); // 重复
    c._recordRun({ ...base, ok:true, source:'llm', output:'成果乙：文档更新要点DEF', completion:'achieved' }, 'done');
    c._recordRun({ ...base, ok:true, source:'llm', output:'', clarify:true, completion:'need_input' }, 'clarify');
    c._recordRun({ ...base, ok:false, source:'local', output:'', completion:'partial' }, 'failed');
    c._recordRun({ ...base, ok:true, source:'llm', output:'演示假成果XYZ', completion:'achieved', decorative:true }, 'done');
  });
  parts = await page.evaluate(() => window.__cockpit.synthReadyParts);
  check('素材只收真实 done 且去重（应为2条：甲+乙）', parts.length === 2, parts);
  check('素材不含 decorative 演示成果', !parts.some(p => p.len === '演示假成果XYZ'.length), parts);

  // 3) 发起 synthesize：桩 WS 后观察出站（页面 WS 握手可能未就绪，_stubWs 只记录不外发）
  await page.evaluate(() => { window.__cockpit.wsLog.length = 0; window.__cockpit._stubWs(true); });
  const start = await page.evaluate(() => window.__cockpit.startSynthesizeForTest());
  check('startSynthesize 标记 busy/pending', start.busy === true && start.pending === true, start);
  const log = await page.evaluate(() => window.__cockpit.wsLog);
  const synthMsg = log.find(m => m.type === 'refine' && m.mode === 'synthesize');
  check('发出 refine/synthesize WS', !!synthMsg, log.map(m=>({type:m.type,mode:m.mode})));
  check('WS prior_output 含两条真实成果',
    synthMsg && /成果甲/.test(synthMsg.prior_output) && /成果乙/.test(synthMsg.prior_output),
    synthMsg && synthMsg.prior_output.slice(0, 200));
  check('WS prior_output 不含演示假成果',
    synthMsg && !/演示假成果/.test(synthMsg.prior_output), synthMsg && synthMsg.prior_output.slice(0, 200));
  check('WS context 为用户原问题', synthMsg && /协作指南/.test(synthMsg.context), synthMsg && synthMsg.context);

  // 4) 注入综合结果 → 渲染 synthDetail
  const beforeRuns = await page.evaluate(() => window.__cockpit.runs.length);
  const beforeSigns = await page.evaluate(() => window.__cockpit.arrivalSigns.length);
  const synthOut = '这是综合两份真实成果后的最终答案正文，结构清晰、可直接带走。'.repeat(4);
  const synth = await page.evaluate((out) => {
    const r = window.__cockpit._injectRefineDone({ mode:'synthesize', output:out, completion:'achieved' });
    return { r, detail: window.__cockpit.synthDetail,
             runs: window.__cockpit.runs.length, signs: window.__cockpit.arrivalSigns.length,
             pending: window.__cockpit.synthPending };
  }, synthOut);
  check('综合结果入账本 +1 轮', synth.runs === beforeRuns + 1, { before:beforeRuns, after:synth.runs });
  check('综合结果标记 synthesized', synth.detail.synthesized === true, synth.detail);
  check('综合结果 chain=synthesize', synth.detail.chain[0] === 'synthesize', synth.detail.chain);
  check('综合结果 label=综合最终答案', /综合最终答案/.test(synth.detail.label), synth.detail.label);
  check('综合结果无单一父轮', synth.r.lastParent === null, synth.r.lastParent);
  check('综合 pending 复位', synth.pending === false, synth.pending);
  check('综合结果不新铺到达牌', synth.signs === beforeSigns, { before:beforeSigns, after:synth.signs });
  check('综合结果正文完整', synth.detail.outputLen === synthOut.length, { got:synth.detail.outputLen, expect:synthOut.length });

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== v0.9.35 多轮综合答案回归 ===');
  results.forEach(x => console.log((x.ok ? '✅' : '❌') + ' ' + x.name + (x.ok ? '' : ' → ' + JSON.stringify(x.detail))));
  const pass = results.every(x => x.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
