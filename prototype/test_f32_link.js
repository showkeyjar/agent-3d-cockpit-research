const { resolveChromePath } = require('./chrome_helper');
// F3.2 强空间锚定联动回归：结果卡↔到达牌双向联动。
//   断言 __cockpit._linkState() 新测试钩子。
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

  // setupTestArrival 创建到达牌 + 结果数据
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  await page.waitForTimeout(500);

  // 1) setupTestArrival 后：有到达牌，但结果卡未打开，无联动
  const preShow = await page.evaluate(() => window.__cockpit._linkState());
  check('setupTestArrival 后到达牌存在', preShow.arrivalSignCount >= 1, JSON.stringify(preShow));
  check('setupTestArrival 后结果卡未打开', preShow.cardShown === false, JSON.stringify(preShow));
  check('setupTestArrival 后无联动牌', preShow.hasActiveSign === false, JSON.stringify(preShow));

  // 2) _rcShow() 打开结果卡 → 联动牌设置
  const shown = await page.evaluate(() => window.__cockpit._rcShow());
  check('_rcShow() 返回 true（有结果数据）', shown === true, 'shown=' + shown);
  await page.waitForTimeout(500);

  const postShow = await page.evaluate(() => window.__cockpit._linkState());
  check('打开结果卡后卡片显示', postShow.cardShown === true, JSON.stringify(postShow));
  check('打开结果卡后联动牌已设置', postShow.hasActiveSign === true, JSON.stringify(postShow));
  // v0.9.32 尺子修复：旧断言 glowOp > 0.15 恒真（通用呼吸下限就是 0.16），无鉴别力。
  //   确定性判据是 planeOp：B1 组开卡联动抬升 plane = base 1.0 + 0.2 = 1.2，B0 组保持 1.0。
  //   与 test_transparent_nolink.js（B0=1.0）互为镜像，两者共同构成 H1.1 单归因对照。
  check('联动抬升生效（planeOp≈1.2，B0 组为 1.0）',
    postShow.activeStats && Math.abs(postShow.activeStats.planeOp - 1.2) < 0.01,
    JSON.stringify(postShow.activeStats));

  // 3) _rcHide() 收起结果卡 → 联动牌清除
  await page.evaluate(() => window.__cockpit._rcHide());
  await page.waitForTimeout(300);
  const postHide = await page.evaluate(() => window.__cockpit._linkState());
  check('收起结果卡后联动牌清除', postHide.hasActiveSign === false, JSON.stringify(postHide));
  check('收起结果卡后卡片关闭', postHide.cardShown === false, JSON.stringify(postHide));

  // 4) 再开一次：确认联动可重复触发（不是一次性的）
  await page.evaluate(() => window.__cockpit._rcShow());
  await page.waitForTimeout(300);
  const reShow = await page.evaluate(() => window.__cockpit._linkState());
  check('再次打开结果卡联动可重复触发', reShow.hasActiveSign === true, JSON.stringify(reShow));

  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ F3.2 联动回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
