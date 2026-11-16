const { resolveChromePath } = require('./chrome_helper');
// 验证本轮重点：路牌为主、风景退为背景；路牌更近更大
//  A. 路牌明显比风景更「重」：未来牌不透明度(0.92) > 风景图卡不透明度(0.38)，且风景图卡更少、更小、renderOrder 更低
//  B. 路牌更近更大：未来牌起点 5.5m（原 8.0），牌面 width 明显大于风景图卡 scale；
//     （到达牌侧移已在「UX 五修」取消，改为钉在路面中心线上，故此处断言 0；由 test_ux_fixes5.js 复核）
// 用法：node test_ux_fixes4.js   （需 8770 与 8083 在线）
const { chromium } = require('playwright-core');

const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && typeof window.__cockpit.camYaw === 'number', null, { timeout: 20000 });

  // 发任务并真实执行，直到出现到达牌 + 未来牌
  await page.fill('#msgInput', '请分析国内电力交易市场的格局，并查资料说明现货与中长期交易的区别');
  await page.click('#sendBtn');
  await page.waitForFunction(() => {
    const s = window.__cockpit.signs;
    return s && s.some(b => b.userData && b.userData.branchId >= 0);
  }, null, { timeout: 60000 });

  const picked = await page.evaluate(async () => {
    const signs = window.__cockpit.signs;
    const idx = signs.findIndex(b => b.userData && b.userData.branchId >= 0 &&
      /查|资料|检索|搜索/.test(b.userData.label || ''));
    const use = idx >= 0 ? idx : signs.findIndex(b => b.userData && b.userData.branchId >= 0);
    const b = signs[use];
    const p = b.position;
    const sp = window.__cockpit.projectToScreen(p.x, p.y, p.z);
    return { x: sp.x, y: sp.y };
  });
  await page.mouse.dblclick(picked.x, picked.y);
  await page.waitForFunction(() => {
    const clar = document.querySelector('#rcAnswerInput');
    return (clar && clar.offsetParent !== null) || window.__cockpit.hasArrival;
  }, null, { timeout: 120000 });
  const clarVisible = await page.evaluate(() => {
    const c = document.querySelector('#rcAnswerInput');
    return c && c.offsetParent !== null;
  });
  if (clarVisible) {
    await page.fill('#rcAnswerInput', '请聚焦现货和中长期两类');
    await page.click('#rcAnswerBtn');
  }
  await page.waitForFunction(() => window.__cockpit.hasArrival, null, { timeout: 120000 });
  // 等真实未来牌（-3..-7）出现
  await page.waitForFunction(() => {
    const fs = window.__cockpit.futureSigns || [];
    return fs.length > 0;
  }, null, { timeout: 60000 });
  await sleep(2500); // 等风景重建

  const data = await page.evaluate(() => ({
    arrivalSideOffset: window.__cockpit.arrivalSideOffset,
    futureStartDist: window.__cockpit.futureStartDist,
    sceneryBaseOpacity: window.__cockpit.sceneryBaseOpacity,
    futureSignOpacity: window.__cockpit.futureSignOpacity,
    scnLabelMax: window.__cockpit.scnLabelMax,
    sceneryCards: window.__cockpit.sceneryCards,
    scenerySample: window.__cockpit.scenerySample,
    futureSigns: window.__cockpit.futureSigns,
  }));

  const fsOpacity = data.futureSignOpacity;                 // 0.92
  const scOpacity = data.sceneryBaseOpacity;                // 0.38
  const fsWidth = data.futureSigns.length ? data.futureSigns[0].width : null;  // 3.2
  const scScaleX = data.scenerySample.length ? data.scenerySample[0].scaleX : null;  // 1.9
  const scRender = data.scenerySample.length ? data.scenerySample[0].renderOrder : null; // 1

  // 断言
  const PASS_A = fsOpacity > scOpacity + 0.3 &&           // 路牌明显比风景亮
                 data.sceneryCards <= data.scnLabelMax && // 风景图卡受上限约束
                 scRender < 20;                           // 风景永远被路牌（20/30）盖在上层
  const PASS_B = data.arrivalSideOffset === 0 &&         // 五修：到达牌回到路面中心线，不再侧移
                 data.futureStartDist === 5.5 &&
                 fsWidth !== null && scScaleX !== null &&
                 fsWidth > scScaleX * 1.4;                // 路牌牌面比风景图卡大

  console.log('=== A. 路牌为主 / 风景退背景 ===');
  console.log('  未来牌不透明度 =', fsOpacity, ' 风景图卡不透明度 =', scOpacity);
  console.log('  风景图卡数 =', data.sceneryCards, ' / 上限', data.scnLabelMax);
  console.log('  风景图卡 renderOrder =', scRender, ' (路牌=20/30)');
  console.log('  A PASS =', PASS_A);
  console.log('=== B. 路牌更近更大 ===');
  console.log('  到达牌侧移 =', data.arrivalSideOffset, 'm   (五修后回 midline，原 4.0/6.0)');
  console.log('  未来牌起点 =', data.futureStartDist, 'm   (上版 8.0)');
  console.log('  未来牌 width =', fsWidth, '  风景图卡 scaleX =', scScaleX);
  console.log('  B PASS =', PASS_B);
  console.log('=== JS 错误 ===');
  console.log('  count =', errors.length, errors.slice(0, 5));
  console.log('=== 结论 ===');
  console.log('  OVERALL =', (PASS_A && PASS_B && errors.length === 0) ? 'ALL_PASS' : 'FAIL');

  await browser.close();
  process.exit((PASS_A && PASS_B && errors.length === 0) ? 0 : 1);
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
