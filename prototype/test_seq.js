// 顺序链完整链路测试：提问 → 双击第 0 站 → 监控推进 → 到达牌 + 未来路牌
// 同时打印 _seqDebugLog 时间线，判断「慢」还是「卡死」
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const ready = await page.evaluate(() => !!window.__cockpit);
  console.log('调试导出就绪:', ready);
  if (!ready) { console.log('FAIL: 页面未初始化'); await browser.close(); process.exit(1); }

  // 提问
  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForTimeout(9000);

  const candidates = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  const mode = await page.evaluate(() => window.__cockpit.mode);
  console.log('模式:', mode);
  console.log('候选:', JSON.stringify(candidates));

  let idx = candidates.findIndex(l => /查|资料|检索|调研/.test(l));
  if (idx < 0 && candidates.length) idx = 0;  // LLM 候选随机，无查资料类分支时回退首个（执行链一致）
  console.log('选中下标:', idx);
  if (idx < 0) { console.log('FAIL: 无候选'); await browser.close(); process.exit(1); }

  // 归位相机后，在路牌实际屏幕位置双击「第一站」
  await page.evaluate(() => window.__cockpit.resetCamera());
  await page.waitForTimeout(2000);
  // 路牌位置 = 分支位置 y + 2.9（见 applyForecastResult 中 sequential 分支）
  const pos = await page.evaluate((i) => {
    const p = window.__cockpit.positions[i];
    if (!p) return null;
    return window.__cockpit.projectToScreen(p[0], p[1] + 2.9, p[2]);
  }, idx);
  console.log('第0站路牌屏幕坐标:', JSON.stringify(pos));

  if (!pos) { console.log('FAIL: 投影失败'); await browser.close(); process.exit(1); }
  await page.mouse.click(pos.x, pos.y, { clickCount: 2, delay: 120 });
  await page.waitForTimeout(2000);

  const dbg0 = await page.evaluate(() => window.__cockpit.seqDebug);
  console.log('双击后埋点:', JSON.stringify(dbg0));

  // 轮询：等待到达牌，同时每 20s 打印一次埋点时间线
  let arrived = false;
  for (let round = 0; round < 15; round++) {
    await page.waitForTimeout(20000);
    const st = await page.evaluate(() => ({
      hasArrival: window.__cockpit.hasArrival,
      arrivalSigns: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
      futureSigns: window.__cockpit.signs.filter(s => s.userData.branchId <= -3).length,
      futureCand: window.__cockpit.future.length,
      dbg: window.__cockpit.seqDebug,
    }));
    console.log(`\n[${round * 20}s] arrival=${st.hasArrival} arrivalSigns=${st.arrivalSigns} futureSigns=${st.futureSigns} futureCand=${st.futureCand}`);
    console.log('  埋点:', JSON.stringify(st.dbg));
    if (st.arrivalSigns > 0) { arrived = true; break; }
  }

  const arrival = await page.evaluate(() => {
    const c = window.__cockpit;
    return {
      arrivalSignCount: c.signs.filter(s => s.userData.branchId === -2).length,
      futureSignCount: c.signs.filter(s => s.userData.branchId <= -3).length,
      futureCandidates: c.future.length,
      results: Object.keys(c.results),
    };
  });
  console.log('\n最终状态:', JSON.stringify(arrival));
  console.log(arrived ? 'PASS: 顺序链到达牌已出现' : 'FAIL: 300s 内未出现到达牌');
  console.log('JS错误:', errors.length ? errors.slice(0, 5) : '无');
  await browser.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
