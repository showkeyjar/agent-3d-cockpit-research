// v0.9.23 回归：实用化三件套（常驻 HUD / 关键发现脊柱 / 决策溯源链）
// 纯前端 + __cockpit 钩子，用与真实到达完全相同的 detail 结构驱动，不依赖 35B 单槽，秒级。
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
function ok(name, cond, extra){ if (cond){ pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } }

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  console.log('\n[A] 初始态');
  const init = await page.evaluate(() => window.__cockpit.progressHudText);
  ok('HUD 初始显示「第 0 步 / 等待开始」', /第 0 步/.test(init) && /等待开始/.test(init), init);

  console.log('\n[B] 执行中 → HUD 进入「进行中」');
  await page.evaluate(() => { window.__cockpit._beginExec(0); window.__cockpit.refreshHud(); });
  const busy = await page.evaluate(() => ({ busy: window.__cockpit.progressHudBusy, text: window.__cockpit.progressHudText }));
  ok('HUD 标记 is-busy', busy.busy === true, busy);
  ok('HUD 文案含「进行中」', /进行中/.test(busy.text), busy.text);

  console.log('\n[C] 第一次到达 → 三件套同时更新');
  await page.evaluate(() => window.__cockpit.simulateArrival({ output: '电力市场由中长期交易与现货市场构成，主体为发电侧与用户侧。', source: 'llm' }));
  const c = await page.evaluate(() => ({
    text: window.__cockpit.progressHudText,
    cls: window.__cockpit.progressHudClass,
    ms: window.__cockpit.milestoneCount,
    dcOpen: window.__cockpit.dcToggle(true),
    dcNodes: window.__cockpit.decisionNodeCount,
    dcCount: window.__cockpit.decisionCountText,
  }));
  ok('HUD 显示「第 1 步」', /第 1 步/.test(c.text), c.text);
  ok('HUD 含真实结论摘要', /电力市场/.test(c.text), c.text);
  ok('HUD 来源徽章为 llm（src-llm）', /src-llm/.test(c.cls), c.cls);
  ok('关键发现脊柱：轨道里程碑 ≥ 1', c.ms >= 1, 'ms=' + c.ms);
  ok('决策链面板打开且有 1 个节点', c.dcNodes === 1, 'nodes=' + c.dcNodes);
  ok('决策链计数 = 1', c.dcCount === '1', c.dcCount);

  console.log('\n[D] 第二次到达 → 脊柱与决策链累积');
  await page.evaluate(() => window.__cockpit.simulateArrival({ output: '现货市场发现价格，分时节点形成日前与日内交易。', source: 'fast' }));
  const d = await page.evaluate(() => ({
    text: window.__cockpit.progressHudText, cls: window.__cockpit.progressHudClass,
    ms: window.__cockpit.milestoneCount, dcNodes: window.__cockpit.decisionNodeCount,
  }));
  ok('HUD 显示「第 2 步」', /第 2 步/.test(d.text), d.text);
  ok('HUD 第二次来源徽章为 fast', /src-fast/.test(d.cls), d.cls);
  ok('关键发现脊柱：里程碑累积 ≥ 2', d.ms >= 2, 'ms=' + d.ms);
  ok('决策链节点累积 = 2', d.dcNodes === 2, 'nodes=' + d.dcNodes);

  console.log('\n[E] 不变量：opaque 模式隐藏呈现层（含 HUD / 决策链）');
  await page.goto('http://127.0.0.1:8770/?mode=opaque', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const op = await page.evaluate(() => {
    const g = s => { const el = document.querySelector(s); return el ? getComputedStyle(el).display : 'missing'; };
    return { hud: g('#progressHud'), dc: g('#decisionChain') };
  });
  ok('opaque 下 HUD 被隐藏', op.hud === 'none', 'display=' + op.hud);
  ok('opaque 下决策链被隐藏', op.dc === 'none', 'display=' + op.dc);

  await browser.close();
  ok('全程无 JS 错误', errors.length === 0, errors.slice(0, 3));
  console.log(`\n===== v0.9.23 实用化回归：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试运行失败:', e); process.exit(2); });
