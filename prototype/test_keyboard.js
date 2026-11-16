const { resolveChromePath } = require('./chrome_helper');
/* test_keyboard.js — v0.9.19 P2：键盘等价视图（全键盘可达）
 *
 * 验证目标：
 *   A. 分支键盘选路状态机（首次进入停 0、前进/后退、边界 clamp、focusBranch 联动卡片 active）
 *   B. 分支键盘出发：Enter 触发与鼠标双击等价的 startExecution（桩 WS，不占 35B），出发后退出导航
 *   C. 未来方向键盘导航：Tab 在 branch/future 间切换、组内移动、Enter 走 travelFuture
 *   D. 到达结果键盘开关：清候选后进入 arrival 组，kbGo 开/收结果卡（等价单击到达牌）
 *   E. 监听器层：真实按键 + 输入框聚焦时键盘通道不触发（activeElement 保护）
 *   F. 3D 空间不变量零回退（机位仍贴轨）+ 全程 0 JS 错误
 *
 * 纯前端；WS 桩 + _applyForecast / setupTestArrival 注入，秒级完成。
 * 注：_exploreNext 经 WS 异步回填 _futureCandidates，桩 WS 下不回填；故 C/D 用同步的
 *     setupTestArrival（它同步填好 _futureCandidates 与 _arrivalResults）来验证状态机。
 */
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const CANDS = [
  { label: '查资料', sub: '避免瞎编', steps: ['检索', '整理', '回答'], rationale: '提升准确度', color: '#34f5a0', pos3d: [3, 0, 2] },
  { label: '梳理政策', sub: '外部环境', steps: ['检索', '对比'], rationale: '看清边界', color: '#ffb13d', pos3d: [-2, 0, -3] },
  { label: '对比数据', sub: '横向参照', steps: ['取数', '对比'], rationale: '量化差异', color: '#5ee0ff', pos3d: [2, 0, -4] },
];
const FORECAST = {
  __proofKind: 'llm', source: 'llm', divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
  clusters: [[0, 1], [2]], candidates: CANDS, cost_ms: 14520.4, fork_count: 2,
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
  await sleep(300);
  await page.evaluate(() => window.__cockpit._stubWs(true));
  await page.evaluate(f => window.__cockpit._applyForecast(JSON.parse(f)), JSON.stringify(FORECAST));
  await sleep(200);
  await page.evaluate(() => window.__cockpit._kbExit());

  // A. 分支键盘选路状态机
  let s = await page.evaluate(() => window.__cockpit._kbNav(1));
  check('A1 首次 [ 进入 branch 组', s.group === 'branch', JSON.stringify(s));
  check('A2 首次进入选中第 0 条', s.sel === 0, 'sel=' + s.sel);
  s = await page.evaluate(() => window.__cockpit._kbNav(1));
  check('A3 ] 前进到 1', s.sel === 1);
  s = await page.evaluate(() => window.__cockpit._kbNav(1));
  check('A4 前进到 2', s.sel === 2);
  s = await page.evaluate(() => window.__cockpit._kbNav(1));
  check('A5 越界 clamp 在 2', s.sel === 2);
  s = await page.evaluate(() => window.__cockpit._kbNav(-1));
  check('A6 [ 后退到 1', s.sel === 1);
  const activeIdx = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.branch-card')];
    return cards.findIndex(c => c.classList.contains('active'));
  });
  check('A7 focusBranch 把对应卡片标 active', activeIdx === 1, 'activeIdx=' + activeIdx);

  // B. 分支键盘出发（桩 WS，进入执行态而不真跑 35B）
  await page.evaluate(() => window.__cockpit._kbNav(-1)); // 回到 0
  await page.evaluate(() => window.__cockpit._kbGo());
  const after = await page.evaluate(() => window.__cockpit.execState);
  check('B1 kbGo 在 branch 组触发执行（done=false）', after.done === false, JSON.stringify(after));
  check('B2 出发后退出键盘导航', (await page.evaluate(() => window.__cockpit.kbGroup)) === null);
  await page.evaluate(() => window.__cockpit._endExec());
  await page.evaluate(() => window.__cockpit._kbExit());

  // C. 未来方向键盘导航（setupTestArrival 同步提供 future + arrival）
  await page.evaluate(f => window.__cockpit._applyForecast(JSON.parse(f)), JSON.stringify(FORECAST));
  await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
  await sleep(150);
  const fc = await page.evaluate(() => window.__cockpit.kbFutures.length);
  check('C1 已注入未来候选', fc >= 1, 'future=' + fc);
  await page.evaluate(() => window.__cockpit._kbNav(1)); // 先进入 branch 组
  let g = await page.evaluate(() => window.__cockpit._kbSwitch());
  check('C2 Tab 从 branch 切到 future 组', g === 'future', 'group=' + g);
  s = await page.evaluate(() => window.__cockpit._kbNav(1));
  check('C3 future 组内前进', s.group === 'future' && s.sel >= 0, JSON.stringify(s));
  await page.evaluate(() => window.__cockpit._kbGo());
  const aft2 = await page.evaluate(() => window.__cockpit.execState);
  check('C4 future kbGo 触发执行（done=false）', aft2.done === false, JSON.stringify(aft2));
  check('C5 future 出发后退出导航', (await page.evaluate(() => window.__cockpit.kbGroup)) === null);
  await page.evaluate(() => window.__cockpit._endExec());
  await page.evaluate(() => window.__cockpit._kbExit());

  // D. 到达结果键盘开关（清分支候选后进入 arrival 组）
  await page.evaluate(() => window.__cockpit.clearBranches());
  await page.evaluate(() => window.__cockpit.setupTestArrival([8, 0, 8]));
  await page.evaluate(() => window.__cockpit._clearCandidates());
  await sleep(150);
  await page.evaluate(() => window.__cockpit._kbExit());
  let dg = await page.evaluate(() => window.__cockpit._kbNav(-1)); // branch 空 → arrival
  check('D1 清空候选后 [ 进入 arrival 组', dg.group === 'arrival', JSON.stringify(dg));
  await page.evaluate(() => window.__cockpit._kbGo());
  const open1 = await page.evaluate(() => window.__cockpit.resultCardOpen);
  check('D2 kbGo 打开结果卡', open1 === true);
  await page.evaluate(() => window.__cockpit._kbGo());
  const open2 = await page.evaluate(() => window.__cockpit.resultCardOpen);
  check('D3 再 kbGo 收起结果卡', open2 === false);
  await page.evaluate(() => window.__cockpit._kbExit());

  // E. 监听器层：真实按键 + 输入框保护
  await page.evaluate(() => window.__cockpit._kbExit());
  await page.evaluate(f => window.__cockpit._applyForecast(JSON.parse(f)), JSON.stringify(FORECAST));
  await sleep(150);
  await page.focus('#msgInput');
  await page.keyboard.press('[');
  const eg = await page.evaluate(() => window.__cockpit.kbGroup);
  check('E1 输入框聚焦时 [ 不进入导航', eg === null, 'group=' + eg);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('[');
  const eg2 = await page.evaluate(() => window.__cockpit.kbGroup);
  check('E2 非输入框时 [ 进入 branch 导航', eg2 === 'branch', 'group=' + eg2);
  await page.keyboard.press('Enter');
  const eGo = await page.evaluate(() => window.__cockpit.execState);
  check('E3 监听器层 Enter 触发出发（done=false）', eGo.done === false, JSON.stringify(eGo));
  await page.evaluate(() => window.__cockpit._endExec());
  await page.evaluate(() => window.__cockpit._kbExit());

  // F. 3D 不变量未破 + 0 JS 错误
  const offRail = await page.evaluate(() => window.__cockpit.camOffRail);
  check('F1 机位仍贴轨（camOffRail≈0）', offRail < 0.01, 'offRail=' + offRail.toFixed(4));
  check('F2 全程 0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n键盘等价视图回归：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
