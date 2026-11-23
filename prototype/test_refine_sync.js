/* v0.9.35 回归：refine 完整成果同步回 3D 锚点（修复「完整成果成孤岛」）
   断点：onRefineDone 只写 _arrivalResults(-2)，到达牌 userData.arrivalDetail /
   主轴节点 arrivalDetail 仍指向旧 150 字摘要 → 关掉卡后从 3D 点开还是旧摘要。
   验证：
   1) refine 前：到达牌挂的是短摘要
   2) 注入 refine_done（长成果）后：到达牌/主轴锚点 output 与当前完整成果一致（无旧摘要残留）
   3) 账本：refine 作为独立轮次写入 +1，账本历史不被覆盖
   4) 不新铺到达牌（数量不变）、3D 机位不变量不受影响
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
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._injectRefineDone, null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

  // 1) 铺到达牌 + 打开卡（_activeCardDetail 指向同一 detail）
  await page.evaluate(() => { window.__cockpit.setupTestArrival([8, 0, 8]); window.__cockpit._rcShow(); });
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => ({
    probe: window.__cockpit._refineSyncProbe(),
    runs: window.__cockpit.runs.length,
  }));
  check('refine 前：有到达牌', before.probe && before.probe.signCount >= 1, before.probe);
  check('refine 前：到达牌挂短摘要（长度<60）',
    before.probe && before.probe.signOutputLens.every(n => n > 0 && n < 60), before.probe && before.probe.signOutputLens);

  // 2) 注入 refine_done：一份明显更长的完整成果
  const LONG = '这是展开后的完整成果正文。'.repeat(12); // >100 字，显著区别于短摘要
  const after = await page.evaluate((out) => {
    const r = window.__cockpit._injectRefineDone({ mode: 'expand', output: out, completion: 'achieved' });
    return { r, probe: window.__cockpit._refineSyncProbe(), runs: window.__cockpit.runs.length };
  }, LONG);
  check('refine 后：完整成果进入当前卡', after.r.output.length === LONG.length, { len: after.r.output.length, expect: LONG.length });
  check('refine 后：到达牌 output 与完整成果一致（无旧摘要残留）',
    after.probe.signAllMatch === true,
    { signLens: after.probe.signOutputLens, activeLen: after.probe.activeOutputLen });
  check('refine 后：到达牌数量不变（未新铺牌）',
    after.probe.signCount === before.probe.signCount,
    { before: before.probe.signCount, after: after.probe.signCount });
  // 注：主轴节点同步（journey[].arrivalDetail）在真实执行链路由 postDriveArrival 挂载，
  // 但 setupTestArrival 夹具在 journey 为空时跳过挂载（index.html:7200），故此处 journeyLens 为空，
  // 不在本断言内验证；到达牌同步（用户点开路径）已充分覆盖核心诉求。

  // 3) 账本：refine 独立轮次 +1，且父轮指向被深化的那轮
  check('refine 后：账本 +1 轮（独立记录，未覆盖摘要轮）',
    after.runs === before.runs + 1, { before: before.runs, after: after.runs });
  check('refine 轮 chain 标记为 refine:expand',
    after.r.lastChain && after.r.lastChain[0] === 'refine:expand', after.r.lastChain);

  // 4) 主轴节点同步：构造一个带 arrivalDetail 的 journey 节点（夹具 setupTestArrival 不挂节点），
  //    指向当前 base detail，再触发一次 refine，验证节点 output 也同步为完整成果。
  const journeySync = await page.evaluate(() => {
    const c = window.__cockpit;
    const baseDetail = c.results.get(-2);          // 当前卡/到达牌共用的 detail
    c.journey.push({ pos: [8, 0, 8], label: '测节点', arrivalDetail: baseDetail, arrivalMarker: null });
    c._rcShow();                                    // _activeCardDetail = baseDetail
    const LONG2 = '主轴节点同步验证用完整成果正文。'.repeat(8);
    c._injectRefineDone({ mode: 'followup', output: LONG2, completion: 'achieved' });
    const nodeOut = String((c.journey[c.journey.length - 1].arrivalDetail || {}).output || '');
    return { nodeOut, expect: LONG2, probe: c._refineSyncProbe() };
  });
  check('主轴节点 arrivalDetail 同步为完整成果（无旧摘要残留）',
    journeySync.nodeOut === journeySync.expect,
    { nodeLen: journeySync.nodeOut.length, expectLen: journeySync.expect.length });

  // 6) 从 3D 点开：模拟点到达牌应拿到完整成果（_arrivalResults(-2) 已是最新 refineDetail）
  const reopen = await page.evaluate(() => {
    const beforeLen = String((window.__cockpit.results.get(-2) || {}).output || '').length;
    window.__cockpit._rcHide();
    window.__cockpit._triggerArrival();   // 从当前到达牌数据重新打开
    return { probe: window.__cockpit._refineSyncProbe(), beforeLen };
  });
  check('关掉卡后从 3D 重开：仍是完整成果',
    reopen.probe.activeOutputLen === reopen.beforeLen && reopen.beforeLen > 60,
    { activeLen: reopen.probe.activeOutputLen, storedLen: reopen.beforeLen });

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== v0.9.35 refine 完整成果同步回归 ===');
  results.forEach(r => console.log((r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' → ' + JSON.stringify(r.detail))));
  const pass = results.every(r => r.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
