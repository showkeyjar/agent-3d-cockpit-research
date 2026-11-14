// 详细复现：dump 所有牌的 branchId/世界坐标/屏幕坐标，区分真实未来牌与 -9 占位
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERR: ' + e.message));

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, { timeout: 20000 });

  await page.fill('#msgInput', '国内电力交易市场的格局？');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__cockpit.candidates.length > 0, { timeout: 60000 });

  const cands = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  let idx = cands.findIndex(l => (l || '').includes('查资料'));
  if (idx < 0) idx = 1;
  console.log('候选:', JSON.stringify(cands), '选 idx=', idx);

  const pos = await page.evaluate((idx) => {
    const s = window.__cockpit.signs.find(x => x.userData && x.userData.branchId === idx);
    if (!s) return null;
    const v = new window.__cockpit.THREE.Vector3();
    s.getWorldPosition(v);
    return window.__cockpit.projectToScreen(v.x, v.y, v.z);
  }, idx);
  await page.mouse.dblclick(pos.x, pos.y);

  await page.waitForFunction(
    () => document.getElementById('resultCard') && document.getElementById('resultCard').classList.contains('show'),
    { timeout: 120000 }
  );
  await page.waitForTimeout(4000); // 等 autoExploreNext 拉取

  const dump = await page.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const signs = (window.__cockpit.signs || []).map(s => {
      const b = s.userData && s.userData.branchId;
      const v = new window.__cockpit.THREE.Vector3();
      s.getWorldPosition(v);
      const sc = window.__cockpit.projectToScreen(v.x, v.y, v.z);
      return { b, x: Math.round(v.x*10)/10, y: Math.round(v.y*10)/10, z: Math.round(v.z*10)/10,
               sx: Math.round(sc.x), sy: Math.round(sc.y), onScreen: sc.x>=0 && sc.x<=W && sc.y>=0 && sc.y<=H };
    });
    const future = window.__cockpit.future || [];
    return { signCount: signs.length, signs, futureLen: future.length, futureLabels: future.map(f=>f.label),
             hasArrival: window.__cockpit.hasArrival,
             cardClarify: document.getElementById('resultCard').classList.contains('clarify') };
  });
  console.log(JSON.stringify(dump, null, 2));
  console.log('--- logs tail ---');
  console.log(logs.slice(-20).join('\n'));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
