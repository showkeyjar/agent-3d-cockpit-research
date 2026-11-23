const { resolveChromePath } = require('./chrome_helper');
// 行驶镜头(看板淡出/恢复) + 结果卡感知动画 冒烟回归
//   断言驱动 __cockpit._driveTo()/._signOpacities() 新测试钩子。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

let failures = 0;
function check(name, ok, extra){
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures++;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8770/?test=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // ── 场景：搭景（到达牌 + 3 未来路牌），车在 [8,0,8] ──
  const bannerCount = await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  check('搭景完成（未来路牌 3 块 + 到达牌）', bannerCount === 3);

  // 行驶前牌子透明度基线
  const base = await page.evaluate(() => window.__cockpit._signOpacities());
  const baseVals = base.filter(v => v !== null);
  check('行驶前牌子不透明（≥0.5）',
    baseVals.length > 0 && baseVals.every(v => v >= 0.5), JSON.stringify(base));

  // 收起结果卡（模拟行驶前未显示）
  await page.evaluate(() => document.getElementById('rcClose').click());

  // 触发行驶：[8,0,8] → [16,0,16]（dur≈1130ms）
  const driveP = page.evaluate((t) => window.__cockpit._driveTo(t), [[16,0,16]]);
  await page.waitForTimeout(350);   // 行驶进行中
  const midOpacity = await page.evaluate(() => window.__cockpit._signOpacities());
  const midVals = midOpacity.filter(v => v !== null);
  check('行驶期间「现在」牌隐藏（不挡正前方视线）',
    await page.evaluate(() => window.__cockpit._nowVisible()) === false,
    'midOpacity=' + JSON.stringify(midOpacity));
  check('行驶期间前方路牌保持原亮度（≥0.5）',
    midVals.length > 0 && midVals.every(v => v >= 0.5), JSON.stringify(midOpacity));
  const curlCamera = await page.evaluate(() => window.__cockpit.cameraWorld());
  check('行驶跟拍：相机位置有效且位于起点附近（行驶视界稳定）',
    curlCamera.pos.length === 3 && Math.hypot(curlCamera.pos[0] - 8, curlCamera.pos[2] - 8) > 3,
    JSON.stringify(curlCamera));
  check('行驶跟拍：相机俯仰压平（pitch ≤ 0.5）',
    curlCamera.pitch !== undefined && curlCamera.pitch <= 0.5, JSON.stringify(curlCamera));

  await driveP;   // 行驶结束
  await page.waitForTimeout(120);
  // 行驶中采样：行驶结束态（淡出收尾可能仍在途中）+ 可见性分组
  const endState = await page.evaluate(() => ({
    op: window.__cockpit._signOpacities(),
    vis: window.__cockpit._signVisibility(),
    now: window.__cockpit._nowVisible(),
  }));
  const endVals = endState.op.filter(v => v !== null);
  // v0.9.11.5：驶过的牌淡出归零并整组隐藏（不占前方视野）——与"恢复原透明度"并存：
  // 未驶过（前方/侧方）的牌保持原亮度，已驶过的牌 opacity→0 且 visible=false。
  const unpassedVals = endState.op.filter((v, i) => v !== null && endState.vis[i] !== false);
  check('行驶结束：未驶过（前方/侧方）路牌保持原透明度',
    unpassedVals.length > 0 && unpassedVals.every(v => v >= 0.5), JSON.stringify(endState));
  const passedVals = endState.op.filter((v, i) => v !== null && endState.vis[i] === false);
  check('行驶结束：已驶过的节点牌淡出归零且不可见（后视镜语义）',
    passedVals.length > 0 && passedVals.every(v => v === 0), JSON.stringify(endState));
  check('行驶结束「现在」状态条恢复显示', endState.now === true, '');

  // 行驶结束后相机姿态：俯仰压平（pitchT 0.20 附近）；yaw 对准目标 ([16,0,16] from [8,0,8] → 45°)
  const cw = await page.evaluate(() => window.__cockpit.cameraWorld());
  const yawOk = Math.abs(cw.yaw - Math.PI/4) < 0.03;
  check('行驶结束：相机对准目标（yaw≈45°）',
      yawOk, JSON.stringify(cw));

  // ── 结果卡感知动画：注入 detail 并 show，检查 computed animation 名为 rcLongPulse、rcBadge ──
  const anim = await page.evaluate(() => {
    const d = { ok: true, mode:'choice', label:'先查资料', title:'这一步做完了',
                question:'分析国内电力交易市场格局', count:2, elapsed:'3.2s',
                tasks:[], output:'已被覆盖的模型输出', source:'llm' };
    window.__cockpit._rcSet(d);
    window.__cockpit._rcShow();
    const card = document.getElementById('resultCard');
    return {
      show: card.classList.contains('show'),
      cardAnim: getComputedStyle(card).animationName,
      badgeAnim: getComputedStyle(document.querySelector('#resultCard .rc-badge')).animationName,
    };
  });
  check('结果卡 show + rcLongPulse 长脉冲',
    anim.show && anim.cardAnim.includes('rcLongPulse'), JSON.stringify(anim));
  check('完成徽章持续呼吸动画',
    anim.badgeAnim.includes('rcBadge'), JSON.stringify(anim));

  await page.waitForTimeout(600);
  const dismissed = await page.evaluate(() => {
    document.getElementById('rcClose').click();
    return !document.getElementById('resultCard').classList.contains('show');
  });
  check('关闭结果卡生效', dismissed);

  // 提交错误收集
  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ 行驶镜头冒烟通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
