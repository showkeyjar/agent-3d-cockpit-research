const { resolveChromePath } = require('./chrome_helper');
// 确定性点击链路测试：setupTestArrival 搭好场景后，验证
// ① 点到达牌 → 结果卡展开 ② 点每块未来路牌 → 解释卡展开对应内容
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  await page.evaluate(() => { window.__cockpit.resetCamera(); window.__cockpit.setupTestArrival([8, 0, 8]); });
  await page.waitForTimeout(2500);

  // 投影稳定后等待相机静止
  const settle = async (getter, arg) => {
    for (let i = 0; i < 20; i++) {
      const s1 = await page.evaluate(getter, arg);
      await page.waitForTimeout(400);
      const s2 = await page.evaluate(getter, arg);
      if (Math.abs(s1.x - s2.x) < 1 && Math.abs(s1.y - s2.y) < 1) return s1;
    }
    return null;
  };

  // ① 点到达牌 → 结果卡
  const ap = await settle(() => {
    const sign = window.__cockpit.signs.find(s => s.userData.branchId === -2);
    return window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
  });
  if (!ap) { console.log('FAIL: 到达牌投影不稳定'); }
  else {
    const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), ap);
    await page.mouse.click(ap.x, ap.y);
    await page.waitForTimeout(1200);
    const rc = await page.evaluate(() => ({
      shown: document.getElementById('resultCard').classList.contains('show'),
      title: document.getElementById('rcTitle').textContent,
      output: document.getElementById('rcOutput').textContent.slice(0, 40),
    }));
    console.log(`① pickAt=${picked} 点击后结果卡:`, JSON.stringify(rc));
  }

  // 先收起结果卡，避免遮挡（它固定在右侧）
  await page.evaluate(() => document.getElementById('rcClose').click());
  await page.waitForTimeout(300);

  // ② 逐块点击未来路牌 → 解释卡
  const futureCount = await page.evaluate(() => window.__cockpit.signs.filter(s => s.userData.branchId <= -3).length);
  console.log('未来路牌数量:', futureCount);

  for (let i = 0; i < futureCount; i++) {
    const fp = await settle((i) => {
      const signs = window.__cockpit.signs.filter(s => s.userData.branchId <= -3);
      const sign = signs[i];
      if (!sign) return null;
      return window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
    }, i);
    if (!fp) { console.log(`② #${i} FAIL: 投影不稳定`); continue; }
    const before = await page.evaluate(() => document.getElementById('explainCard').classList.contains('show'));
    const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), fp);
    await page.mouse.click(fp.x, fp.y);
    await page.waitForTimeout(800);
    const ec = await page.evaluate(() => ({
      shown: document.getElementById('explainCard').classList.contains('show'),
      title: document.getElementById('ecTitle').textContent,
      head: document.getElementById('ecText').textContent.slice(0, 30),
    }));
    console.log(`② #${i} 屏幕(${Math.round(fp.x)},${Math.round(fp.y)}) pickAt=${picked} 点击后解释卡:`, JSON.stringify(ec));
    // 收起，测下一块
    await page.evaluate(() => document.getElementById('explainCard').classList.remove('show'));
  }

  console.log('JS错误:', errors.length ? errors.slice(0,3) : '无');
  await browser.close();
  console.log('TEST DONE');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
