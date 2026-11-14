const { resolveChromePath } = require('./chrome_helper');
// F3.6 速度线回归：行驶时可见 + 铺到视野边缘；停止时消失。
//   断言 __cockpit._speedLineState() 新测试钩子。
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

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));

  // 行驶前：速度线应不可见
  const idle = await page.evaluate(() => window.__cockpit._speedLineState());
  check('行驶前速度线不可见', idle.visible === false, JSON.stringify(idle));

  // 触发行驶，行驶中采样
  const driveP = page.evaluate((t) => window.__cockpit._driveTo(t), [[16,0,16]]);
  await page.waitForTimeout(560);  // 行驶进行中（dur≈1130ms 的中点）
  const driving = await page.evaluate(() => window.__cockpit._speedLineState());
  check('行驶中速度线可见', driving.visible === true, JSON.stringify(driving));
  check('行驶中速度线有活跃线段', driving.active > 0, JSON.stringify(driving));
  check('行驶中速度线铺到视野边缘（maxEndR ≥ 0.9×baseR）',
    driving.maxEndR_over_baseR >= 0.9, JSON.stringify(driving));
  check('行驶中速度线平均长度合理（>0.5）', driving.avgLen > 0.5, JSON.stringify(driving));

  await driveP;  // 行驶结束
  await page.waitForTimeout(400);  // 等淡出
  const stopped = await page.evaluate(() => window.__cockpit._speedLineState());
  check('行驶结束速度线隐藏', stopped.visible === false, JSON.stringify(stopped));

  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ F3.6 速度线回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
