const { resolveChromePath } = require('./chrome_helper');
// F3.7 视野信息密度回归：风景层（星空/分层环）行驶时淡出、停止后淡入；
//   主干常驻不受影响。断言 __cockpit._scenicState() 新测试钩子。
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
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));

  // 静止时：风景层全亮
  const idle = await page.evaluate(() => window.__cockpit._scenicState());
  check('静止时风景层目标亮度 = 1.0', idle.target === 1, JSON.stringify(idle));
  check('静止时星空全亮（opacity ≈ 0.35）', idle.starOp !== null && Math.abs(idle.starOp - 0.35) < 0.02, JSON.stringify(idle));

  // 触发行驶，行驶中采样：风景层应淡出
  const driveP = page.evaluate((t) => window.__cockpit._driveTo(t), [[16,0,16]]);
  await page.waitForTimeout(560);  // 行驶进行中（dur≈1130ms 的中点）
  const driving = await page.evaluate(() => window.__cockpit._scenicState());
  check('行驶时风景层目标亮度 = 0.18', driving.target === 0.18, JSON.stringify(driving));
  check('行驶时风景层已淡出（cur < 0.5）', driving.cur < 0.5, JSON.stringify(driving));
  check('行驶时星空透明度同步下降（< 0.2）', driving.starOp !== null && driving.starOp < 0.2, JSON.stringify(driving));

  await driveP;  // 行驶结束
  await page.waitForTimeout(900);  // 等淡入恢复
  const stopped = await page.evaluate(() => window.__cockpit._scenicState());
  check('行驶结束风景层恢复（cur > 0.9）', stopped.cur > 0.9, JSON.stringify(stopped));
  check('行驶结束星空恢复全亮（opacity ≈ 0.35）', stopped.starOp !== null && Math.abs(stopped.starOp - 0.35) < 0.03, JSON.stringify(stopped));

  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ F3.7 视野密度回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
