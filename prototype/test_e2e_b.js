// 临时变体（路线B验证用）：不要求「查资料」类候选，直接走第一个候选
// 验证：双击第0站 → 单步真流式执行 → 到达牌 → 结果卡（真实内容）→ 未来路牌 → 解释卡
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const settle = async (page, getter) => {
  for (let i = 0; i < 20; i++) {
    const s1 = await page.evaluate(getter);
    await page.waitForTimeout(400);
    const s2 = await page.evaluate(getter);
    if (s1 && s2 && Math.abs(s1.x - s2.x) < 1 && Math.abs(s1.y - s2.y) < 1) return s1;
  }
  return null;
};

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForTimeout(9000);

  const candidates = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  const mode = await page.evaluate(() => window.__cockpit.mode);
  console.log('模式:', mode, '候选:', JSON.stringify(candidates));
  const idx = candidates.length ? 0 : -1;
  if (idx < 0) { console.log('FAIL: 无候选'); await browser.close(); process.exit(1); }

  await page.evaluate(() => window.__cockpit.resetCamera());
  await page.waitForTimeout(2000);
  const signPos = await page.evaluate((i) => {
    const p = window.__cockpit.positions[i];
    if (!p) return null;
    return window.__cockpit.projectToScreen(p[0], p[1] + 2.9, p[2]);
  }, idx);
  if (!signPos) { console.log('FAIL: 第0站投影失败'); await browser.close(); process.exit(1); }
  console.log('第0站屏幕坐标:', JSON.stringify(signPos));
  await page.mouse.click(signPos.x, signPos.y, { clickCount: 2, delay: 120 });

  let chain = false;
  for (let round = 0; round < 15; round++) {
    await page.waitForTimeout(20000);
    const st = await page.evaluate(() => ({
      arrival: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
      dbg: window.__cockpit.seqDebug.slice(-2),
    }));
    if (st.arrival > 0) { chain = true; break; }
    if (round % 3 === 0) console.log(`  ...等待到达牌 (${round * 20}s) dbg=${JSON.stringify(st.dbg)}`);
  }
  console.log('顺序链走完:', chain);

  const post = await page.evaluate(() => ({
    arrivalSigns: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
    futureSigns: window.__cockpit.signs.filter(s => s.userData.branchId <= -3).length,
    hasArrival: window.__cockpit.hasArrival,
  }));
  console.log('链条状态:', JSON.stringify(post));

  const rp = await settle(page, () => {
    const sign = window.__cockpit.signs.find(s => s.userData.branchId === -2);
    if (!sign) return null;
    return window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
  });
  if (!rp) { console.log('FAIL: 到达牌投影不稳定'); }
  else {
    await page.mouse.click(rp.x, rp.y);
    await page.waitForTimeout(1500);
    const rc = await page.evaluate(() => ({
      shown: document.getElementById('resultCard').classList.contains('show'),
      title: document.getElementById('rcTitle').textContent,
      output: document.getElementById('rcOutput').textContent.slice(0, 80),
      src: document.getElementById('rcSource').textContent,
    }));
    console.log('① 结果卡:', JSON.stringify(rc));
  }

  // 收起结果卡 + 挑一块 pickAt 实际命中的未来牌（首块可能被当前候选牌遮挡）
  const rcOpen = await page.evaluate(() => document.getElementById('resultCard').classList.contains('show'));
  if (rcOpen) { await page.click('#rcClose'); await page.waitForTimeout(600); }
  let fp = null;
  for (let attempt = 0; attempt < 40 && !fp; attempt++) {
    fp = await page.evaluate(() => {
      const signs = window.__cockpit.signs.filter(s => s.userData.branchId <= -3);
      for (const s of signs) {
        const p = window.__cockpit.projectToScreen(s.position.x, s.position.y, s.position.z);
        if (p && window.__cockpit.pickAt(p.x, p.y) <= -3) return { x: p.x, y: p.y };
      }
      return null;
    });
    if (!fp) await page.waitForTimeout(500);
  }
  if (!fp) { console.log('FAIL: 未来路牌投影不稳定'); }
  else {
    await page.mouse.click(fp.x, fp.y);
    await page.waitForTimeout(2500);
    const ec = await page.evaluate(() => ({
      shown: document.getElementById('explainCard')?.classList.contains('show'),
      title: document.getElementById('ecTitle')?.textContent,
    }));
    console.log('② 解释卡:', JSON.stringify(ec));
  }

  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  console.log('E2E-B DONE');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
