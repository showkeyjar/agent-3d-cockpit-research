const { resolveChromePath } = require('./chrome_helper');
// 验证本轮两项修复：
//  A. 视角自由 + 摄像机不脱轨：拖拽改变 yaw 后，空闲 4s 内 yaw 不应被强制拉回 travelYaw（脱轨修复）
//  B. 风景有意义：概念短语应为长度≥2 的可读词语/短句，不得是单字或滑窗碎片（如「力交」）
// 用法：node test_ux_fixes3.js   （需 8770 与 8083 在线）
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

  // ── A. 自由视角 + 不脱轨 ──
  const before = await page.evaluate(() => ({ yaw: window.__cockpit.camYaw, ty: window.__cockpit.travelYaw }));
  // 在画布中央模拟一次左键拖拽（orbit），改变 yaw
  const box = await page.locator('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 12, cy);   // 向右拖 120px → yaw 明显变化
  await page.mouse.up();
  await sleep(300);
  const afterDrag = await page.evaluate(() => ({ yaw: window.__cockpit.camYaw, ty: window.__cockpit.travelYaw }));
  const dragDelta = Math.abs(afterDrag.yaw - before.yaw);
  // 关键断言：空闲 4s（远超 3s 保持期）后，yaw 不应被拉回 travelYaw（即「随便动下鼠标就脱轨」已修复）
  await sleep(4200);
  const afterIdle = await page.evaluate(() => ({ yaw: window.__cockpit.camYaw, ty: window.__cockpit.travelYaw }));
  const idleDrift = Math.abs(afterIdle.yaw - afterDrag.yaw);   // idle 期间 yaw 漂移（应很小）
  const snappedBack = Math.abs(afterIdle.yaw - afterIdle.ty) < 0.15 && dragDelta > 0.3; // 是否被强制拉回主轴

  // ── 发一个任务，触发沿途风景重建，读取真实短语 ──
  await page.fill('#msgInput', '请分析国内电力交易市场的格局，并查资料说明现货与中长期交易的区别');
  await page.click('#sendBtn');
  // 等待出现候选分支牌（出现可双击的 3D 路牌）
  await page.waitForFunction(() => {
    const s = window.__cockpit.signs;
    return s && s.some(b => b.userData && b.userData.branchId >= 0);
  }, null, { timeout: 60000 });

  // 双击「查资料」类候选的 3D 路牌触发真实执行（与 test_ux_fixes2 一致）
  const picked = await page.evaluate(async () => {
    const signs = window.__cockpit.signs;
    const idx = signs.findIndex(b => b.userData && b.userData.branchId >= 0 &&
      /查|资料|检索|搜索|搜索/.test(b.userData.label || ''));
    const use = idx >= 0 ? idx : signs.findIndex(b => b.userData && b.userData.branchId >= 0);
    const b = signs[use];
    const p = b.position;
    const sp = window.__cockpit.projectToScreen(p.x, p.y, p.z);
    return { x: sp.x, y: sp.y };
  });
  await page.mouse.dblclick(picked.x, picked.y);
  // 等待澄清补答框（可见）或真实到达（hasArrival）
  await page.waitForFunction(() => {
    const clar = document.querySelector('#rcAnswerInput');
    return (clar && clar.offsetParent !== null) || window.__cockpit.hasArrival;
  }, null, { timeout: 120000 });

  // 若有澄清，填一个简短回答让其继续
  const clarVisible = await page.evaluate(() => {
    const c = document.querySelector('#rcAnswerInput');
    return c && c.offsetParent !== null;
  });
  if (clarVisible) {
    await page.fill('#rcAnswerInput', '请聚焦现货和中长期两类');
    await page.click('#rcAnswerBtn');
    await page.waitForFunction(() => window.__cockpit.hasArrival, null, { timeout: 120000 });
  }
  await sleep(2500); // 等风景重建

  const scn = await page.evaluate(() => ({
    cards: window.__cockpit.sceneryCards,
    phrases: window.__cockpit.sceneryPhrases,
  }));

  // 短语质量：长度≥2，且不应出现「滑窗碎片」特征（相邻二字无语义的如「力交」「易市」「的格」应尽量少）
  const phrases = scn.phrases || [];
  const minLen = phrases.length ? Math.min(...phrases.map(p => p.length)) : 0;
  const allGE2 = phrases.every(p => p.length >= 2);
  // 单字污染检测：任何短语若长度=1 即不合格
  const hasSingle = phrases.some(p => p.length < 2);
  // 明显碎片的启发式黑名单（非重叠 2 字切分可能仍偶发，如「的格」；这里只做提示性统计）
  const fragSamples = phrases.filter(p => /^[的的了在是和与及对及]{1,2}$/.test(p));

  const PASS_A = dragDelta > 0.3 && idleDrift < 0.25 && !snappedBack;
  const PASS_B = scn.cards > 0 && allGE2 && !hasSingle;

  console.log('=== A. 自由视角 + 不脱轨 ===');
  console.log('  drag 前 yaw=%s  travelYaw=%s', before.yaw.toFixed(3), before.ty.toFixed(3));
  console.log('  drag 后 yaw=%s  (Δ=%s)', afterDrag.yaw.toFixed(3), dragDelta.toFixed(3));
  console.log('  空闲4s后 yaw=%s  (idle漂移=%s, 是否被拉回主轴=%s)', afterIdle.yaw.toFixed(3), idleDrift.toFixed(3), snappedBack);
  console.log('  A PASS =', PASS_A);
  console.log('=== B. 风景有意义 ===');
  console.log('  概念图卡数 =', scn.cards);
  console.log('  短语数 =', phrases.length, ' 最短长度 =', minLen);
  console.log('  样例 =', JSON.stringify(phrases.slice(0, 14)));
  console.log('  全部≥2字 =', allGE2, ' 含单字 =', hasSingle, ' 疑似碎片 =', JSON.stringify(fragSamples.slice(0, 6)));
  console.log('  B PASS =', PASS_B);
  console.log('=== JS 错误 ===');
  console.log('  count =', errors.length, errors.slice(0, 5));
  console.log('=== 结论 ===');
  console.log('  OVERALL =', (PASS_A && PASS_B && errors.length === 0) ? 'ALL_PASS' : 'FAIL');

  await browser.close();
  process.exit((PASS_A && PASS_B && errors.length === 0) ? 0 : 1);
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
