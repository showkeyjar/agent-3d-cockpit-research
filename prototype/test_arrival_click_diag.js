/* 诊断问题 3：到达牌点击命中判定。
   走一次真实起草执行（门控后 ~5s 直达 done），拿到达牌：
   1) 局部坐标 vs 世界坐标投影的差异
   2) rayHitsAt(世界坐标投影) 是否命中 branchId=-2
   3) 点开后 shown 状态（自动展示 + toggle 是否导致 shown=false）
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const TASK = '起草一份面向新同事的团队协作指南，涵盖代码评审、文档更新、问题响应三个方面，直接给出可执行的具体条款';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, null, { timeout: 20000 });

  await page.fill('#msgInput', TASK);
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__cockpit.candidates.length > 0, null, { timeout: 60000 });
  // 点第一条路执行
  await page.evaluate(() => { window.__cockpit._kbNav(0); window.__cockpit._kbGo(); });
  await page.waitForFunction(() => {
    const c = window.__cockpit || {};
    const rs = c.runs || [];
    return c.execState && c.execState.done && rs.length >= 1 &&
      ['done', 'failed', 'interrupted', 'clarify'].includes(rs[rs.length - 1].status);
  }, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2000); // 等到达落位

  const diag = await page.evaluate(() => {
    const c = window.__cockpit;
    const sign = (c.signs || []).find(x => x.userData.branchId === -2);
    if (!sign) return { err: 'no arrival sign', signs: (c.signs||[]).map(s => s.userData.branchId) };
    const v = new c.THREE.Vector3();
    sign.getWorldPosition(v);
    const worldProj = c.projectToScreen(v.x, v.y, v.z);
    const localProj = c.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
    const hits = c.rayHitsAt(worldProj.x, worldProj.y);
    return {
      worldPos: v.toArray(), localPos: sign.position.toArray(),
      worldProj, localProj,
      deltaPx: Math.round(Math.hypot(worldProj.x - localProj.x, worldProj.y - localProj.y)),
      hits,
      cardOpenBefore: c.resultCardOpen,
    };
  });
  console.log('=== 到达牌诊断 ===');
  console.log(JSON.stringify(diag, null, 2));

  // 点世界坐标投影处，看 toggle 行为
  if (diag.worldProj) {
    const before = await page.evaluate(() => window.__cockpit.resultCardOpen);
    await page.mouse.click(diag.worldProj.x, diag.worldProj.y);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      open: window.__cockpit.resultCardOpen,
      outLen: document.getElementById('rcOutput')?.textContent?.length || 0,
    }));
    console.log('=== 点击世界投影点 ===');
    console.log(JSON.stringify({ before, after }, null, 2));
  }
  console.log('JS错误:', errors.length ? errors.slice(0,3) : '无');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
