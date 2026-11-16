const { resolveChromePath } = require('./chrome_helper');
// 复现用户现场：任务"国内电力交易市场的格局？" → 点"查资料" → 看第二阶段路牌
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERR: ' + e.message));

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, null, { timeout: 20000 });

  // 1) 输入任务
  await page.fill('#msgInput', '国内电力交易市场的格局？');
  await page.click('#sendBtn');

  // 2) 等候选牌
  await page.waitForFunction(() => window.__cockpit.candidates.length > 0, null, { timeout: 60000 });
  const cands = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  let idx = cands.findIndex(l => (l || '').includes('查资料'));
  if (idx < 0) idx = 0;
  console.log('候选:', JSON.stringify(cands), '| 选 idx=', idx, '(', cands[idx], ')');

  // 3) 双击"查资料"牌（真实用户动作 → startExecution(idx)）
  const pos = await page.evaluate((idx) => {
    const s = window.__cockpit.signs.find(x => x.userData && x.userData.branchId === idx);
    if (!s) return null;
    const v = new window.__cockpit.THREE.Vector3();
    s.getWorldPosition(v);
    return window.__cockpit.projectToScreen(v.x, v.y, v.z);
  }, idx);
  console.log('查资料牌屏幕坐标:', JSON.stringify(pos));
  if (!pos) { console.log('!! 找不到查资料牌，改为直接 startExecution'); }
  else { await page.mouse.dblclick(pos.x, pos.y); }

  // 4) 等结果卡出现（clarify 也会弹卡）
  await page.waitForFunction(
    () => document.getElementById('resultCard') && document.getElementById('resultCard').classList.contains('show'), null,
    { timeout: 120000 }
  );

  const state1 = await page.evaluate(() => {
    const card = document.getElementById('resultCard');
    const q = document.getElementById('rcQuestionBig');
    const signs = window.__cockpit.signs || [];
    let fut = 0, cand = 0, arr = 0;
    signs.forEach(s => {
      const b = s.userData && s.userData.branchId;
      if (b === undefined) return;
      if (b <= -3) fut++; else if (b === -2) arr++; else if (b >= 0) cand++;
    });
    return {
      isClarify: card.classList.contains('clarify'),
      cardShown: card.classList.contains('show'),
      question: q ? q.textContent : null,
      counts: { future: fut, candidate: cand, arrival: arr },
      hasArrival: window.__cockpit.hasArrival,
    };
  });
  console.log('=== 点击查资料后（未回答）===');
  console.log(JSON.stringify(state1, null, 2));

  // 5) 若是 clarify，测试"回答后能否出第二阶段路牌"
  let state2 = null;
  if (state1.isClarify) {
    await page.fill('#rcAnswerInput', '请从市场规模、参与主体、交易品种（中长期/现货/辅助服务）三个维度梳理。');
    await page.click('#rcAnswerBtn');
    // 等第二轮执行结果卡
    await page.waitForFunction(
      () => {
        const c = document.getElementById('resultCard');
        return c && c.classList.contains('show') &&
               !c.classList.contains('clarify'); // 第二轮应不再是 clarify
      }, null,
      { timeout: 120000 }
    ).catch(() => {});
    await page.waitForTimeout(3000);
    state2 = await page.evaluate(() => {
      const signs = window.__cockpit.signs || [];
      let fut = 0, cand = 0, arr = 0;
      signs.forEach(s => {
        const b = s.userData && s.userData.branchId;
        if (b === undefined) return;
        if (b <= -3) fut++; else if (b === -2) arr++; else if (b >= 0) cand++;
      });
      return { counts: { future: fut, candidate: cand, arrival: arr } };
    });
    console.log('=== 回答后第二轮 ===');
    console.log(JSON.stringify(state2, null, 2));
  }

  console.log('=== 控制台尾部 ===');
  console.log(logs.slice(-25).join('\n'));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
