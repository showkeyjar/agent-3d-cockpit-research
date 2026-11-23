/* test_fi09.js — FI-09（v0.9.52）体验层两小项回归
 *
 * 子项1 触屏等价通道：触屏用「长按 ~520ms 出发」替代不可靠的 dblclick；
 *   复用 launchBranch 与鼠标双击走同一执行入口；轻点仍走现有 click 路径；
 *   触屏设备显示操作提示行。鼠标行为零变化。
 * 子项2 单槽等待感知：发出 execute 到首个真实 token 之间在任务条如实显示
 *   「等待推理槽 · 已等 Ns」，秒级更新；首 token / 收尾撤下；i18n 英文切换。
 *
 * 全部走 ?test=1 钩子 + _applyForecast 注入候选，不占真实模型槽，秒级完成。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/?test=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const CANDS = [
  { label: '触屏方向甲', sub: 'a', steps: ['检索'], rationale: 'r', color: '#34f5a0', pos3d: [3, 0, 2] },
  { label: '触屏方向乙', sub: 'b', steps: ['对比'], rationale: 'r', color: '#ffb13d', pos3d: [-2, 0, -3] },
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errors = [];

  // ── A. 触屏通道：长按候选牌 = 出发 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('A: ' + e.message));
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__cockpit._stubWs(true));
    await page.evaluate(f => window.__cockpit._applyForecast(f),
      { label: '探路', sub: 'x', steps: ['s'], rationale: 'r', color: '#5ee0ff',
        execution_mode: 'choice', candidates: CANDS, fork_count: 2 });
    await page.waitForTimeout(500);

    // 拿候选牌投影坐标，确保射线命中
    const spot = await page.evaluate(() => {
      const cp = window.__cockpit;
      for (const s of cp.signs.filter(s => s.userData.branchId >= 0)) {
        const p = cp.projectToScreen(s.position.x, s.position.y, s.position.z);
        if (p && cp.pickAt(p.x, p.y) >= 0) return { x: p.x, y: p.y, id: s.userData.branchId };
      }
      return null;
    });
    check('A0 候选牌可被射线命中', !!spot, spot ? `id=${spot.id}` : '无');

    if (spot) {
      const before = await page.evaluate(() => window.__cockpit.execState);
      const r = await page.evaluate(p => window.__cockpit.touchLongPressAtForTest(p.x, p.y), spot);
      const after = await page.evaluate(() => window.__cockpit.execState);
      check('A1 长按命中候选 id', r.picked === spot.id, `picked=${r.picked}`);
      check('A2 长按触发出发', r.launched === true, `done=${after.done}`);
      check('A3 出发后 execInfo 进入进行态', after.done === false,
        `before.done=${before.done} after.done=${after.done}`);
    }

    // launchBranchForTest 对空白/到达牌的守卫
    const guard = await page.evaluate(() => ({
      blank: window.__cockpit.launchBranchForTest(null),
      arrival: window.__cockpit.launchBranchForTest(-2),
      now: window.__cockpit.launchBranchForTest(-1),
    }));
    check('A4 空落点不出发', guard.blank === false);
    check('A5 到达牌长按不出发（仍走单击看结果）', guard.arrival === false);
    check('A6 现在牌不出发', guard.now === false);
    await page.close();
  }

  // ── B. 触屏提示行：仅触屏设备显示 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('B: ' + e.message));
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    const touch = await page.evaluate(() => window.__cockpit.isTouchDevice);
    const hint = await page.evaluate(() => {
      const el = document.getElementById('touchHint');
      return { exists: !!el, shown: el ? getComputedStyle(el).display !== 'none' : false,
               text: el ? el.textContent.trim() : '' };
    });
    check('B0 isTouchDevice 判定可用', typeof touch === 'boolean', `=${touch}`);
    check('B1 触屏提示行节点存在', hint.exists);
    check('B2 提示行文案含长按说明', /长按/.test(hint.text), hint.text);
    // 显式覆盖判定，测两个分支（无头 Chromium 默认 maxTouchPoints>0，不能靠环境默认值断言）
    const deskShown = await page.evaluate(() => {
      window.__cockpit.setTouchDeviceForTest(false);
      return getComputedStyle(document.getElementById('touchHint')).display !== 'none';
    });
    const touchShown = await page.evaluate(() => {
      window.__cockpit.setTouchDeviceForTest(true);
      return getComputedStyle(document.getElementById('touchHint')).display !== 'none';
    });
    check('B3 非触屏设备不显示提示行', deskShown === false, `shown=${deskShown}`);
    check('B4 触屏设备显示提示行', touchShown === true, `shown=${touchShown}`);
    await page.close();
  }

  // ── C. 单槽等待感知：显示 / 秒级 / 撤下 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('C: ' + e.message));
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await page.waitForTimeout(200);

    // 宽限内不显示
    await page.evaluate(() => window.__cockpit.startSlotWaitForTest());
    const t0 = await page.evaluate(() => window.__cockpit.slotWaitState);
    check('C0 等待态已激活', t0.active === true, JSON.stringify(t0));
    check('C1 600ms 宽限内不闪烁', t0.visible === false, JSON.stringify(t0));

    // 宽限后显示 + 文案
    await sleep(750);
    const t1 = await page.evaluate(() => window.__cockpit.slotWaitState);
    check('C2 宽限后在任务条显示等待行', t1.visible === true, JSON.stringify(t1));
    check('C3 文案含「等待推理槽」', /等待推理槽/.test(t1.text), t1.text);
    check('C4 文案含「已等」与秒数', /已等\s*\d+s/.test(t1.text), t1.text);

    // 秒级更新：再等 1.2s，秒数增加
    await sleep(1250);
    const t2 = await page.evaluate(() => window.__cockpit.slotWaitState);
    check('C5 秒数随时间递增', t2.seconds > t1.seconds, `${t1.seconds}s → ${t2.seconds}s`);

    // 撤下
    await page.evaluate(() => window.__cockpit.endSlotWaitForTest());
    const t3 = await page.evaluate(() => window.__cockpit.slotWaitState);
    check('C6 endSlotWait 后行移除', t3.visible === false && t3.active === false, JSON.stringify(t3));
    await page.close();
  }

  // ── D. 等待感知：真实收尾路径撤下 + 英文 i18n ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push('D: ' + e.message));
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await page.evaluate(() => window.__cockpit.startSlotWaitForTest());
    await sleep(750);
    // 模拟到达（finish 路径）后不应残留等待行
    await page.evaluate(() => window.__cockpit.simulateArrival({ source: 'llm' }));
    await page.waitForTimeout(200);
    const afterArrival = await page.evaluate(() => window.__cockpit.slotWaitState);
    check('D1 执行收尾后等待行不残留', afterArrival.visible === false, JSON.stringify(afterArrival));
    await page.close();

    const en = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    en.on('pageerror', e => errors.push('D-en: ' + e.message));
    await en.goto('http://127.0.0.1:8770/?test=1&lang=en', { waitUntil: 'load' });
    await en.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await en.evaluate(() => window.__cockpit.startSlotWaitForTest());
    await sleep(750);
    const enState = await en.evaluate(() => window.__cockpit.slotWaitState);
    check('D2 英文模式等待行文案英文化', /Awaiting inference slot/.test(enState.text), enState.text);
    await en.close();
  }

  // ── E. 零 JS 错误 ──
  check('E0 全程无 JS 运行时错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
