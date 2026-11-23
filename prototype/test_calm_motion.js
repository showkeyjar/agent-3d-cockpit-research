const { resolveChromePath } = require('./chrome_helper');
// v0.9.53 静默动效回归：用户 2026-11-23 反馈「不需要抖动/呼吸浮动，重体验非炫酷」。
//   验证落位静止后 3D 场景不再有持续运动（相机 y / 载具环 / 到达牌徽章 / 光晕恒定），
//   CSS 结果卡无 infinite 呼吸，同时确认 FI-01 行驶位移机制仍在（只去掉装饰、不删研究核心）。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

let failures = 0;
function check(name, ok, extra){
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8770/?test=1', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__cockpit && typeof window.__cockpit._motionState === 'function',
    null, { timeout: 20000 });
  await page.waitForTimeout(600);

  // ── A. 静止态连续采样：相机/载具环/徽章/光晕跨多帧恒定（无抖动、无呼吸）──
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  await page.waitForTimeout(1200);   // 越过落地动画(600ms) + 停靠收敛
  const samples = [];
  for (let i = 0; i < 5; i++){
    samples.push(await page.evaluate(() => window.__cockpit._motionState()));
    await sleep(220);
  }
  const uniq = key => new Set(samples.map(s => s[key])).size;
  check('A1 静止态相机 y 恒定（无行驶颠簸）', uniq('camY') === 1,
    samples.map(s => s.camY).join(','));
  check('A2 静止态载具环不再空转', uniq('ringRotZ') === 1,
    samples.map(s => s.ringRotZ).join(','));
  check('A3 静止态到达牌徽章 y 恒定（无浮动）',
    samples[0].badgeY !== null && uniq('badgeY') === 1,
    samples.map(s => s.badgeY).join(','));
  check('A4 静止态到达牌光晕 opacity 恒定（无呼吸）',
    samples[0].glowOp !== null && uniq('glowOp') === 1,
    samples.map(s => s.glowOp).join(','));

  // ── B. CSS 结果卡无 infinite 呼吸，但保留一次性入场 rcIn ──
  const css = await page.evaluate(() => {
    window.__cockpit._rcSet({ ok:true, mode:'choice', label:'x', title:'t',
      question:'q', count:1, elapsed:'1s', tasks:[], output:'o', source:'llm' });
    window.__cockpit._rcShow();
    const card = document.getElementById('resultCard');
    const cs = getComputedStyle(card);
    const bcs = getComputedStyle(document.querySelector('#resultCard .rc-badge'));
    const hb = getComputedStyle(document.querySelector('#headbar .dot'));
    const nb = document.querySelector('#nowBar .nb-dot')
      ? getComputedStyle(document.querySelector('#nowBar .nb-dot')) : null;
    return {
      cardAnim: cs.animationName, cardIter: cs.animationIterationCount,
      badgeAnim: bcs.animationName, headbarAnim: hb.animationName,
      nowbarAnim: nb ? nb.animationName : 'none',
    };
  });
  check('B1 结果卡保留一次性入场 rcIn',
    css.cardAnim.includes('rcIn') && !css.cardAnim.includes('rcLongPulse'), JSON.stringify(css));
  check('B2 结果卡无 infinite 呼吸',
    !css.cardIter.includes('infinite'), JSON.stringify(css));
  check('B3 完成徽章无 rcBadge 呼吸', !css.badgeAnim.includes('rcBadge'), JSON.stringify(css));
  check('B4 标题栏装饰点无 pulse', !css.headbarAnim.includes('pulse'), JSON.stringify(css));
  check('B5 现在状态点无 pulse', !css.nowbarAnim.includes('pulse'), JSON.stringify(css));

  // ── C. FI-01 行驶位移仍在（只去装饰、不删研究核心）──
  const drive = await page.evaluate(() => ({
    hasDriveApi: typeof window.__cockpit.setDriving === 'function',
    hasExecDrive: 'execDriveState' in window.__cockpit,
  }));
  check('C1 行驶机制入口仍在（setDriving/execDrive 未删）',
    drive.hasDriveApi && drive.hasExecDrive, JSON.stringify(drive));

  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ 静默动效回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
