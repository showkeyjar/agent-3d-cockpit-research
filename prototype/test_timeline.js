const { resolveChromePath } = require('./chrome_helper');
/* test_timeline.js — v0.9.17 P1：2D 时间线 / 多轮对照 / 分叉重走 / 导出
 *
 * 验证目标：
 *   A. 面板开关（按钮 / T 键 / Esc）、空态、沉浸态淡出
 *   B. 逐轮记录：四态来源（llm/fast/local/offline）在 2D 里照样显式标注；
 *      完成 / 已中断 / 待补充三态不混；凭据（耗时 / tokens / 链 / 聚类 / 候选名）可核对
 *   C. 多轮并排对照：选两条、超两条滚动、清空
 *   D. 分叉重走：真实重新推演 + 真实 WS execute，产生 parent_run_id 新记录；
 *      旧记录原封不动、新结果不等于旧结果（反「回放冒充」）
 *   E. 导出：JSON 结构 / 四态计数 / 不含内部 detail；CSV 平坦字段 + 引号逗号换行转义
 *   F. 3D 空间不变量与中断态不回退；0 JS 错误
 *
 * 纯前端 + fetch mock + WS 桩，不占用 35B 单槽，秒级完成。
 */
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const CANDS = [
  { label: '查资料', sub: '避免瞎编', steps: ['检索', '整理'], color: '#34f5a0', pos3d: [3, 0, 2] },
  { label: '梳理政策', sub: '外部环境', steps: ['检索', '对比'], color: '#ffb13d', pos3d: [-2, 0, -3] },
  { label: '对比数据', sub: '横向参照', steps: ['取数', '对比'], color: '#5ee0ff', pos3d: [2, 0, -4] },
];
const BASE = {
  divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
  clusters: [[0, 1], [2]], candidates: CANDS, cost_ms: 14520.4, fork_count: 2,
};
const CONTEXT = '国内电力交易市场的格局？';

function detail(i, extra = {}) {
  return {
    ok: true, mode: 'choice', label: '方向' + i, title: '这一步做完了',
    context: CONTEXT, question: '', count: 1, elapsed: '3.2s',
    elapsed_ms: 3200 + i * 100, tokens: 120 + i, chain: ['output'],
    tasks: [{ name: 'output', sub: '模型生成', status: 'done' }],
    output: `这是第 ${i} 轮真实产出的结果文本，用来核对。`,
    source: 'llm', reason: '', idx: 0, note: '', planned_steps: [],
    clarify: false, pos: [1, 0, 2], branchLabel: '方向' + i, ...extra,
  };
}

async function newPage(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.runs), null, { timeout: 20000 });
  await sleep(400);
  return page;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const errors = [];

  // ─────────────── A. 面板开关 / 空态 / 3D 不变量 ───────────────
  console.log('\n=== A. 面板开关、空态、沉浸态 ===');
  let page = await newPage(browser, errors);
  const init = await page.evaluate(() => ({
    n: window.__cockpit.runCount, open: window.__cockpit.timelineOpen,
    nodes: window.__cockpit.timelineNodes, count: window.__cockpit.timelineCount,
    cardOpen: window.__cockpit.resultCardOpen,
  }));
  check('初始 0 轮 / 面板收起 / 计数 0',
    init.n === 0 && init.open === false && init.nodes === 0 && init.count === '0', JSON.stringify(init));
  check('打开时间线不会劫持 3D 结果卡', init.cardOpen === false);

  await page.click('#timelineBtn');
  const opened = await page.evaluate(() => ({
    open: window.__cockpit.timelineOpen,
    text: document.getElementById('tlStrip').textContent,
  }));
  check('按钮打开面板并给出诚实空态',
    opened.open && opened.text.includes('还没有走过任何一轮'), opened.text.slice(0, 30));

  await page.keyboard.press('t');
  check('T 键收起', (await page.evaluate(() => window.__cockpit.timelineOpen)) === false);
  await page.keyboard.press('t');
  check('T 键再打开', (await page.evaluate(() => window.__cockpit.timelineOpen)) === true);
  await page.keyboard.press('Escape');
  check('空闲时 Esc 收起（执行中 Esc 仍是停止生成）',
    (await page.evaluate(() => window.__cockpit.timelineOpen)) === false);

  await page.evaluate(() => {
    window.__cockpit._toggleTimeline(true);
    document.body.classList.add('immersive');
  });
  await sleep(650);
  const immOpacity = await page.evaluate(() => +getComputedStyle(document.getElementById('timelinePanel')).opacity);
  await page.evaluate(() => document.body.classList.remove('immersive'));
  check('沉浸态下 2D 面板淡出但不销毁', immOpacity > 0 && immOpacity < 0.6, String(immOpacity));

  const inv = await page.evaluate(() => ({
    offRail: window.__cockpit.camOffRail,
    yOff: window.__cockpit.arrivalYOffset,
    width: window.__cockpit.arrivalSignWidth,
    opScale: window.__cockpit.roadOpacityScale,
  }));
  check('3D 空间不变量未回退（camOffRail≈0 / 结果牌 -1.05 / 轨道 0.7）',
    inv.offRail < 1e-6 && inv.yOff === -1.05 && inv.width === 2.6 && inv.opScale === 0.7,
    JSON.stringify(inv));

  // ─────────────── B. 四轮记录 + 四态来源标注 ───────────────
  console.log('\n=== B. 逐轮记录与来源四态显式标注 ===');
  const plan = [
    ['llm', 'done', {}, '模型推演'],
    ['fast', 'done', {}, '本地预览'],
    ['local', 'interrupted', { ok: false, interrupted: true, output: '中断前的部分文本' }, '⚠ 本地兜底'],
    ['offline', 'clarify', { ok: false, clarify: true, output: '' }, '⚠ 前端模板'],
  ];
  for (let i = 0; i < plan.length; i++) {
    const [kind, status, extra] = plan[i];
    await page.evaluate(([k, d, s]) => {
      window.__cockpit._proof(k, 'branch', {
        divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
        clusters: [[0, 1], [2]], candidates: [
          { label: '查资料' }, { label: '梳理政策' }, { label: '对比数据' },
        ], cost_ms: 14520.4, fork_count: 2, source: k,
      });
      window.__cockpit._recordRun(d, s);
    }, [kind, detail(i + 1, extra), status]);
  }
  const rec = await page.evaluate(() => ({
    runs: window.__cockpit.runs,
    nodes: window.__cockpit.timelineNodes,
    strip: document.getElementById('tlStrip').textContent,
    sub: window.__cockpit.timelineSubText,
    srcs: [...document.querySelectorAll('#tlStrip .tl-src')].map(e => ({ cls: e.className, t: e.textContent })),
  }));
  check('4 轮各一条记录 / 4 个节点', rec.runs.length === 4 && rec.nodes === 4,
    `runs=${rec.runs.length} nodes=${rec.nodes}`);
  check('四态 kind 逐轮如实写入，不被洗成 llm',
    rec.runs.map(r => r.forecast.kind).join(',') === 'llm,fast,local,offline',
    rec.runs.map(r => r.forecast.kind).join(','));
  check('节点上四态标签全部可见（含两个 ⚠ 兜底）',
    rec.srcs.length === 4 && rec.srcs[0].t === '模型推演' && rec.srcs[1].t === '本地预览' &&
    rec.srcs[2].t === '⚠ 本地兜底' && rec.srcs[3].t === '⚠ 前端模板' &&
    rec.srcs[2].cls.includes('local') && rec.srcs[3].cls.includes('offline'),
    rec.srcs.map(s => s.t).join(' / '));
  check('汇总行明说兜底轮数，不把兜底算成模型推演',
    rec.sub.includes('2 轮为本地/前端兜底'), rec.sub);
  check('中断 / 澄清不与完成混为一谈',
    rec.runs[2].status === 'interrupted' && rec.runs[3].status === 'clarify' &&
    rec.runs[0].status === 'done' && rec.strip.includes('已中断') && rec.strip.includes('待补充'));
  check('中断轮保留部分真实文本（不是空卡）',
    rec.runs[2].output === '中断前的部分文本');

  // 选中第 3 轮看详情凭据
  await page.evaluate(() => {
    const nodes = document.querySelectorAll('#tlStrip .tl-node');
    nodes[2].click();
  });
  const det = await page.evaluate(() => window.__cockpit.timelineDetailText);
  check('详情含用户原问题 / 方向 / 推演来源说明',
    det.includes(CONTEXT) && det.includes('方向3') && det.includes('模型未参与'), det.slice(0, 80).replace(/\n/g, ' '));
  check('详情含执行耗时 / tokens / 执行链 / 聚类映射回候选名',
    det.includes('3.50 s') && det.includes('123 tokens') && det.includes('output') &&
    det.includes('查资料') && det.includes('梳理政策'), det.slice(0, 140).replace(/\n/g, ' '));
  check('详情明说「由用户主动停止，未记入完成轨迹」',
    det.includes('由用户主动停止') && det.includes('未记入完成轨迹'));

  // ─────────────── C. 多轮并排对照 ───────────────
  console.log('\n=== C. 多轮并排对照 ===');
  await page.evaluate(() => {
    window.__cockpit._toggleCompare('r1');
    window.__cockpit._toggleCompare('r2');
  });
  const cmp = await page.evaluate(() => ({
    ids: window.__cockpit.timelineCompareIds,
    vis: window.__cockpit.timelineCompareVisible,
    text: document.getElementById('tlCompare').textContent,
  }));
  check('选两轮即显示并排对照',
    cmp.vis && cmp.ids.join(',') === 'r1,r2' && cmp.text.includes('第 1 轮 vs 第 2 轮'),
    cmp.ids.join(','));
  check('对照含两轮推演来源 / 执行凭据 / 结果全文',
    cmp.text.includes('模型推演') && cmp.text.includes('本地预览') &&
    cmp.text.includes('3.30 s') && cmp.text.includes('3.40 s') &&
    cmp.text.includes('这是第 1 轮') && cmp.text.includes('这是第 2 轮'));
  await page.evaluate(() => window.__cockpit._toggleCompare('r3'));
  const cmp3 = await page.evaluate(() => window.__cockpit.timelineCompareIds);
  check('加第三轮只保留最近两条', cmp3.join(',') === 'r2,r3', cmp3.join(','));
  await page.click('#tlCompareClear');
  check('清空对照后面板收起',
    !(await page.evaluate(() => window.__cockpit.timelineCompareVisible)) &&
    (await page.evaluate(() => window.__cockpit.timelineCompareIds)).length === 0);

  // ─────────────── E. 导出（放在分叉前，先验证干净 4 轮） ───────────────
  console.log('\n=== E. 导出 JSON / CSV（研究数据出口） ===');
  const exp = await page.evaluate(() => ({ json: window.__cockpit._exportRuns('json'), csv: window.__cockpit._exportRuns('csv') }));
  const J = JSON.parse(exp.json);
  check('JSON 含 schema / 版本 / 导出时间 / 会话起点 / summary / runs',
    J.schema === 'agent-3d-cockpit/runs@1' && J.prototype_version === 'v0.9.17' &&
    !!J.exported_at && !!J.session_started_at && !!J.summary && J.runs.length === 4);
  check('summary 四态与三态计数正确',
    J.summary.forecast_llm === 1 && J.summary.forecast_fast === 1 &&
    J.summary.forecast_local === 1 && J.summary.forecast_offline === 1 &&
    J.summary.done === 2 && J.summary.interrupted === 1 && J.summary.clarify === 1,
    JSON.stringify(J.summary));
  check('每轮导出含推演来源 / 分支关系 / 执行凭据 / 结果全文',
    J.runs.every(r => r.forecast && 'kind' in r.forecast && 'parent_run_id' in r &&
      r.exec && 'elapsed_ms' in r.exec && 'chain' in r.exec && 'output' in r));
  check('内部只读 detail 不进导出', J.runs.every(r => !('detail' in r)));
  const csvLines = exp.csv.split('\r\n');
  check('CSV 表头含平坦字段、行数 = 轮数 + 1',
    csvLines[0].includes('run_id,seq,ts') && csvLines[0].includes('forecast_kind') &&
    csvLines[0].includes('exec_elapsed_ms') && csvLines.length === 5,
    `lines=${csvLines.length}`);
  check('CSV 数据行含状态与来源标记',
    csvLines[3].includes('r3') && csvLines[3].includes('interrupted') && csvLines[3].includes('local'));

  // 特殊字符转义：追加一轮带逗号 / 引号 / 换行的问题
  await page.evaluate(() => window.__cockpit._recordRun({
    ok: true, context: '含逗号,引号"和\n换行的问题', label: '转义测试', output: 'A,B\n"C"',
    elapsed_ms: 900, tokens: 8, chain: ['output'], source: 'llm', pos: null,
  }, 'done'));
  const csvEsc = await page.evaluate(() => window.__cockpit._exportRuns('csv'));
  check('CSV 对逗号 / 双引号 / 换行正确转义',
    csvEsc.includes('"含逗号,引号""和\n换行的问题"') && csvEsc.includes('"A,B\n""C"""'));

  // 下载按钮：真实触发一次浏览器下载
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#tlExportJson'),
  ]);
  check('点击「导出 JSON」真实生成下载文件',
    !!dl[0] && /\.json$/.test(dl[0].suggestedFilename()),
    dl[0] ? dl[0].suggestedFilename() : '未触发 download 事件');

  await page.close();

  // ─────────────── D. 分叉重走：真实新执行，不是回放 ───────────────
  console.log('\n=== D. 任意节点分叉重走（真实推演 + 真实执行） ===');
  page = await newPage(browser, errors);
  await page.route('**/api/forecast**', async route => {
    const fast = route.request().url().includes('fast=1');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...BASE, source: fast ? 'local' : 'llm', fast }),
    });
  });
  await page.evaluate(() => window.__cockpit._stubWs(true));
  await page.evaluate(() => {
    window.__cockpit._proof('llm', 'branch', {
      divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
      clusters: [[0, 1], [2]], candidates: [
        { label: '查资料' }, { label: '梳理政策' }, { label: '对比数据' },
      ], cost_ms: 14520.4, fork_count: 2, source: 'llm',
    });
    const d1 = {
      ok: true, mode: 'choice', label: '查资料', context: '国内电力交易市场的格局？',
      output: '原始结果A（第 1 轮）', elapsed_ms: 3100, tokens: 110,
      chain: ['output'], source: 'llm', pos: [2, 0, 2], branchLabel: '查资料',
    };
    const d2 = { ...d1, label: '梳理政策', output: '原始结果B（第 2 轮）', branchLabel: '梳理政策' };
    window.__cockpit._recordRun(d1, 'done');
    window.__cockpit._recordRun(d2, 'done');
  });
  const before = await page.evaluate(() => window.__cockpit.runs.map(r => ({ id: r.run_id, out: r.output })));
  check('分叉前已有 2 轮记录', before.length === 2, JSON.stringify(before));

  await page.evaluate(() => window.__cockpit._forkFrom('r1'));
  const hook = await page.evaluate(() => ({
    active: window.__cockpit.replayHookActive,
    input: document.getElementById('msgInput').value,
    open: window.__cockpit.timelineOpen,
  }));
  check('重走把原问题放回输入框、收起面板、挂上一次性钩子',
    hook.input === CONTEXT && hook.open === false, JSON.stringify(hook));

  await page.waitForFunction(() => window.__cockpit.execState.done === false, null, { timeout: 25000 });
  const executing = await page.evaluate(() => ({
    exec: window.__cockpit.execState,
    wsLog: window.__cockpit.wsLog,
    fork: window.__cockpit.forkCtxActive,
    hook: window.__cockpit.replayHookActive,
  }));
  const execMsg = executing.wsLog.filter(m => m.type === 'execute').pop();
  check('推演落位后真实进入执行态（不是把旧结果重放一遍）',
    executing.exec.done === false && executing.fork === true && executing.hook === false,
    JSON.stringify(executing.exec));
  check('出站 WS 确有 type=execute，且 context/label 来自父轮',
    !!execMsg && execMsg.context === CONTEXT && execMsg.label === '查资料',
    execMsg ? `${execMsg.type} / ${execMsg.label}` : '无 execute 出站消息');

  await page.evaluate(() => window.__cockpit._injectWs({
    type: 'execute_done', ok: true, output: '这是分叉重走后模型新产出的结果文本（第 3 轮）',
    source: 'llm', reason: '', elapsed_ms: 4200, tokens: 188, chain: ['output'],
    tasks: [{ name: 'output', sub: '模型生成', status: 'done' }], label: '查资料',
    planned_steps: [], clarify: false,
  }));
  await page.waitForFunction(() => window.__cockpit.runCount === 3, null, { timeout: 30000 });
  const after = await page.evaluate(() => ({
    runs: window.__cockpit.runs,
    nodes: window.__cockpit.timelineNodes,
    forkNode: !!document.querySelector('#tlStrip .tl-node.fork'),
    sub: window.__cockpit.timelineSubText,
    forkCtx: window.__cockpit.forkCtxActive,
  }));
  const r1 = after.runs[0], r3 = after.runs[2];
  check('新结果作为独立分叉追加，原 2 轮记录原封不动',
    after.runs.length === 3 && r1.run_id === 'r1' &&
    r1.output === '原始结果A（第 1 轮）' && r1.parent_run_id === null &&
    after.runs[1].output === '原始结果B（第 2 轮）');
  check('第 3 轮 parent_run_id=r1 / fork_of_seq=1',
    r3.parent_run_id === 'r1' && r3.fork_of_seq === 1, JSON.stringify({ p: r3.parent_run_id, s: r3.fork_of_seq }));
  check('方向命中父轮原方向时记 fork_matched=true',
    r3.fork_matched === true && r3.fork_actual_label === '查资料');
  check('第 3 轮结果是新产出，不等于父轮结果（反回放）',
    r3.output.includes('分叉重走后模型新产出') && r3.output !== r1.output &&
    r3.status === 'done' && r3.exec.elapsed_ms === 4200 && r3.exec.tokens === 188,
    r3.output.slice(0, 24));
  check('分叉轮推演来源如实标 fast（本地预览未被洗成模型推演）',
    r3.forecast.kind === 'fast' || r3.forecast.kind === 'local', r3.forecast.kind);
  check('时间线显示 3 个节点 / 分叉标记 / 汇总写「1 次分叉」',
    after.nodes === 3 && after.forkNode && after.sub.includes('1 次分叉'), after.sub);
  check('分叉上下文已消费，不会串到下一轮', after.forkCtx === false);

  // 再导出一次，验证分支关系进 JSON/CSV
  const forkExp = await page.evaluate(() => ({ json: window.__cockpit._exportRuns('json'), csv: window.__cockpit._exportRuns('csv') }));
  const FJ = JSON.parse(forkExp.json);
  check('导出 summary.forks=1 且分叉行 parent_run_id 落盘',
    FJ.summary.forks === 1 && FJ.runs[2].parent_run_id === 'r1' && forkExp.csv.includes('r1'));

  await page.close();

  console.log('\n=== F. 运行时错误 ===');
  check('0 个 JS 错误（pageerror / console.error）', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n${fail === 0 ? '✅ ALL_PASS' : '❌ FAIL'} — ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
