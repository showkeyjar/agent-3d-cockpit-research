const { resolveChromePath } = require('./chrome_helper');
// v0.9.20 回归：风景可点（沿途语义概念图卡 → 回看来源 + 视线带向，机位不动 + 行驶中不可点）
// 纯前端 + __cockpit 钩子，不占 35B 单槽，秒级。
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'networkidle' });
  await sleep(800);
  await page.waitForFunction(() => window.__cockpit && typeof window.__cockpit.rebuildScenery === 'function', { timeout: 8000 });

  // ── A. 重建风景：沿途概念图卡有内容且每张带 text/src/kind ──
  console.log('\n[A] 重建风景 + 图卡元数据');
  await page.evaluate(() => window.__cockpit.setContext('国内电力交易市场的格局 数据 模型 中长期交易 现货'));
  await page.evaluate(() => window.__cockpit.rebuildScenery());
  await sleep(120);
  const cards = await page.evaluate(() => window.__cockpit.sceneryCards);
  ok('图卡数量 > 0', cards > 0, { cards });
  const sample = await page.evaluate(() => window.__cockpit.scenerySample);
  ok('sample[0].text 可读短语非空', sample[0] && typeof sample[0].text === 'string' && sample[0].text.length >= 2, sample[0]);
  ok('sample[0].src 来源标注非空', sample[0] && typeof sample[0].src === 'string' && sample[0].src.length > 0, sample[0]);
  ok('sample[0].kind === "scenery"', sample[0] && sample[0].kind === 'scenery', sample[0]);
  ok('图卡仍是背景底（baseOpacity 0.38）', sample[0] && Math.abs(sample[0].baseOpacity - 0.38) < 1e-6, sample[0]);
  ok('图卡 renderOrder=1（远低于路牌）', sample[0] && sample[0].renderOrder === 1, sample[0]);

  // ── B. 点击风景 → 回看面板 + 注视带向（机位不动） ──
  console.log('\n[B] 点击风景 → 回看面板 + 视线带向');
  const anchorBefore = await page.evaluate(() => ({ yaw: window.__cockpit.camAnchorYaw, camOffRail: window.__cockpit.camOffRail }));
  await page.evaluate(() => window.__cockpit.focusSceneryByIndex(0));
  await sleep(120);
  const panelOpen = await page.evaluate(() => window.__cockpit.scenicPanelOpen);
  ok('回看面板已弹出', panelOpen === true);
  const panelText = await page.evaluate(() => document.querySelector('#scnPanel .scn-text')?.textContent || '');
  const sampleText = await page.evaluate(() => window.__cockpit.scenerySample[0].text);
  ok('面板显示的就是这张概念卡文本', panelText === sampleText, { panelText, sampleText });
  const panelSrc = await page.evaluate(() => document.querySelector('#scnPanel .scn-src')?.textContent || '');
  ok('面板标注来源（含「来源：」）', panelSrc.indexOf('来源：') === 0 && panelSrc.length > 3, { panelSrc });
  const focused = await page.evaluate(() => window.__cockpit.scnFocusedText);
  ok('被聚焦的风景文本记录正确', focused === sampleText, { focused, sampleText });
  const panInfo = await page.evaluate(() => ({
    pan: window.__cockpit.camPan,
    panHold: window.__cockpit.panHoldUntil,
    now: performance.now()
  }));
  ok('注视点被带向风景（panT 偏移 > 0）', Math.hypot(panInfo.pan[0], panInfo.pan[1], panInfo.pan[2]) > 0.1, panInfo);
  ok('_panHoldUntil 已设定为未来时刻', panInfo.panHold > panInfo.now, panInfo);
  const anchorAfter = await page.evaluate(() => ({ yaw: window.__cockpit.camAnchorYaw, camOffRail: window.__cockpit.camOffRail }));
  ok('机位公式未变（camAnchorYaw 不变）', anchorAfter.yaw === anchorBefore.yaw, { before: anchorBefore.yaw, after: anchorAfter.yaw });
  ok('机位未脱轨（camOffRail ≈ 0）', anchorAfter.camOffRail < 0.05, { camOffRail: anchorAfter.camOffRail });

  // ── C. 收起面板 → 风景恢复为「底」 ──
  console.log('\n[C] 收起面板 → 恢复背景态');
  await page.evaluate(() => window.__cockpit.hideSceneryPanel());
  await sleep(120);
  const panelClosed = await page.evaluate(() => window.__cockpit.scenicPanelOpen);
  ok('面板已收起', panelClosed === false);
  const focusedAfter = await page.evaluate(() => window.__cockpit.scnFocusedText);
  ok('_scnFocused 已清空', focusedAfter === null, { focusedAfter });
  const baseAfter = await page.evaluate(() => window.__cockpit.scenerySample[0].baseOpacity);
  ok('图卡 baseOpacity 恢复 0.38', Math.abs(baseAfter - 0.38) < 1e-6, { baseAfter });

  // ── D. 真实点击链路（用屏幕投影坐标派发 click） ──
  console.log('\n[D] 真实点击命中链路');
  await page.evaluate(() => window.__cockpit.dispatchSceneryClick(0));
  await sleep(120);
  const panelViaClick = await page.evaluate(() => window.__cockpit.scenicPanelOpen);
  ok('屏幕坐标派发的 click 命中风景并弹面板', panelViaClick === true);
  await page.evaluate(() => window.__cockpit.hideSceneryPanel());

  // ── E. 行驶中风景不可点（门控） ──
  console.log('\n[E] 行驶中门控（不干扰驾驶）');
  await page.evaluate(() => window.__cockpit.setDriving(true));
  await sleep(60);
  const driving = await page.evaluate(() => window.__cockpit.isDriving);
  ok('已进入行驶态', driving === true);
  await page.evaluate(() => window.__cockpit.dispatchSceneryClick(0));
  await sleep(120);
  const panelWhileDriving = await page.evaluate(() => window.__cockpit.scenicPanelOpen);
  ok('行驶中点击风景不弹面板（门控生效）', panelWhileDriving === false);
  // 门控后恢复
  await page.evaluate(() => window.__cockpit.setDriving(false));
  await sleep(60);

  // ── F. 0 JS 错误 ──
  console.log('\n[F] 运行期零错误');
  ok('无 pageerror', jsErrors.length === 0, jsErrors.slice(0, 3));

  await browser.close();
  console.log(`\n==== v0.9.20 风景可点 回归：${pass} pass / ${fail} fail ====`);
  if (fail) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
  else { console.log('ALL_PASS'); process.exit(0); }
})().catch(e => { console.error(e); process.exit(2); });
