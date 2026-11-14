const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => console.log('PAGEERR:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()); });

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#msgInput', { timeout: 30000 });
  await page.fill('#msgInput', '国内电力交易市场的格局？');
  await page.click('#sendBtn');
  await page.waitForSelector('.branch-card', { timeout: 120000 });
  await sleep(800);
  console.log('candidates shown');

  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.branch-card')];
    const t = cards.find(c => /查资料/.test(c.textContent));
    if (t) { t.click(); return true; }
    if (cards[1]) { cards[1].click(); return 'idx1'; }
    return false;
  });
  console.log('clicked:', clicked);

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = await page.evaluate((i) => {
      const ck = window.__cockpit; if (!ck) return { noCockpit: true };
      const rc = document.getElementById('rcAnswerInput');
      const rcard = document.getElementById('resultCard');
      const rcVis = rc ? (rc.offsetParent !== null || rc.getClientRects().length > 0) : false;
      const cardVis = rcard ? (rcard.offsetParent !== null || rcard.getClientRects().length > 0) : false;
      const cardCls = rcard ? rcard.className : '';
      return { t: i, mode: ck.mode, hasArr: ck.hasArrival, future: (ck.future||[]).length,
               cand: (ck.candidates||[]).length, driving: ck.isDriving,
               rcVis, cardVis, cardCls, scn: ck.sceneryCards };
    }, i);
    console.log(JSON.stringify(s));
    if (s.hasArr) { console.log('>>> ARRIVED at i=' + i); break; }
  }
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(2); });
