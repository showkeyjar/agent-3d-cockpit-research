// 验证三项 UX 修复：①镜头 pan 回中 ②节点↔结果「可点可收起」联动（五修后去光柱） ③沿途语义风景
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const TASK = '国内电力交易市场的格局？';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, { timeout: 20000 });

  // 发任务
  await page.fill('#msgInput', TASK);
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__cockpit.candidates.length > 0, { timeout: 60000 });

  // 点「查资料」分支
  const cands = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  let idx = cands.findIndex(l => (l || '').includes('查资料'));
  if (idx < 0) idx = 1;
  const pos = await page.evaluate((idx) => {
    const s = window.__cockpit.signs.find(x => x.userData && x.userData.branchId === idx);
    if (!s) return null;
    const v = new window.__cockpit.THREE.Vector3(); s.getWorldPosition(v);
    return window.__cockpit.projectToScreen(v.x, v.y, v.z);
  }, idx);
  if (!pos) { console.log('FAIL: 找不到候选牌坐标'); await browser.close(); process.exit(1); }
  await page.mouse.dblclick(pos.x, pos.y);

  // 等结果卡出现
  await page.waitForFunction(() => {
    const c = document.getElementById('resultCard');
    return c && c.classList.contains('show');
  }, { timeout: 120000 });
  // 若模型走澄清：补答后重跑，直到拿到真正「到达」（非澄清）的卡再校验联动
  let isClarify = await page.evaluate(() => document.getElementById('resultCard').classList.contains('clarify'));
  if (isClarify){
    await page.fill('#rcAnswerInput', '主要关注电力现货市场的中长期交易与价格形成机制');
    await page.click('#rcAnswerBtn');
    await page.waitForFunction(() => {
      const c = document.getElementById('resultCard');
      return c && c.classList.contains('show') && !c.classList.contains('clarify');
    }, { timeout: 120000 });
  }
  await page.waitForTimeout(1500);

  // ① 镜头回中：等待超过 pan 保持期(3.5s)后，camPan 应回到 ~0
  await page.waitForTimeout(5000);
  const pan = await page.evaluate(() => window.__cockpit.camPan);
  const panMag = Math.hypot(pan[0], pan[1], pan[2]);

  // ② 节点↔结果联动（UX 五修后）：不再用静态光柱宣告「有结果」，
  //    改为结果卡的互动提示条 + 到达牌提示文案「点击收起结果」。
  const link = await page.evaluate(() => ({
    beamCount: window.__cockpit.arrivalBeamCount,
    hint: window.__cockpit.activeArrivalHint,
    interact: (() => { const e = document.getElementById('rcInteract'); return !!e && e.offsetParent !== null; })(),
  }));
  const linkOK = link.beamCount === 0 && link.hint === '点击收起结果' && link.interact;
  const scnNote = await page.evaluate(() => !!document.getElementById('scnNote'));

  // ③ 沿途语义风景：sceneryCount 应 > 0
  const scn = await page.evaluate(() => window.__cockpit.sceneryCount);

  console.log('=== 验证结果 ===');
  console.log(`① 镜头回中  camPan=[${pan.map(n=>n.toFixed(2)).join(', ')}] 模长=${panMag.toFixed(3)}  => ${panMag < 1.0 ? 'PASS（已回中）' : 'FAIL（仍偏移）'}`);
  console.log(`② 联动互动态  beamCount=${link.beamCount} hint=${link.hint} interact=${link.interact}  => ${linkOK ? 'PASS（可点可收起，无静态光柱）' : 'FAIL'}`);
  console.log(`③ 语义风景  sceneryCount=${scn}  scnNote=${scnNote}  => ${scn > 0 && scnNote ? 'PASS（已铺成风景）' : 'FAIL（无风景）'}`);
  console.log(`JS 错误: ${errors.length ? errors.join(' | ') : '无'}`);

  await browser.close();
  const ok = panMag < 1.0 && linkOK && scn > 0 && scnNote && errors.length === 0;
  console.log(ok ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
