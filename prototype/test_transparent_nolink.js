const { resolveChromePath } = require('./chrome_helper');
// F3.2 最小对照 B0/B1（3D 联动单归因）：?mode=transparent-nolink
//   断言：结果卡本身仍可打开（P2/P3 呈现层保留），但「在 3D 中定位」按钮被隐藏、
//   到达牌持续联动发光被门控关闭——即结果卡与 3D 之间无联动反馈。
//   与 test_f32_link.js（B1 组，无模式参数）对比即可分离「联动本身」的贡献。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

let failures = 0;
function check(name, ok, extra){
  console.log(`${ok ? '✓' : '✗' } ${name}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures++;
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8770/?mode=transparent-nolink', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 1) 模式已生效
  const mode = await page.evaluate(() => document.documentElement.classList.contains('mode-transparent-nolink'));
  check('mode-transparent-nolink class 已生效', mode === true, 'mode=' + mode);
  const noLink = await page.evaluate(() => window._transparentNoLink === true);
  check('window._transparentNoLink === true', noLink === true, 'noLink=' + noLink);

  // 2) setupTestArrival 创建到达牌 + 结果数据
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  await page.waitForTimeout(500);

  // 3) 结果卡仍可打开（P2/P3 呈现层保留，仅联动被禁用）
  const shown = await page.evaluate(() => window.__cockpit._rcShow());
  check('_rcShow() 仍返回 true（结果卡可打开）', shown === true, 'shown=' + shown);
  await page.waitForTimeout(500);

  // 4) 定位按钮被 CSS 隐藏
  const locateBtnHidden = await page.evaluate(() => {
    const btn = document.querySelector('.rc-locate-btn');
    if (!btn) return 'no-btn';
    const style = window.getComputedStyle(btn);
    return style.display;
  });
  check('「在 3D 中定位」按钮被隐藏', locateBtnHidden === 'none' || locateBtnHidden === 'no-btn', locateBtnHidden);

  // 5) 到达牌联动反馈被门控关闭（B0 组：结果卡与 3D 之间无联动）
  // v0.9.32 尺子修复：旧断言 glowOp ≤ 0.15 是假断言——
  //   glow 是 sin 驱动的持续呼吸（0.16+pulse*0.3），实测 B0 在 0.194~0.46、B1 在 0.205~0.698，
  //   两组分布重叠，glowOp 无鉴别力（且恒 >0.15，永远判 FAIL）。
  //   确定性的组间差异在 plane：产品 animate 中联动抬升写 plane.opacity = baseOpacity + 0.2，
  //   且该分支被 !window._transparentNoLink 门控。B0 开卡后 planeOp 保持 base=1.0，B1=1.2。
  //   plane 不走 sin、无时序波动，是可复算判据；与 test_f32_link.js（B1=1.2）互为镜像。
  const linkState = await page.evaluate(() => window.__cockpit._linkState());
  check('结果卡已打开', linkState.cardShown === true, JSON.stringify(linkState));
  check('联动牌仍被设置（有结果对应到达牌）', linkState.hasActiveSign === true, JSON.stringify(linkState));
  check('B0 组联动抬升被门控关闭（planeOp≈1.0，B1 组为 1.2）',
    linkState.activeStats && Math.abs(linkState.activeStats.planeOp - 1.0) < 0.01,
    JSON.stringify(linkState.activeStats));

  // 6) 收起结果卡
  await page.evaluate(() => window.__cockpit._rcHide());
  await page.waitForTimeout(300);
  const postHide = await page.evaluate(() => window.__cockpit._linkState());
  check('收起结果卡后联动牌清除', postHide.hasActiveSign === false, JSON.stringify(postHide));

  check('JS 零错误', errors.length === 0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ B0 transparent-nolink 回归通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });