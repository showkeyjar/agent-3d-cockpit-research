const { resolveChromePath } = require('./chrome_helper');
// UX 六修验证：结果牌下沉到路面下方 + 比一般路牌小 + 轨道颜色淡化
//  A. 几何：到达牌 y < 节点路面、width < 一般未来牌(3.2)，且仍在屏幕内、位于画面下半部
//  B. 分层：所有未来牌都在结果牌上方；从相机到任一未来牌的射线不再被结果牌(-2)挡住
//  C. 淡化：所有 glowTube 轨道不透明度 <= 0.5 且 >= 0.14（下限保留），颜色亮度系数 0.85
//  D. 可用性：结果牌仍能被射线命中（点击展开结果不失效），0 JS 错误
// 纯前端（setupTestArrival），不依赖 35B，秒级完成。
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/?test=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  try {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpit.arrivalYOffset !== undefined, null, { timeout: 20000 });
    await sleep(500);
    await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
    // 无头首帧可能被阻塞，等落地动画真正收敛而不是死等固定毫秒
    await page.waitForFunction(() => {
      const s = window.__cockpit.signs.filter(x => x.userData.branchId === -2);
      return s.length >= 1 && s.every(x => x.scale.x > 0.98);
    }, null, { timeout: 20000 });
    await sleep(400);   // 让相机跟到新的 currentPos

    const d = await page.evaluate(() => {
      const cp = window.__cockpit, THREE = cp.THREE, camera = cp.camera;
      const cur = cp.curPos;
      const arr = cp.signs.filter(s => s.userData.branchId === -2);
      const fut = cp.signs.filter(s => s.userData.branchId <= -3 && s.userData.branchId !== -9);
      const screen = cp.arrivalScreen;
      const futScreen = fut.map(s => {
        const p = cp.projectToScreen(s.position.x, s.position.y, s.position.z);
        return { id: s.userData.branchId, y: +p.y.toFixed(1) };
      });

      // 射线：从相机指向每块未来牌中心，看是否有别的牌（尤其 -2）挡在前面
      const ray = new THREE.Raycaster();
      const camPos = camera.position.clone();
      const blockedByArrival = fut.filter(s => {
        const wp = s.getWorldPosition(new THREE.Vector3());
        const dist = wp.distanceTo(camPos);
        ray.set(camPos, wp.clone().sub(camPos).normalize());
        ray.far = dist + 0.5;
        const hits = ray.intersectObjects(cp.signs, true);
        for (const h of hits) {
          let root = h.object;
          while (root && root.userData.branchId === undefined) root = root.parent;
          if (!root) continue;
          if (root.userData.branchId !== s.userData.branchId && h.distance < dist - 0.3)
            return root.userData.branchId === -2;
        }
        return false;
      }).map(s => s.userData.branchId);

      // 找一块能真实点中的结果牌（中心或中心附近）
      let hit = null;
      if (screen) {
        for (let dy = -50; dy <= 50 && !hit; dy += 10)
          for (let dx = -50; dx <= 50; dx += 10)
            if (cp.pickAt(screen.x + dx, screen.y + dy) === -2) { hit = { x: screen.x + dx, y: screen.y + dy }; break; }
      }

      return {
        yOffset: cp.arrivalYOffset, width: cp.arrivalSignWidth,
        roadOpacityScale: cp.roadOpacityScale, roadColorScale: cp.roadColorScale,
        nodeY: cur[1],
        arrivalSigns: cp.arrivalSigns,
        futureWidth: fut.length ? fut[0].userData.plane.geometry.parameters.width : null,
        screen, futScreen, blockedByArrival, hit,
        roadTubes: cp.roadTubes,
        offRail: cp.camOffRail,
      };
    });

    const arrY = d.arrivalSigns.length ? d.arrivalSigns[0].y : null;
    const arrW = d.arrivalSigns.length ? d.arrivalSigns[0].width : null;
    const H = 800, W = 1280;

    const PASS_A = d.yOffset < 0 && arrY !== null && Math.abs(arrY - (d.nodeY + d.yOffset)) < 0.02 &&
                   arrW !== null && arrW === d.width && d.width < 3.2 &&
                   d.screen && d.screen.y > H / 2 && d.screen.y < H - 20 &&
                   d.screen.x > 0 && d.screen.x < W;
    const PASS_B = d.futScreen.length > 0 &&
                   d.futScreen.every(f => f.y < d.screen.y) &&
                   d.blockedByArrival.length === 0;
    const PASS_C = d.roadOpacityScale === 0.7 && d.roadColorScale === 0.85 &&
                   d.roadTubes.length > 0 &&
                   d.roadTubes.every(t => t.opacity <= 0.5 && t.opacity >= 0.14 &&
                                          Math.abs(t.opacity - t.base) < 0.002 &&
                                          Math.max(...t.color) <= 0.851);
    const PASS_D = !!d.hit && d.offRail < 0.02 && errors.length === 0;

    console.log('=== A. 结果牌下沉 / 缩小 / 在屏幕下半部 ===');
    console.log('  yOffset =', d.yOffset, ' 节点路面 y =', d.nodeY, ' 牌 y =', arrY);
    console.log('  牌宽 =', arrW, ' (一般未来牌宽 =', d.futureWidth, ')');
    console.log('  屏幕坐标 =', d.screen, ' (中线 y=400)');
    console.log('  A PASS =', PASS_A);
    console.log('=== B. 上下分层 / 未来牌不再被结果牌遮挡 ===');
    console.log('  未来牌屏幕 y =', JSON.stringify(d.futScreen));
    console.log('  被结果牌挡住的未来牌 =', JSON.stringify(d.blockedByArrival));
    console.log('  B PASS =', PASS_B);
    console.log('=== C. 轨道淡化 ===');
    console.log('  scale =', d.roadOpacityScale, ' colorScale =', d.roadColorScale);
    console.log('  tubes =', JSON.stringify(d.roadTubes.slice(0, 8)), ' 共', d.roadTubes.length, '根');
    console.log('  C PASS =', PASS_C);
    console.log('=== D. 仍可点击 / 机位贴轨 / JS 错误 ===');
    console.log('  可命中点 =', JSON.stringify(d.hit), ' camOffRail =', d.offRail, ' errors =', errors.length);
    console.log('  D PASS =', PASS_D);
    const ALL = PASS_A && PASS_B && PASS_C && PASS_D;
    console.log('=== 结论 ===\n  OVERALL =', ALL ? 'ALL_PASS' : 'FAIL');
    process.exit(ALL ? 0 : 1);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
