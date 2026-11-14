const { resolveChromePath } = require('./chrome_helper');
// 到达序列回归（UX 五修后语义）：「落位即稳定」
//   旧 F3.8 断言的是 gaze 转向 → 1200ms 物件亮起 → 2800ms gaze 清除这套到达编舞；
//   用户指出那只是「往回弹一下」，不携带信息，已整体移除。
//   现在到达只做一件事：打开结果卡 + 把联动牌提示改成可操作状态。
//   本脚本用 setupTestArrival 钩子复验：无 gaze、无光柱、无延迟脉冲、有互动提示。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures++;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME,
    args: ['--no-sandbox', '--use-gl=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.camOffRail !== undefined, { timeout: 20000 });
  await sleep(800);

  // setupTestArrival 造出一块到达牌 + 结果数据；_triggerArrival 现在只打开结果卡
  await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
  const triggered = await page.evaluate(() => window.__cockpit._triggerArrival());

  const t0 = await page.evaluate(() => ({
    seq: window.__cockpit._arrivalSequence(),
    beamCount: window.__cockpit.arrivalBeamCount,
    beamOn: window.__cockpit.arrivalBeamOn,
    hint: window.__cockpit.activeArrivalHint,
    interact: (() => { const e = document.getElementById('rcInteract'); return !!e && e.offsetParent !== null; })(),
    cardOpen: window.__cockpit.resultCardOpen,
    offRail: window.__cockpit.camOffRail,
    camDist: window.__cockpit.camDist,
  }));
  check('到达序列触发成功', triggered === true, String(triggered));
  check('到达牌存在', t0.seq.arrivalSignCount >= 1, JSON.stringify(t0.seq));
  check('落地动画进行中（scale < 1）', t0.seq.lastSignScale !== null && t0.seq.lastSignScale < 1, 'scale=' + t0.seq.lastSignScale);
  check('结果卡已打开', t0.seq.cardShown === true && t0.cardOpen === true);
  check('不再自动转头（gaze 未启动）', t0.seq.gazeOn === false, 'gazeOn=' + t0.seq.gazeOn);
  check('16m 长光柱不再生成', t0.beamCount === 0 && t0.beamOn === false, `count=${t0.beamCount} on=${t0.beamOn}`);
  check('结果卡互动提示条可见', t0.interact === true);
  check('联动牌提示 = 点击收起结果', t0.hint === '点击收起结果', t0.hint);
  check('机位仍在路面中心线上方', t0.offRail < 0.02, 'offRail=' + t0.offRail.toFixed(4));

  // 落地动画完成（headless swiftshader 首帧可能被阻塞 ~1s，等收敛而非固定 sleep）
  let landed = false;
  try {
    await page.waitForFunction(() => window.__cockpit._arrivalSequence().lastSignScale === 1, { timeout: 8000 });
    landed = true;
  } catch (_) { /* 超时由下方断言报出 */ }
  const t1 = await page.evaluate(() => ({
    seq: window.__cockpit._arrivalSequence(),
    camDist: window.__cockpit.camDist,
  }));
  check('落地动画收敛到 scale = 1', landed && t1.seq.lastSignScale === 1,
    `landed=${landed} scale=${t1.seq.lastSignScale}`);

  // 覆盖旧版「1200ms 延迟脉冲」窗口：高频采样 reactK，若仍有自动弹跳会看到峰值
  let maxReactK = 0, gazeSeen = false;
  for (let i = 0; i < 16; i++) {
    await sleep(100);
    const s = await page.evaluate(() => ({
      reactK: (window.__cockpit._branchSignsProbe() || {}).reactK || 0,
      gaze: window.__cockpit._arrivalSequence().gazeOn,
    }));
    maxReactK = Math.max(maxReactK, s.reactK);
    gazeSeen = gazeSeen || s.gaze;
  }
  check('到达后无延迟物件弹跳（reactK 峰值 = 0）', maxReactK < 0.05, 'maxReactK=' + maxReactK);
  check('到达后全程无自动 gaze', gazeSeen === false, 'gazeSeen=' + gazeSeen);

  const t2 = await page.evaluate(() => ({
    camDist: window.__cockpit.camDist,
    offRail: window.__cockpit.camOffRail,
    gaze: window.__cockpit._arrivalSequence().gazeOn,
  }));
  check('镜头距离落位后不回弹', Math.abs(t2.camDist - t1.camDist) < 0.05,
    `t1=${t1.camDist.toFixed(3)} t2=${t2.camDist.toFixed(3)}`);
  check('机位始终贴轨', t2.offRail < 0.02, 'offRail=' + t2.offRail.toFixed(4));

  check('JS 零错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ 到达序列「落位即稳定」回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(2); });
