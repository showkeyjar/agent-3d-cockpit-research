/* test_ux_fixes8.js — v0.9.15 推演凭据 + 兜底显式标记
 *
 * 验证目标（P1 真实性 / P2 可核对）：
 *   A. 四种来源（llm / fast / local / offline）在凭据条、候选区标签、说明文案上显式区分
 *   B. divergence / clusters（映射回候选名）/ road_type / execution_mode / cost_ms / fork_count 全部上屏
 *   C. 两批路牌（当前岔路 / 下一方向）分开记录，不互相覆盖
 *   D. 真实主推演链路：fast 本地预览 → 模型升级成功 / 模型未升级，凭据如实变化
 *   E. 真实未来牌链路：后端返回 source=local（模型掉线兜底）时显式标「本地兜底」
 *   F. 结果卡执行凭据：耗时 / 字数 / 执行链 / 来源 / 输入上下文；澄清卡不显示
 *   G. 3D 空间不变量未被触碰：camOffRail≈0、结果牌仍下沉、轨道仍淡化
 *   H. 0 JS 错误
 *
 * 纯前端 + fetch mock，不依赖 35B 单槽，秒级完成。
 */
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const CANDS = [
  { label: '查资料', sub: '避免瞎编', steps: ['检索', '整理'], rationale: '有依据', color: '#34f5a0', pos3d: [3, 0, 2] },
  { label: '梳理政策', sub: '外部环境', steps: ['检索', '对比'], rationale: '贴合主题', color: '#ffb13d', pos3d: [-2, 0, -3] },
  { label: '对比数据', sub: '横向参照', steps: ['取数', '对比'], rationale: '可核对', color: '#5ee0ff', pos3d: [2, 0, -4] },
];
const BASE = {
  divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
  clusters: [[0, 1], [2]], candidates: CANDS, cost_ms: 14520.4, fork_count: 2,
};

async function newPage(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.forecastProof, { timeout: 20000 });
  await sleep(400);
  return page;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const errors = [];

  // ─────────────── A/B/C：四态来源 + 数值上屏 + 两批分离 ───────────────
  console.log('\n=== A. 四态来源显式区分 ===');
  let page = await newPage(browser, errors);

  for (const [kind, badge, tag] of [
    ['llm', '模型推演', '模型推演'],
    ['fast', '本地预览', '本地预览'],
    ['local', '⚠ 本地兜底', '⚠ 本地兜底'],
    ['offline', '⚠ 前端模板', '⚠ 前端模板'],
  ]) {
    await page.evaluate(([k, m]) => window.__cockpit._proof(k, 'branch', m), [kind, BASE]);
    const r = await page.evaluate(() => ({
      badge: window.__cockpit.proofBadge,
      tag: window.__cockpit.branchProofTag,
      cls: document.getElementById('proofBar').className,
      kind: window.__cockpit.proofKind,
      note: document.getElementById('pfNote').textContent,
      source: document.getElementById('pfSource').textContent,
    }));
    check(`${kind}: badge「${badge}」+ 候选区标签一致`,
      r.badge === badge && r.tag === tag && r.kind === kind && r.cls.includes('src-' + kind),
      `badge=${r.badge} tag=${r.tag} cls=${r.cls}`);
    if (kind === 'local' || kind === 'offline') {
      check(`${kind}: 明说「模型未参与 / 后端不可达」`,
        /模型未参与|后端没有响应/.test(r.note) && /本地模板|前端固定模板|不是模型/.test(r.note),
        r.note.slice(0, 46) + '…');
    }
  }

  console.log('\n=== B. 推演数值上屏（clusters 映射回候选名） ===');
  await page.evaluate(m => window.__cockpit._proof('llm', 'branch', m), BASE);
  const nums = await page.evaluate(() => ({
    div: document.getElementById('pfDiv').textContent,
    road: document.getElementById('pfRoad').textContent,
    cl: document.getElementById('pfClusters').textContent,
    fork: document.getElementById('pfFork').textContent,
    cost: document.getElementById('pfCost').textContent,
  }));
  check('分歧度 D=0.4721 可见', nums.div.includes('0.4721'), nums.div);
  check('路形/执行模式已中文化', nums.road.includes('分岔路口') && nums.road.includes('选择'), nums.road);
  check('clusters 映射回候选名（旧版从未消费）',
    nums.cl.includes('2 簇') && nums.cl.includes('查资料') && nums.cl.includes('梳理政策') && nums.cl.includes('对比数据'), nums.cl);
  check('候选数 / 分叉数可见', nums.fork.includes('3 个候选') && nums.fork.includes('2 处分叉'), nums.fork);
  check('推演耗时可见', nums.cost.includes('14.52 s'), nums.cost);

  console.log('\n=== C. 两批路牌来源分离、折叠交互 ===');
  await page.evaluate(m => {
    window.__cockpit._proof('llm', 'branch', m);
    window.__cockpit._proof('local', 'future', { ...m, candidates: m.candidates.slice(0, 2) });
  }, BASE);
  const two = await page.evaluate(() => ({
    scope: document.getElementById('pfScope').textContent,
    branch: window.__cockpit.forecastProof.branch.kind,
    future: window.__cockpit.forecastProof.future.kind,
    cls: document.getElementById('proofBar').className,
    dot: document.getElementById('pfDot').style.background,
  }));
  check('两批来源并列显示，互不覆盖',
    two.branch === 'llm' && two.future === 'local' &&
    two.scope.includes('当前岔路：模型推演') && two.scope.includes('下一方向：⚠ 本地兜底'), two.scope);
  check('存在兜底批次时点亮告警（橙点 + 边框）',
    two.cls.includes('src-local') && /255, 177, 61|rgb\(255, 177, 61\)/.test(two.dot), two.dot);
  const before = await page.evaluate(() => window.__cockpit.proofOpen);
  await page.click('#pfHead');
  const after = await page.evaluate(() => window.__cockpit.proofOpen);
  check('可折叠 / 展开', before === false && after === true, `before=${before} after=${after}`);
  // 沉浸态：先收起（.open 状态下本就应保持全亮）、把鼠标移开
  // （#proofBar:hover 也设计为全亮，方便随时核对），并等 CSS 过渡结束再读
  await page.mouse.move(1200, 700);
  await page.evaluate(() => {
    document.getElementById('proofBar').classList.remove('open');
    document.body.classList.add('immersive');
  });
  await sleep(650);
  const imm = await page.evaluate(() => {
    const bar = document.getElementById('proofBar');
    const dim = getComputedStyle(bar).opacity;
    bar.classList.add('open');
    return { dim: +dim };
  });
  await sleep(650);
  const imm2 = await page.evaluate(() => {
    const bar = document.getElementById('proofBar');
    const opened = getComputedStyle(bar).opacity;
    document.body.classList.remove('immersive');
    bar.classList.remove('open');
    return { opened: +opened };
  });
  check('沉浸态下凭据淡出但展开即可查（不完全藏掉）',
    imm.dim > 0 && imm.dim < 0.6 && imm2.opened === 1,
    JSON.stringify({ ...imm, ...imm2 }));

  console.log('\n=== G. 3D 空间不变量未被触碰 ===');
  const inv = await page.evaluate(() => ({
    offRail: window.__cockpit.camOffRail,
    yOff: window.__cockpit.arrivalYOffset,
    width: window.__cockpit.arrivalSignWidth,
    opScale: window.__cockpit.roadOpacityScale,
    arrivalCamDist: window.__cockpit.arrivalCamDist,
  }));
  check('机位恒在路面中心线上方 camOffRail≈0', inv.offRail < 1e-6, String(inv.offRail));
  check('结果牌仍下沉 -1.05 / 宽 2.6 / 轨道淡化 0.7',
    inv.yOff === -1.05 && inv.width === 2.6 && inv.opScale === 0.7, JSON.stringify(inv));
  await page.close();

  // ─────────────── D：真实主推演链路（fast 预览 → 模型升级） ───────────────
  console.log('\n=== D1. 主推演链路：本地预览 → 模型升级成功 ===');
  page = await newPage(browser, errors);
  await page.route('**/api/forecast**', async route => {
    const fast = route.request().url().includes('fast=1');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...BASE, source: fast ? 'local' : 'llm', fast }),
    });
  });
  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__cockpit.proofKind === 'fast', { timeout: 15000 });
  check('fast 通道标「本地预览」，不伪装成模型推演',
    (await page.evaluate(() => window.__cockpit.proofBadge)) === '本地预览');
  await page.waitForFunction(() => window.__cockpit.proofKind === 'llm', { timeout: 20000 });
  const up = await page.evaluate(() => ({
    kind: window.__cockpit.proofKind, badge: window.__cockpit.proofBadge,
    tag: window.__cockpit.branchProofTag,
  }));
  check('完整推演回 source=llm 后凭据升级为「模型推演」',
    up.kind === 'llm' && up.badge === '模型推演' && up.tag === '模型推演', JSON.stringify(up));
  await page.close();

  console.log('\n=== D2. 主推演链路：模型未升级 → 显式标兜底 ===');
  page = await newPage(browser, errors);
  await page.route('**/api/forecast**', async route => {
    const fast = route.request().url().includes('fast=1');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...BASE, source: 'local', fast }),
    });
  });
  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__cockpit.proofKind === 'fast', { timeout: 15000 });
  await sleep(3400);   // 越过 2500ms 的完整推演触发窗口
  const noUp = await page.evaluate(() => ({
    kind: window.__cockpit.proofKind, badge: window.__cockpit.proofBadge,
    note: document.getElementById('pfNote').textContent,
  }));
  check('完整推演未返回 llm 时，从「本地预览」改为「⚠ 本地兜底」',
    noUp.kind === 'local' && noUp.badge === '⚠ 本地兜底' && noUp.note.includes('模型未参与'),
    `${noUp.kind} / ${noUp.badge}`);
  await page.close();

  // ─────────────── E：真实未来牌链路，后端返回 local ───────────────
  console.log('\n=== E. 未来牌推演：source=local 时不再静默冒充模型 ===');
  page = await newPage(browser, errors);
  const futureCands = [
    { label: '分析政策走向', sub: '外部环境', steps: ['检索', '梳理'], color: '#34f5a0' },
    { label: '对比区域电价', sub: '横向参照', steps: ['取数', '对比'], color: '#ffb13d' },
    { label: '梳理市场主体', sub: '参与者画像', steps: ['分类', '归纳'], color: '#5ee0ff' },
    { label: '评估风险敞口', sub: '不确定性', steps: ['识别', '量化'], color: '#ff5fe0' },
    { label: '整理时间线', sub: '演进脉络', steps: ['排序', '归纳'], color: '#ffd23f' },
  ];
  await page.route('**/api/forecast**', async route => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...BASE, source: 'local', fast: false, candidates: futureCands }),
    });
  });
  await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '先查资料', ['检索', '整理']));
  await page.waitForFunction(() => window.__cockpit.forecastProof.future !== null, { timeout: 15000 });
  const fut = await page.evaluate(() => ({
    kind: window.__cockpit.forecastProof.future.kind,
    badge: window.__cockpit.proofBadge,
    scope: document.getElementById('pfScope').textContent,
    toast: document.getElementById('toast').textContent,
    signs: window.__cockpit.future.length,
  }));
  check('未来牌被标「⚠ 本地兜底」（旧版完全不检查 source）',
    fut.kind === 'local' && fut.badge === '⚠ 本地兜底' && fut.scope.includes('下一方向：⚠ 本地兜底'),
    JSON.stringify({ kind: fut.kind, badge: fut.badge, scope: fut.scope }));
  check('toast 如实说明「模型未参与 · 本地兜底模板」（旧版写「已结合这段路铺出」）',
    fut.toast.includes('模型未参与') && fut.toast.includes('本地兜底'), fut.toast);
  check('兜底时路牌仍铺出（标记不等于禁用）', fut.signs === 5, `signs=${fut.signs}`);

  console.log('\n=== E2. 未来牌推演：source=llm 时标真实模型 ===');
  await page.unroute('**/api/forecast**');
  await page.route('**/api/forecast**', async route => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...BASE, source: 'llm', fast: false, candidates: futureCands }),
    });
  });
  await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '先查资料', ['检索', '整理']));
  await page.waitForFunction(() => window.__cockpit.forecastProof.future?.kind === 'llm', { timeout: 15000 });
  const fut2 = await page.evaluate(() => ({
    badge: window.__cockpit.proofBadge, toast: document.getElementById('toast').textContent,
  }));
  check('模型真推演时标「模型推演」且 toast 相应变化',
    fut2.badge === '模型推演' && fut2.toast.includes('模型推演出'), fut2.toast);
  await page.close();

  // ─────────────── F：结果卡执行凭据 ───────────────
  console.log('\n=== F. 结果卡执行凭据 ===');
  page = await newPage(browser, errors);
  await page.evaluate(() => {
    window.__cockpit._rcSet({
      ok: true, mode: 'choice', label: '查资料', title: '这一步做完了',
      context: '国内电力交易市场的格局？', question: '（模型追问）请说明范围',
      count: 1, elapsed: '12.3s',
      elapsed_ms: 12340, tokens: 186, chain: ['output'],
      source: 'llm', reason: '', tasks: [{ name: 'output', status: 'done', sub: '模型生成' }],
      output: '国内电力交易市场呈现中长期交易为主、现货试点并行推进的格局……',
      note: '', idx: 0, planned_steps: [],
    });
    window.__cockpit._rcShow();
  });
  const rp = await page.evaluate(() => ({
    text: window.__cockpit.resultProofText,
    visible: window.__cockpit.resultProofVisible,
    warn: document.getElementById('rcProof').classList.contains('warn'),
    question: document.getElementById('rcQuestion').textContent,
  }));
  check('耗时 / 字数 / 执行链 / 来源 / 输入上下文全部上屏',
    rp.visible && rp.text.includes('12.3s') && rp.text.includes('186 tokens') &&
    rp.text.includes('output') && rp.text.includes('模型真实产出') &&
    rp.text.includes('国内电力交易市场的格局'), rp.text.slice(0, 110));
  check('结果卡「你的问题」用用户原问题，不被模型追问覆盖',
    rp.question === '国内电力交易市场的格局？' && !rp.text.includes('（模型追问）'), rp.question);
  check('真实产出不误告警', rp.warn === false);

  await page.evaluate(() => {
    window.__cockpit._rcSet({
      ok: true, mode: 'choice', label: '查资料', question: '测试问题',
      count: 0, elapsed: '3s', elapsed_ms: 3000, tokens: 0, chain: [],
      source: 'local', reason: 'llm_failed', tasks: [], output: '', note: '',
      idx: 0, planned_steps: [], clarify: true,
    });
    window.__cockpit._rcShow();
  });
  const cl = await page.evaluate(() => ({
    visible: window.__cockpit.resultProofVisible,
    cardClarify: document.getElementById('resultCard').classList.contains('clarify'),
  }));
  check('澄清卡不展示执行凭据（未执行完不宣告）', cl.cardClarify && !cl.visible);
  await page.close();

  // ─────────────── H：JS 错误 ───────────────
  console.log('\n=== H. 运行时错误 ===');
  check('0 个 pageerror / console error', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n${'='.repeat(46)}`);
  console.log(`PASS=${pass}  FAIL=${fail}  =>  ${fail === 0 ? 'ALL_PASS ✅' : 'FAILED ❌'}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SCRIPT_ERROR', e); process.exit(1); });
