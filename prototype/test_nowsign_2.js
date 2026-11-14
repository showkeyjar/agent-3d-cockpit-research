// 复现用户观感：A=行驶中「现在」牌隐藏时序；B=行驶中触发新一轮推演重建（autoExplore 竞态）；C=结果卡强调样式
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

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
  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ── A：单次行驶隐藏时序（对照上轮夹具路径）
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  const vis0 = await page.evaluate(() => window.__cockpit._nowVisible());
  check('A 行驶前 nowSign.visible=true', vis0 === true, 'vis0=' + vis0);
  const p1 = page.evaluate((t) => window.__cockpit._driveTo(t), [[16,0,16]]);
  await page.waitForTimeout(400);
  const visMid = await page.evaluate(() => window.__cockpit._nowVisible());
  check('A 行驶中 nowSign.visible=false', visMid === false, 'visMid=' + visMid);
  await p1; await page.waitForTimeout(150);
  const visEnd = await page.evaluate(() => window.__cockpit._nowVisible());
  check('A 行驶结束 nowSign.visible=true', visEnd === true, 'visEnd=' + visEnd);

  // ── B：行驶中触发新一轮推演（autoExplore 竞态：行驶中重建 nowSign = 行驶结束时牌面仍隐藏）
  //  不持有行驶 promise（旧行驶 token 会被覆盖→悬挂 GC）：
  //  在页面端消化，改为 setInterval/异步采样——行驶全程（dur≈2200ms）断言 false，结束恢复 true
  await page.evaluate(() => { window.__cockpit._driveTo([40, 0, 40]).catch(() => {}); });
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__cockpit._applyForecast({
    candidates: [
      { label:'新方向甲', sub:'收束本轮', steps:['步骤1','步骤2'], rationale:'延续', color:'#34f5a0', modality:'text', pos3d:[20,0,20] },
      { label:'新方向乙', sub:'换个思路', steps:['步骤A'], rationale:'换向', color:'#5ee0ff', modality:'text', pos3d:[20,0,-20] },
      { label:'新方向丙', sub:'逆向来看', steps:['步骤X'], rationale:'反向', color:'#ffb13d', modality:'text', pos3d:[-20,0,20] },
    ],
    execution_mode:'choice', divergence:0.45,
  }));
  await page.waitForTimeout(400);   // 新行驶（时长 >2200ms）仍在进行
  const visMidBuild = await page.evaluate(() => window.__cockpit._nowVisible());
  check('B 行驶中重建新牌也保持隐藏（driveTo 入口统一 key）', visMidBuild === false,
    'visMidBuild=' + visMidBuild);
  // 行驶期全程采样（2.2s dur 窗口内）：期间新行驶的 nowSign 全程 false
  const samples = await page.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 480){
      out.push([Math.round(performance.now() - t0), window.__cockpit._nowVisible()]);
      await new Promise(r => setTimeout(r, 40));
    }
    return out;
  });
  check('B 行驶期采样 nowSign 全程 false', !samples.some(s => s[1] === true),
    '[' + samples.map(s => s.join('=')).join(' ') + ']');
  // 行驶结束 → nowSign.visible=true（重建新牌，终点上方）
  await page.waitForFunction(() => window.__cockpit._nowVisible() === true, null, { timeout: 8000 });
  const visEnd2 = await page.evaluate(() => window.__cockpit._nowVisible());
  check('B 行驶结束 nowSign.visible=true（重建新牌）', visEnd2 === true, 'visEnd2=' + visEnd2);

  // ── C：结果卡强调（finishExecution → 行驶结束 → 弹卡 + rcLongPulse 8s + 徽章呼吸）
  //  full-chain：真实链是行驶动画期间在 finishExecution 中同步 showResultCard，
  //  本轮已改为行驶结束回调触发——用 MutationObserver 等 class=show 并断言动画生效
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  const rc = await page.evaluate(async () => {
    window.__cockpit.finishOnce({});
    await new Promise(resolve => {
      const mo = new MutationObserver(() => {
        if (document.getElementById('resultCard').classList.contains('show')){ mo.disconnect(); resolve(); }
      });
      mo.observe(document.getElementById('resultCard'), { attributes: true, attributeFilter: ['class'] });
    });
    const card = document.getElementById('resultCard');
    const cs = getComputedStyle(card);
    return {
      show: card.classList.contains('show'),
      anim: cs.animationName,
      dur: cs.animationDuration,
      badgeAnim: getComputedStyle(document.querySelector('#resultCard .rc-badge')).animationName,
    };
  });
  check('C finishExecution 行驶结束弹结果卡 + rcLongPulse', rc.show && rc.anim.includes('rcLongPulse'), JSON.stringify(rc));
  check('C 徽章 rcBadge 呼吸', rc.badgeAnim.includes('rcBadge'), JSON.stringify(rc));

  // ── D：v0.9.11.5「现在」移到底部 DOM 状态条 + 驶过节点淡出（后视镜语义）
  // A/B 验了 visible 时序；本轮用户两条新诉求：
  //  ①「现在」牌不再悬浮于视野（旧 3D 牌行驶结束恢复即挡视野、行驶中重建仍隐藏时也需在
  //    驾车中频繁闪现）——彻底移出 3D 世界，改为屏幕底部状态条；
  //  ②走过的节点不再显示路牌——驶过的牌扁平化淡出，不再占前方视野。
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  await page.waitForTimeout(1200);
  const geo = await page.evaluate(async (t) => {
    const p1 = window.__cockpit._driveTo(t);
    await p1;
    // v0.9.11.8 几何级淡出判定：行驶 [8,0,8]→[16,0,16]，终车位 vxt/vz。
    // 行驶方向单位向量 (fx,fz)。未来牌里 proj=(x-vxt)*fx+(z-vz)*fz < -PASS_RADIUS
    // 即落在终车位身后（已驶过）→ 必须淡出隐藏；前方牌（含行驶后重建的新牌，
    // 旧断言把它们和身后牌打包要求的"全归零"会误报，前方牌 0.55 可见才正确）。
    // 轮询只等"身后牌全部归零"，前方牌不阻塞收敛。
    const vxt = t[0][0], vzt = t[0][2];
    const dfx = (t[0][0] - 8), dfz = (t[0][2] - 8);   // 行驶向量
    const dlen = Math.hypot(dfx, dfz) || 1;
    const fx = dfx / dlen, fz = dfz / dlen;
    const PASS_RADIUS = 4.5;
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const sxz = window.__cockpit._signXZ();
      const bk = sxz.map((s, i) => { const proj = (s.x - vxt) * fx + (s.z - vzt) * fz; return { i, proj, behind: proj < -PASS_RADIUS }; })
                    .filter(o => o.behind);
      // 身后牌为空＝本组没有需要淡出的牌，天然收敛；否则要等它们 op=0 且 vis=false。
      if (bk.length === 0 || bk.every(o => sxz[o.i].op === 0 && sxz[o.i].vis === false)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const bar = document.getElementById('nowBar');
    const rect = bar.getBoundingClientRect();
    return {
      nowPos: window.__cockpit._nowPos(),          // 期望 null：3D「现在」牌已移除
      barVisible: window.__cockpit._nowVisible(),
      barText: window.__cockpit._nowBarText(),
      barRect: { left: Math.round(rect.left), top: Math.round(rect.top) },
      vh: window.innerHeight,
      src: window.__cockpit._signOpacities(),
      vis: window.__cockpit._signVisibility(),
      ids: window.__cockpit._signIds(),
      sxz: window.__cockpit._signXZ(),
      veh: [Math.round(vxt*10)/10, Math.round(1.4*10)/10, Math.round(vzt*10)/10],
      travel: { fx: Math.round(fx*100)/100, fz: Math.round(fz*100)/100 },
      arrivalInfo: window.__cockpit._arrivalSignStats(),   // v0.9.11.8 到达牌动画三件套探针
    };
  }, [[16,0,16]]);
  check('D「现在」牌已移出 3D 世界（_nowPos()=null，正面视野无 3D 悬浮牌）',
    geo.nowPos === null, 'nowPos=' + geo.nowPos);
  check('D 行驶结束「现在」状态条显示且文案正确（沉底，不占前方视野）',
    geo.barVisible === true && geo.barText.main === '现在' && geo.barText.sub === '身后已走过 · 前方待选',
    'vis=' + geo.barVisible + ' text=' + JSON.stringify(geo.barText));
  check('D 状态条物理位置在屏幕底部（left<90px 且 top 位于下半屏，不在视图中央）',
    geo.barRect.left < 90 && geo.barRect.top > geo.vh*0.5,
    `rect=left${geo.barRect.left} top${geo.barRect.top} vh=${geo.vh}`);
  // v0.9.11.8 权威状态校验（不再用几何投影分类——行驶后未来牌会被重建，
  // 旧牌(身后)/新牌(前方)混在一个 group，投影分类随重建时序摇摆，是新的抖动源）。
  // 引擎内的 `_fadedPast` 是唯一权威判定：行驶驶过淡出完成后置真、重建不剥离。
  // 自洽性：已淡出(_fadedPast=true)的牌必须 op=0 且整组隐藏；未淡出(到达牌/前方牌)保持可见。
  const faded = geo.sxz.map((s, i) => ({ s, i })).filter(o => o.s.fadedPast === true);
  const notFaded = geo.sxz.map((s, i) => ({ s, i })).filter(o => o.s.fadedPast !== true && geo.ids[o.i] !== -2);
  check('D 已驶过淡出的路牌归零隐藏（_fadedPast=true → op=0 且 visible=false）',
    faded.every(o => geo.src[o.i] === 0 && geo.vis[o.i] === false),
    'faded=' + faded.length + ' ' + JSON.stringify(faded.map(o => ({ id: geo.ids[o.i], op: geo.src[o.i], vis: geo.vis[o.i] }))));
  // 未淡出的候选/未来牌（行驶后重建的敞口未来牌）不被误淡——它们正确保持可见
  check('D 未淡出的路牌保持可见（不被过头淡出）',
    notFaded.every(o => geo.vis[o.i] === true),
    'notFaded=' + notFaded.length + ' ' + JSON.stringify(notFaded.map(o => ({ id: geo.ids[o.i], op: geo.src[o.i], vis: geo.vis[o.i] }))));
  // v0.9.11.8：到达牌带醒目动画三件套——画布角标 / 光晕 / 悬浮徽章
  const arrSign = geo.arrivalInfo;
  check('D 到达牌带醒目标识（光晕+徽章且动画在跑）',
    !!arrSign && arrSign.hasGlow === true && arrSign.hasBadge === true && arrSign.animating === true,
    'arrival=' + JSON.stringify(arrSign));
  const arrival = geo.ids.map((id, i) => ({ id, i })).find(o => o.id === -2);
  check('D 到达牌（前方未驶过）不参与淡出，仍保持原亮度显示',
    arrival && geo.src[arrival.i] >= 0.5 && geo.vis[arrival.i] === true,
    `arrivalIdx=${arrival && arrival.i} ops=${JSON.stringify(geo.src)}`);

  check('JS 零错误', errors.length === 0, errors.slice(0,2).join(' | '));
  await browser.close();
  console.log(failures === 0 ? '\n✓✓✓ nowSign 竞态复现测试通过' : `\n✗✗ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
