const { resolveChromePath } = require('./chrome_helper');
// P6 沉浸形态冒烟验证：
//   ① I 键进入/退出沉浸：HUD 出现 + 桌面层抽屉化(~12% opacity) + 相机贴地（pitch 压平）
//   ② V 键立体：stereoRenders 实际执行 + composerRenders 冻结 + stereoOffsets≈0.03/0.03（IPD 对正）
//   ③ 关闭恢复：composer 恢复增长 + immersive/stereoOn 归 false
//   ④ WebXR 探测：无头 chromium 无沉浸式设备 → 按钮不出现、xrRenders 恒 0、全程 JS 零错误
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg); console.log('  ✓ ' + msg); };

async function main(){
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__cockpit.resetCamera(); window.__cockpit.setupTestArrival([8, 0, 8]); });
  await page.waitForTimeout(2000);

  // ── 0. 初始基线 ──
  const t0 = await page.evaluate(() => ({
    immersive: window.__cockpit.immersive, stereo: window.__cockpit.stereoOn,
    env: { composer: window.__p6Env.composerRenders, stereo: window.__p6Env.stereoRenders, xr: window.__p6Env.xrRenders },
    xrBtn: !!document.getElementById('xrBtn'),
    cam: window.__cockpit.cameraWorld(),
  }));
  console.log('=== 初始基线 ===', JSON.stringify(t0));
  assert(!t0.immersive && !t0.stereo, '初始为单目非沉浸');
  assert(t0.env.composer > 5, '默认渲染路径 = composer');
  assert(t0.env.stereo === 0 && t0.env.xr === 0, '无立体/xr 渲染');

  // ── 1. I 进入沉浸 ──
  await page.keyboard.press('i');
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() => ({
    immersive: window.__cockpit.immersive,
    hudDisp: getComputedStyle(document.getElementById('immersiveHud')).display,
    hudOpa: parseFloat(getComputedStyle(document.getElementById('immersiveHud')).opacity),
    ibOpa: parseFloat(getComputedStyle(document.getElementById('inputBar')).opacity),
    hbOpa: parseFloat(getComputedStyle(document.getElementById('headbar')).opacity),
    hudText: document.getElementById('immersiveHud').textContent,
    envComposer: window.__p6Env.composerRenders,   // 进入立体前的 composer 基线
    cam: window.__cockpit.cameraWorld(),
  }));
  console.log('=== 沉浸态 ===', JSON.stringify(t1));
  assert(t1.immersive, 'body 带 immersive class');
  assert(t1.hudDisp === 'block' && t1.hudOpa > 0.9, 'HUD 提示条可见');
  assert(Math.abs(t1.ibOpa - 0.12) < 0.05 && Math.abs(t1.hbOpa - 0.12) < 0.05, '桌面层抽屉化 ~12%');
  // v0.9.11.9：原断言「压平」基于 v0.9.8 旧 pitch 语义（正值=相机升高俯瞰）；
  // v0.9.11.4 语义翻转为「正值=仰视」后，0.30 会变视线上抬 17°看天（bug 已在代码修正），
  // 正确期望是沉浸仍保持水平视线（焦点沿用载具眼高，只有 dist 拉近到 3.4）。
  assert(Math.abs(t1.cam.pitch) < 0.15, '沉浸视线保持水平（俯仰 ' + t0.cam.pitch + '→' + t1.cam.pitch + '）');
  await page.screenshot({ path: 'shot_immersive.png' });

  // ── 2. V 开启立体 ──
  await page.keyboard.press('v');
  await page.waitForTimeout(1500);
  const t2 = await page.evaluate(() => ({
    stereo: window.__cockpit.stereoOn,
    env: { composer: window.__p6Env.composerRenders, stereo: window.__p6Env.stereoRenders },
    off: window.__cockpit.stereoOffsets,
    hudText: document.getElementById('immersiveHud').textContent,
  }));
  console.log('=== 立体开 ===', JSON.stringify(t2));
  assert(t2.stereo, 'stereoOn = true');
  assert(t2.env.stereo > 8, '立体渲染路径被实际执行（' + t2.env.stereo + ' 帧）');
  // 占比断言：立体期几乎全部走 stereoRenders（两步骤间 Playwright 有几十单调度空窗，
  // composer 的几帧增长发生在 V 键生效前，故用占比而非绝对零增长）
  const total = t2.env.stereo + (t2.env.composer - t1.envComposer);
  assert(t2.env.stereo / total > 0.8, '立体渲染占比 >80%（' + t2.env.stereo + '/' + total + '）');
  assert(Math.abs(t2.off.l - 0.03) < 0.01, '左眼偏移 ≈ IPD/2 (' + t2.off.l.toFixed(3) + ')');
  assert(Math.abs(t2.off.r - 0.03) < 0.01, '右眼偏移 ≈ IPD/2 (' + t2.off.r.toFixed(3) + ')');
  assert(t2.hudText.includes('立体开'), 'HUD 文案联动');
  await page.screenshot({ path: 'shot_stereo.png' });

  // ── 3. 关立体 + 退出沉浸 ──
  await page.keyboard.press('v');
  await page.keyboard.press('i');
  await page.waitForTimeout(1200);
  const t3 = await page.evaluate(() => ({
    immersive: window.__cockpit.immersive, stereo: window.__cockpit.stereoOn,
    env: { composer: window.__p6Env.composerRenders },
    hudDisp: getComputedStyle(document.getElementById('immersiveHud')).display,
    cam: window.__cockpit.cameraWorld(),
  }));
  console.log('=== 恢复 ===', JSON.stringify(t3));
  assert(!t3.immersive && !t3.stereo, '状态全部归位');
  assert(t3.hudDisp === 'none', 'HUD 收起');
  assert(t3.env.composer > t0.env.composer + 10, 'composer 恢复增长');

  // ── 4. WebXR 探测 ──
  const xr = await page.evaluate(() => ({
    hasXrApi: typeof navigator.xr !== 'undefined',
    xrBtn: !!document.getElementById('xrBtn'),
    xrRenders: window.__p6Env.xrRenders,
  }));
  console.log('=== WebXR ===', JSON.stringify(xr));
  assert(xr.xrRenders === 0, '未走 WebXR 渲染分支');
  if (!xr.hasXrApi) console.log('  · chromium 无 WebXR API → 探测静默退出（有头显真机时挂「进入 VR」按钮）');

  console.log('JS 错误:', errors.length === 0 ? '0' : JSON.stringify(errors));
  assert(errors.length === 0, '全程 JS 零错误');
  await browser.close();
  console.log('P6 冒烟测试全部通过 ✔');
}

main().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
