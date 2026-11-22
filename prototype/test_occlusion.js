const { resolveChromePath } = require('./chrome_helper');
// 确定性遮挡诊断：setupTestArrival 搭好「到达牌 + 3 块未来路牌」，
// 用 rayHitsAt 检查每块未来路牌的屏幕坐标实际命中谁 —— 定位「下一步点不动」根因
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/?test=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 确定性搭景：相机归位 + 立到达牌 + 3 块未来路牌
  await page.evaluate(() => {
    window.__cockpit.resetCamera();
    const n = window.__cockpit.setupTestArrival([8, 0, 8]);
    return n;
  });
  // 等相机阻尼到位
  await page.waitForTimeout(2500);

  const camW = await page.evaluate(() => window.__cockpit.cameraWorld());
  console.log('相机世界:', JSON.stringify(camW));

  // 收集所有未来路牌的屏幕坐标 + 命中列表
  const diag = await page.evaluate(() => {
    const out = [];
    window.__cockpit.signs.filter(s => s.userData.branchId <= -3).forEach(sign => {
      const p = window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
      const hits = window.__cockpit.rayHitsAt(p.x, p.y);
      out.push({
        id: sign.userData.branchId,
        screen: { x: Math.round(p.x), y: Math.round(p.y) },
        world: sign.position.toArray().map(v => Math.round(v * 10) / 10),
        hitFirst: hits.length ? hits[0].branchId : null,
        hits,
      });
    });
    return out;
  });

  console.log('=== 未来路牌遮挡诊断 ===');
  let blocked = 0;
  diag.forEach(d => {
    const ok = d.hitFirst === d.id;
    if (!ok) blocked++;
    console.log(`${ok ? '✅' : '❌'} 路牌#${d.id} 屏幕(${d.screen.x},${d.screen.y}) 世界[${d.world}] 首命中=#${d.hitFirst}`);
    d.hits.forEach(h => console.log(`      dist=${h.dist} branchId=${h.branchId} type=${h.type}`));
  });

  // 到达牌的命中情况
  const arrDiag = await page.evaluate(() => {
    const sign = window.__cockpit.signs.find(s => s.userData.branchId === -2);
    const p = window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
    return { screen: { x: Math.round(p.x), y: Math.round(p.y) },
             hits: window.__cockpit.rayHitsAt(p.x, p.y) };
  });
  console.log('=== 到达牌诊断 ===');
  console.log(`到达牌屏幕(${arrDiag.screen.x},${arrDiag.screen.y})`);
  arrDiag.hits.forEach(h => console.log(`      dist=${h.dist} branchId=${h.branchId} type=${h.type}`));

  console.log(blocked === 0 ? 'OCCLUSION_CLEAR' : `OCCLUDED_${blocked}/3`);
  console.log('JS错误:', errors.length ? errors.slice(0,3) : '无');
  await browser.close();
  console.log('TEST DONE');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
