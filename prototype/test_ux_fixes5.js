const { resolveChromePath } = require('./chrome_helper');
// UX 五修端到端验证：摄像机轨道原则 / 去光柱 / 去到达回弹 / 强调结果面板互动性
//  A. 机位与视线解耦：拖拽自由改变 cam.yaw，但 camera.position 只由 camAnchorYaw 决定，
//     横向脱轨距离 camOffRail 恒≈0，机位固定在路面中心线上方（司机眼位）。
//  B. 真实执行到达后：无 16m 光柱、到达牌回 midline、结果卡有互动提示条、
//     联动牌提示为「点击收起结果」、无 gaze/距离回弹、机位仍贴轨。
//  C. 点同一块到达牌可展开/收起结果面板，提示文案随之切换。
// 用法：node test_ux_fixes5.js   （需 8770 与 8082 在线；35B 单槽，勿并发跑其它 3D 测试）
const { chromium } = require('playwright-core');

const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const TASK = '请分析国内电力交易市场的格局，并查资料说明现货与中长期交易的区别';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const errors = [];
  let PASS_A = false, PASS_B = false, PASS_C = false;
  const report = {};

  try {
    // ───────── A. 机位轨道不变量（纯前端，不依赖 LLM） ─────────
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', e => errors.push('A pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push('A console: ' + m.text()); });
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__cockpit && typeof window.__cockpit.camOffRail === 'number', { timeout: 20000 });
      await sleep(700);

      const before = await page.evaluate(() => ({
        yaw: window.__cockpit.camYaw, anchor: window.__cockpit.camAnchorYaw,
        pos: window.__cockpit.camPos, cur: window.__cockpit.curPos,
        offRail: window.__cockpit.camOffRail,
      }));
      const box = await page.locator('canvas').boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(cx + i * 12, cy);
      await page.mouse.up();
      await sleep(350);
      const after = await page.evaluate(() => ({
        yaw: window.__cockpit.camYaw, anchor: window.__cockpit.camAnchorYaw,
        pos: window.__cockpit.camPos, cur: window.__cockpit.curPos,
        offRail: window.__cockpit.camOffRail,
      }));
      await sleep(4100);   // 越过旧版 3s 强制回主轴保持期
      const idle = await page.evaluate(() => ({
        yaw: window.__cockpit.camYaw, anchor: window.__cockpit.camAnchorYaw,
        pos: window.__cockpit.camPos, offRail: window.__cockpit.camOffRail,
      }));

      const yawDelta = Math.abs(after.yaw - before.yaw);
      const posShift = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
      const anchorDrift = Math.abs(after.anchor - before.anchor);
      const eyeHeight = after.pos[1] - after.cur[1];
      const idleYawDrift = Math.abs(idle.yaw - after.yaw);

      report.A = { yawDelta, posShift, anchorDrift, eyeHeight, idleYawDrift,
        offRailBefore: before.offRail, offRailAfter: after.offRail, offRailIdle: idle.offRail,
        posBefore: before.pos.map(v => +v.toFixed(3)), posAfter: after.pos.map(v => +v.toFixed(3)) };
      PASS_A = yawDelta > 0.3 &&           // 自由视角确实变了
               posShift < 0.02 &&          // 机位一点没横向绕行（核心）
               anchorDrift < 0.001 &&      // 轨道方向只由路决定，不随鼠标变
               after.offRail < 0.02 && idle.offRail < 0.02 &&
               Math.abs(eyeHeight - 1.35) < 0.05 &&   // 钉在司机眼位
               idleYawDrift < 0.25;        // 不被空闲强制拉回（延续 UX 三修）
      await page.close();
    }

    // ───────── B/C. 真实 LLM 执行 → 到达 → 互动性 ─────────
    let attemptOK = false;
    for (let attempt = 1; attempt <= 3 && !attemptOK; attempt++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', e => errors.push(`B${attempt} pageerror: ` + e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(`B${attempt} console: ` + m.text()); });
      try {
        await page.goto(URL, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__cockpit && window.__cockpit.arrivalBeamCount !== undefined, { timeout: 20000 });
        await page.fill('#msgInput', TASK);
        await page.click('#sendBtn');
        await page.waitForFunction(() => {
          const s = window.__cockpit.signs;
          return s && s.some(b => b.userData && b.userData.branchId >= 0);
        }, { timeout: 90000 });

        const picked = await page.evaluate(() => {
          const signs = window.__cockpit.signs;
          const idx = signs.findIndex(b => b.userData && b.userData.branchId >= 0 &&
            /查|资料|检索|搜索/.test(b.userData.label || ''));
          const use = idx >= 0 ? idx : signs.findIndex(b => b.userData && b.userData.branchId >= 0);
          const b = signs[use];
          const sp = window.__cockpit.projectToScreen(b.position.x, b.position.y, b.position.z);
          return { x: sp.x, y: sp.y, label: b.userData.label || '' };
        });
        await page.mouse.dblclick(picked.x, picked.y);

        // 澄清可能连着来几轮，最多补答 3 次
        for (let k = 0; k < 3; k++) {
          await page.waitForFunction(() => {
            const c = document.querySelector('#rcAnswerInput');
            return (c && c.offsetParent !== null) || window.__cockpit.resultCardOpen;
          }, { timeout: 150000 });
          const clar = await page.evaluate(() => {
            const c = document.querySelector('#rcAnswerInput');
            return !!c && c.offsetParent !== null;
          });
          if (!clar) break;
          await page.fill('#rcAnswerInput', '请聚焦现货与中长期两类交易，说明各自如何定价与规避风险');
          await page.click('#rcAnswerBtn');
        }
        await page.waitForFunction(() => window.__cockpit.hasArrival && window.__cockpit.resultCardOpen,
          { timeout: 150000 });
        await sleep(600);   // 让落地动画/光晕稳定

        const t0 = await page.evaluate(() => {
          const signs = window.__cockpit.signs.filter(s => s.userData.branchId === -2);
          const interact = document.getElementById('rcInteract');
          return {
            beamCount: window.__cockpit.arrivalBeamCount,
            beamOn: window.__cockpit.arrivalBeamOn,
            sideOffset: window.__cockpit.arrivalSideOffset,
            hint: window.__cockpit.activeArrivalHint,
            signHints: signs.map(s => s.userData.hintText || ''),
            interactVisible: !!interact && interact.offsetParent !== null,
            cardOpen: window.__cockpit.resultCardOpen,
            gazeOn: window.__cockpit._arrivalSequence().gazeOn,
            offRail: window.__cockpit.camOffRail,
            anchor: window.__cockpit.camAnchorYaw,
            anchorT: window.__cockpit.camAnchorYawT,
            travelYaw: window.__cockpit.travelYaw,
            camDist: window.__cockpit.camDist,
            camPitch: window.__cockpit.camPitch,
            docked: window.__cockpit.camDocked,
            arrivalCamDist: window.__cockpit.arrivalCamDist,
            camPos: window.__cockpit.camPos,
            camY: window.__cockpit.camPos[1],
            signY: signs.length ? signs[signs.length - 1].position.y : null,
            arrivalScreen: window.__cockpit.arrivalScreen,
            curPos: window.__cockpit.curPos,
            arrivalSignCount: signs.length,
            futureSigns: window.__cockpit.futureSigns.length,
          };
        });

        // 落位 2s 后：镜头距离/机位不应「往回弹一下」
        await sleep(2000);
        const t1 = await page.evaluate(() => ({
          camDist: window.__cockpit.camDist,
          offRail: window.__cockpit.camOffRail,
          gazeOn: window.__cockpit._arrivalSequence().gazeOn,
          camPos: window.__cockpit.camPos,
        }));
        const distBounce = Math.abs(t1.camDist - t0.camDist);
        const posBounce = Math.hypot(t1.camPos[0] - t0.camPos[0], t1.camPos[2] - t0.camPos[2]);

        // C. 找一块能被射线真实命中的到达牌，点它做 toggle
        const hit = await page.evaluate(() => {
          const signs = window.__cockpit.signs.filter(s => s.userData.branchId === -2);
          if (!signs.length) return null;
          const s = signs[signs.length - 1];
          const base = window.__cockpit.projectToScreen(s.position.x, s.position.y, s.position.z);
          for (let dy = 0; dy <= 60; dy += 10) {
            for (let dx = -60; dx <= 60; dx += 10) {
              const x = base.x + dx, y = base.y + dy;
              if (window.__cockpit.pickAt(x, y) === -2) return { x, y };
            }
          }
          return null;
        });
        let cState = { hit: !!hit };
        if (hit) {
          await page.mouse.click(hit.x, hit.y);
          await sleep(350);
          cState.closed = await page.evaluate(() => ({
            open: window.__cockpit.resultCardOpen,
            hint: window.__cockpit.activeArrivalHint,
            signHints: window.__cockpit.signs.filter(s => s.userData.branchId === -2).map(s => s.userData.hintText || ''),
          }));
          await page.mouse.click(hit.x, hit.y);
          await sleep(350);
          cState.reopened = await page.evaluate(() => ({
            open: window.__cockpit.resultCardOpen,
            hint: window.__cockpit.activeArrivalHint,
          }));
        }

        report.B = { ...t0, distBounce, posBounce, t1Gaze: t1.gazeOn, t1OffRail: t1.offRail,
          pickedLabel: picked.label, attempt };
        report.C = cState;

        PASS_B = t0.beamCount === 0 && !t0.beamOn &&
                 t0.sideOffset === 0 &&
                 t0.interactVisible && t0.cardOpen &&
                 t0.hint === '点击收起结果' &&
                 t0.signHints.includes('点击收起结果') &&
                 !t0.gazeOn && !t1.gazeOn &&
                 t0.offRail < 0.02 && t1.offRail < 0.02 &&
                 distBounce < 0.05 && posBounce < 0.05 &&   // 无镜头/机位回弹
                 Math.abs(t0.anchor - t0.anchorT) < 0.05 &&  // 落位后机位轨道已收敛到当前路段
                 // v0.9.14：拿到结果后机位沿轨道停靠到结果牌上方（仍贴轨、在牌上方、牌完整可见）
                 Math.abs(t0.camDist - t0.arrivalCamDist) < 0.05 && t0.docked === true &&
                 t0.camY > t0.signY + 2.0 &&
                 !!t0.arrivalScreen && t0.arrivalScreen.y > 400 && t0.arrivalScreen.y < 780 &&
                 t0.arrivalSignCount >= 1;
        PASS_C = !!hit && cState.closed && cState.closed.open === false &&
                 cState.closed.signHints.every(h => h === '点击展开结果') &&
                 cState.reopened && cState.reopened.open === true &&
                 cState.reopened.hint === '点击收起结果';
        attemptOK = true;
      } catch (e) {
        report[`attempt${attempt}Error`] = String(e).slice(0, 240);
        console.log(`  ! 第 ${attempt} 次尝试未完成：${String(e).slice(0, 160)}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log('=== A. 摄像机只在路面上方（机位/视线解耦） ===');
  console.log(' ', JSON.stringify(report.A));
  console.log('  A PASS =', PASS_A);
  console.log('=== B. 去光柱 / 去回弹 / 结果面板互动性 ===');
  console.log(' ', JSON.stringify(report.B));
  console.log('  B PASS =', PASS_B);
  console.log('=== C. 到达牌点击 toggle ===');
  console.log(' ', JSON.stringify(report.C));
  console.log('  C PASS =', PASS_C);
  console.log('=== JS 错误 ===');
  console.log('  count =', errors.length, errors.slice(0, 6));
  console.log('=== 结论 ===');
  const ALL = PASS_A && PASS_B && PASS_C && errors.length === 0;
  console.log('  OVERALL =', ALL ? 'ALL_PASS' : 'FAIL');
  process.exit(ALL ? 0 : 1);
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
