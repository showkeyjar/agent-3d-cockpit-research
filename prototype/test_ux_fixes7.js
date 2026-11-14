// UX 七修验证：拿到结果后机位沿轨道「停靠到结果牌上方」
//  A. 不变量：机位仍只由 camAnchorYaw 决定，恒在路面中心线正上方（眼位 1.35m），
//     camOffRail≈0；与结果牌的水平间距只沿轨道收近，绝不侧移出轨。
//  B. 停靠：巡航 dist 11 → ARRIVAL_CAM_DIST，结果与「牌沉在路面下」形成上下关系，
//     结果牌完整可见、明显变大（>=1.6×），且位于画面下半部。
//  C. 分层：未来牌全在结果牌上方，且射线不被结果牌遮挡；结果牌仍可点击。
//  D. 稳定：落位后 1.6s 机位/距离零漂移（无回弹）；R 复位仍回到停靠位；0 JS 错误。
// 纯前端（_driveTo 的 arrivalDock 钩子），不依赖 35B，秒级完成。
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function collect(page) {
  return page.evaluate(() => {
    const cp = window.__cockpit, T = cp.THREE, camera = cp.camera;
    const s = cp.signs.filter(x => x.userData.branchId === -2).pop();
    const fut = cp.signs.filter(x => x.userData.branchId <= -3 && x.userData.branchId !== -9);
    const up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const right = new T.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const P = v => { const q = v.clone().project(camera); return { x: (q.x * .5 + .5) * innerWidth, y: (-q.y * .5 + .5) * innerHeight }; };
    const w = s.userData.plane.geometry.parameters.width, h = s.userData.plane.geometry.parameters.height;
    const c = s.position.clone();
    const tl = P(c.clone().addScaledVector(up, h / 2).addScaledVector(right, -w / 2));
    const br = P(c.clone().addScaledVector(up, -h / 2).addScaledVector(right, w / 2));
    const scr = cp.arrivalScreen;
    const camPos = camera.position.clone();
    const cur = cp.curPos;
    const a = cp.camAnchorYaw;
    const fwd = new T.Vector3(Math.cos(a), 0, Math.sin(a));
    const rgt = new T.Vector3(-Math.sin(a), 0, Math.cos(a));
    const rel = c.clone().sub(camPos);
    return {
      dist: cp.camDist, pitch: cp.camPitch, docked: cp.camDocked,
      targetDist: cp.arrivalCamDist, targetPitch: cp.arrivalCamPitch,
      offRail: cp.camOffRail, camY: camPos.y, eye: camPos.y - cur[1], signY: s.position.y,
      gapAlongRail: rel.dot(fwd), gapLateral: rel.dot(rgt),
      screen: { x: +scr.x.toFixed(1), y: +scr.y.toFixed(1) },
      box: { top: +tl.y.toFixed(1), bottom: +br.y.toFixed(1), left: +tl.x.toFixed(1), right: +br.x.toFixed(1),
             h: +(br.y - tl.y).toFixed(1), w: +(br.x - tl.x).toFixed(1) },
      futY: fut.map(x => +P(x.position.clone()).y.toFixed(1)),
      hit: cp.pickAt(scr.x, scr.y),
      camPos: camPos.toArray(),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const errors = [];
  try {
    // ── 基线：巡航态（dist=11）下结果牌的屏幕尺寸 ──
    const p0 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p0.on('pageerror', e => errors.push('baseline pageerror: ' + e.message));
    p0.on('console', m => { if (m.type() === 'error') errors.push('baseline console: ' + m.text()); });
    await p0.goto(URL, { waitUntil: 'load' });
    await p0.waitForFunction(() => window.__cockpit && window.__cockpit.arrivalCamDist !== undefined, { timeout: 20000 });
    await sleep(500);
    await p0.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
    await p0.waitForFunction(() => {
      const s = window.__cockpit.signs.filter(x => x.userData.branchId === -2);
      return s.length && s.every(x => x.scale.x > 0.98);
    }, { timeout: 20000 });
    await sleep(350);
    const base = await collect(p0);
    await p0.close();

    // ── 停靠态：真实走一次 driveTo({arrivalDock:true})，再把场景铺在落点 ──
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('dock pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('dock console: ' + m.text()); });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpit.arrivalCamDist !== undefined, { timeout: 20000 });
    await sleep(500);
    await page.evaluate(async () => { await window.__cockpit._driveTo([8, 0, 8], { arrivalDock: true }); });
    await sleep(250);
    await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
    await page.waitForFunction(() => {
      const s = window.__cockpit.signs.filter(x => x.userData.branchId === -2);
      return s.length && s.every(x => x.scale.x > 0.98);
    }, { timeout: 20000 });
    await sleep(350);
    const d = await collect(page);

    // D. 落位后 1.6s 不回弹
    await sleep(1600);
    const late = await page.evaluate(() => ({ dist: window.__cockpit.camDist, pos: window.__cockpit.camPos,
      offRail: window.__cockpit.camOffRail }));
    const posBounce = Math.hypot(late.pos[0] - d.camPos[0], late.pos[2] - d.camPos[2]);
    const distBounce = Math.abs(late.dist - d.dist);
    // R 复位：应回到「当前状态的家」= 停靠位，而不是把机位甩回 11m
    await page.evaluate(() => window.__cockpit.resetCamera());
    await sleep(700);
    const afterR = await page.evaluate(() => ({ dist: window.__cockpit.camDist, offRail: window.__cockpit.camOffRail }));

    const H = 800;
    const PASS_A = d.offRail < 0.02 && Math.abs(d.eye - 1.35) < 0.05 &&
                   Math.abs(d.gapLateral) < 0.02 &&
                   d.camY > d.signY + 2.0;                    // 机位确实在结果牌「上方」
    const PASS_B = d.docked === true &&
                   Math.abs(d.dist - d.targetDist) < 0.02 && d.dist < base.dist - 3 &&
                   d.box.top > 0 && d.box.bottom < H - 10 &&
                   d.screen.y > H / 2 && d.box.h > base.box.h * 1.6 &&
                   d.gapAlongRail > 0 && d.gapAlongRail < base.dist;
    const PASS_C = d.futY.length > 0 && d.futY.every(y => y < d.box.top) && d.hit === -2;
    const PASS_D = posBounce < 0.02 && distBounce < 0.02 && late.offRail < 0.02 &&
                   Math.abs(afterR.dist - d.targetDist) < 0.05 && afterR.offRail < 0.02 &&
                   errors.length === 0;

    console.log('=== A. 机位仍恒在轨道/道路正上方 ===');
    console.log('  camOffRail =', d.offRail, ' 眼位 =', d.eye.toFixed(3),
      ' 相机y =', d.camY.toFixed(2), ' 结果牌y =', d.signY);
    console.log('  相对结果牌：沿轨 =', d.gapAlongRail.toFixed(2), 'm  横向 =', d.gapLateral.toFixed(4), 'm');
    console.log('  A PASS =', PASS_A);
    console.log('=== B. 到达后停靠到结果牌上方、结果牌变大且完整可见 ===');
    console.log('  巡航 dist =', base.dist, '→ 停靠 dist =', d.dist, '(目标', d.targetDist, ', pitch', d.pitch.toFixed(3), ')');
    console.log('  结果牌屏幕：基线', JSON.stringify(base.box), '→ 停靠', JSON.stringify(d.box));
    console.log('  中心 y =', d.screen.y, '(中线 400)  放大 =', (d.box.h / base.box.h).toFixed(2), '×');
    console.log('  B PASS =', PASS_B);
    console.log('=== C. 上下分层 / 仍可点击 ===');
    console.log('  未来牌屏幕 y =', JSON.stringify(d.futY), ' 结果牌顶 =', d.box.top, ' pickAt(中心) =', d.hit);
    console.log('  C PASS =', PASS_C);
    console.log('=== D. 落位即稳定 / R 复位 / JS 错误 ===');
    console.log('  posBounce =', posBounce.toFixed(4), ' distBounce =', distBounce.toFixed(4),
      ' R 后 dist =', afterR.dist.toFixed(3), ' errors =', errors.length);
    console.log('  D PASS =', PASS_D);
    const ALL = PASS_A && PASS_B && PASS_C && PASS_D;
    console.log('=== 结论 ===\n  OVERALL =', ALL ? 'ALL_PASS' : 'FAIL');
    process.exit(ALL ? 0 : 1);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
