const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const TASK = '国内电力交易市场的格局？';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const dump = async (tag) => {
    try {
      const s = await page.evaluate(() => {
        const ck = window.__cockpit; if (!ck) return { noCockpit: true };
        return { mode: ck.mode, hasArr: ck.hasArrival, future: (ck.future||[]).length,
                 cand: (ck.candidates||[]).length, scn: ck.sceneryCards, driving: ck.isDriving };
      });
      console.log(tag, JSON.stringify(s));
    } catch (e) { console.log(tag, 'eval-fail', e.message); }
  };

  try {
    await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && window.__cockpit.candidates, { timeout: 20000 });
    await page.fill('#msgInput', TASK);
    await page.click('#sendBtn');
    await page.waitForFunction(() => window.__cockpit.candidates.length > 0, { timeout: 60000 });

    // 选「查资料」分支的 3D 路牌（与 test_ux3 一致：双击路牌触发 startExecution）
    const idx = await page.evaluate(() => {
      const cs = window.__cockpit.candidates.map(c => c.label);
      let i = cs.findIndex(l => (l || '').includes('查资料'));
      return i < 0 ? 1 : i;
    });
    const pos = await page.evaluate((idx) => {
      const s = window.__cockpit.signs.find(x => x.userData && x.userData.branchId === idx);
      if (!s) return null;
      const v = new window.__cockpit.THREE.Vector3(); s.getWorldPosition(v);
      return window.__cockpit.projectToScreen(v.x, v.y, v.z);
    }, idx);
    if (!pos) throw new Error('找不到候选牌坐标');
    await page.mouse.dblclick(pos.x, pos.y);
    await dump('after-dblclick');

    // 澄清处理
    for (let i = 0; i < 4; i++) {
      await sleep(2200);
      const clarifying = await page.evaluate(() => {
        const c = document.getElementById('resultCard');
        return c && c.classList.contains('show') && c.classList.contains('clarify');
      });
      if (clarifying) {
        await page.fill('#rcAnswerInput', '请聚焦电力现货市场与绿电交易');
        await page.click('#rcAnswerBtn');
        console.log('clarify 补答 #' + i);
        await sleep(2200);
      } else break;
    }

    await page.waitForFunction(() => window.__cockpit && window.__cockpit.hasArrival, { timeout: 150000 });
    // 等真实的未来牌（branchId 在 -3..-7）异步拉回，避免只截到 -9 占位牌
    await page.waitForFunction(() => {
      const ck = window.__cockpit;
      return ck.signs.some(s => s.userData && s.userData.branchId !== undefined && s.userData.branchId >= -7 && s.userData.branchId <= -3);
    }, { timeout: 60000 }).catch(() => {});
    await sleep(2000);
    await dump('after-arrival');

    // 几何校验：结果牌水平侧移（现应为 0）、未来牌前置距离、概念图卡数量
    const geo = await page.evaluate(() => {
      const ck = window.__cockpit;
      const cur = ck.curPos, ty = ck.travelYaw;
      const camDir = ck.camera.getWorldDirection(new ck.THREE.Vector3());
      const camYaw = Math.atan2(camDir.z, camDir.x);
      let arrivalDist = null, futureDists = [];
      for (const s of ck.signs) {
        const bid = s.userData.branchId; if (bid === undefined) continue;
        const p = s.position;
        const d = Math.hypot(p.x - cur[0], p.z - cur[2]);
        if (bid === -2) arrivalDist = d; else if (bid <= -3 && bid !== -9) futureDists.push(d);
      }
      futureDists.sort((a, b) => a - b);
      return { camYaw, travelYaw: ty, camPan: ck.camPan, arrivalDist,
               futureMin: futureDists[0] || null, futureCount: futureDists.length, sceneryCards: ck.sceneryCards };
    });

    // 模拟拖拽（手动转视角）
    const box = await page.$eval('canvas', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.5 + 180, box.y + box.h * 0.5 + 40, { steps: 12 });
    await page.mouse.up();
    await sleep(500);
    await dump('during-drag');

    // 等超过保持期 → 应自动回归轨道
    await sleep(4000);
    const after = await page.evaluate(() => {
      const ck = window.__cockpit;
      const camDir = ck.camera.getWorldDirection(new ck.THREE.Vector3());
      const camYaw = Math.atan2(camDir.z, camDir.x);
      let dy = ck.travelYaw - camYaw;
      while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      return { yawDiff: dy, camPan: ck.camPan };
    });

    console.log('--- 到达后几何 ---'); console.log(JSON.stringify(geo));
    console.log('--- 回中后 ---'); console.log('yawDiff(rad)=', after.yawDiff.toFixed(4), 'camPan=', after.camPan.map(v=>v.toFixed(3)).join(','));

    // 判定口径已随后续迭代更新（三修取消自动回中 / 四修路牌拉近 / 五修到达牌回 midline）。
    // 这里按「当前设计」断言，避免历史脚本给出假失败；几何细项由 test_ux_fixes5/6.js 复核。
    const passArr = geo.arrivalDist !== null && geo.arrivalDist < 0.1;   // 五修：结果牌回路面中线（水平侧移 0）
    const passFut = geo.futureMin !== null && geo.futureMin >= 5.0 && geo.futureMin <= 6.5;  // 四修：最近一块 5.5m
    const passScn = geo.sceneryCards > 0;
    const passRec = Math.hypot(after.camPan[0], after.camPan[1], after.camPan[2]) < 0.15;   // 三修：视角自由保留，仅 pan 空闲归零

    console.log('=== 判定（当前设计口径） ===');
    console.log('结果牌回中线  :', passArr, '(水平 dist=', geo.arrivalDist?.toFixed(2), ')');
    console.log('未来牌最近≈5.5m:', passFut, '(min=', geo.futureMin?.toFixed(2), ',count=', geo.futureCount, ')');
    console.log('概念图卡>0     :', passScn, '(', geo.sceneryCards, ')');
    console.log('pan 空闲归零   :', passRec, '(yawDiff=', after.yawDiff.toFixed(4), ',panMag=', Math.hypot(...after.camPan).toFixed(3), ')');
    console.log('JS错误数       :', errors.length);
    if (errors.length) console.log(errors.slice(0, 10).join('\n'));
    await browser.close();
    process.exit(passArr && passFut && passScn && passRec && errors.length === 0 ? 0 : 1);
  } catch (e) {
    console.log('FATAL', e.message);
    await dump('on-error');
    console.log('JS错误数:', errors.length);
    if (errors.length) console.log(errors.slice(0, 10).join('\n'));
    await browser.close();
    process.exit(2);
  }
})();
