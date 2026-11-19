const { resolveChromePath } = require('./chrome_helper');
// v0.9.28 真·轨道相机回归：机位 = 沿「已走过轨道折线」回退 cam.dist 的小车。
// 旧版直线后挂：拐弯处切出弯道外侧、末段短于 11m 时越过上一节点飘到空处（用户看到的「脱轨」）。
// 本脚本驱动多段带拐弯的真实行驶，断言全程 camOffRail≈0、短段被夹到轨道起点、眼位钉死、0 JS 错误。
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// v0.9.32 时序修复：driveTo 的 Promise resolve 后，F3.6b 行驶颠簸
//   (animate: isDriving 时 camera.position.y += sin(t*18)*bob) 可能仍在最后一帧里，
//   导致 eyeY 在 1.30~1.34 抖动、offRail 断言漂移。落位本身是瞬时的（无阻尼收敛），
//   真正的收敛信号是 isDriving=false。等它稳定后再等两帧渲染循环应用非颠簸位置。
//   注意：等的是「行驶状态」信号，不是 eyeY 断言值本身——不构成循环论证。
async function settle(page) {
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.isDriving === false,
    null, { timeout: 15000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpit.railCameraProbe, null, { timeout: 20000 });
    await sleep(600);

    // 起点通常无轨道 → 直线回退兜底（不变量仍成立）
    const p0 = await page.evaluate(() => window.__cockpit.railCameraProbe());
    ok('起点无轨道时回退直线公式（onRail=false）', p0.onRail === false, p0);
    ok('兜底态 camOffRail≈0', p0.offRail < 1e-6, p0.offRail);

    // 依次真实行驶三段，形成一个带拐弯的折线轨道：
    //   (0,0) → (12,0) → (12,12) → (4,12)   （末段 8m < cam.dist 11m，验证不越界夹取）
    const waypoints = [[12, 0, 0], [12, 0, 12], [4, 0, 12]];
    for (const wp of waypoints) {
      await page.evaluate(async (w) => { await window.__cockpit._driveTo(w); }, wp);
      await settle(page);   // 等行驶结束 + 颠簸停 + 两帧渲染；替代旧 sleep(120) 的时序竞态
      const p = await page.evaluate(() => window.__cockpit.railCameraProbe());
      ok('行驶到 ' + JSON.stringify(wp) + ' 后机位贴轨 camOffRail≈0', p.offRail < 1e-3, p);
      ok('  眼位钉死 1.35m', Math.abs(p.eyeY - 1.35) < 0.06, p.eyeY);
    }

    // 终态：轨道已成型（>=3 节点），机位应处于 rail 上
    const pf = await page.evaluate(() => window.__cockpit.railCameraProbe());
    ok('轨道已成型（railPoints>=3）', pf.railPoints >= 3, pf);
    ok('终态机位在轨道折线上（onRail=true）', pf.onRail === true, pf);
    ok('回退弧长不超过轨道总长', pf.arcBack <= pf.railLen + 1e-6, pf);
    // 末段 8m，之前还有 24m → 11m 回退落在第二段拐弯处；摄像机水平位置须与轨道取点一致
    ok('摄像机水平位置 = 轨道回退取点', Math.hypot(pf.camPos[0]-pf.railCamXZ[0], pf.camPos[2]-pf.railCamXZ[1]) < 1e-6, pf);

    // 自由拖拽视线不得移动机位（机位只由路决定）
    const before = await page.evaluate(() => window.__cockpit.railCameraProbe().camPos);
    const box = await page.locator('canvas').boundingBox();
    const cx = box.x + box.width/2, cy = box.y + box.height/2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    for (let i=1;i<=10;i++) await page.mouse.move(cx + i*14, cy);
    await page.mouse.up(); await sleep(300);
    const after = await page.evaluate(() => window.__cockpit.railCameraProbe().camPos);
    ok('拖拽视线机位零位移', Math.hypot(after[0]-before[0], after[2]-before[2]) < 0.02, {before, after});

    ok('0 JS 错误', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
  }
  console.log(`\nresult: ${pass}/${pass+fail} passed ${fail === 0 ? '=> ALL_PASS' : '=> FAIL'}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
