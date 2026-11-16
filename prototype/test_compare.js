const { resolveChromePath } = require('./chrome_helper');
/* test_compare.js — v0.9.18 P2：本轮候选并排对比 + 自定义方向
 *
 * 验证目标：
 *   A. 对比面板：工具条随候选出现；C 键 / 按钮开关；列数 = 候选数
 *   B. 共享凭据上屏：D / 路形 / 候选数 / 分叉 / 耗时 / 来源四态标签
 *   C. 每列展示模型规划步骤 + 理由 + 聚类归属（可核对 P3）
 *   D. 自定义方向：加入后候选数+1、卡片标 custom、真实进入 _currentCandidates、
 *      对比里带「自定义」标签且无伪造步骤、跨 fast→llm 升级保留
 *   E. 3D 空间不变量与中断态不回退；0 JS 错误
 *
 * 纯前端，直接调用全局函数注入推演结果，不占用 35B 单槽，秒级完成。
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
  await sleep(400);

  // 注入真实推演结果（llm 来源 + 3 候选 + 2 簇）
  await page.evaluate(f => window.__cockpit._applyForecast(JSON.parse(f)), JSON.stringify(FORECAST));
  await sleep(200);

  // A. 工具条出现
  check('A1 候选区出现后工具条显示', await page.evaluate(() => !document.getElementById('branchTools').classList.contains('hidden')));
  check('A2 初始对比面板隐藏', await page.evaluate(() => !document.getElementById('comparePanel').classList.contains('show')));

  // 打开对比（按钮）
  await page.click('#cmpToggle');
  await sleep(150);
  check('A3 点击按钮打开对比面板', await page.evaluate(() => document.getElementById('comparePanel').classList.contains('show')));
  const cols = await page.evaluate(() => document.querySelectorAll('#cmpGrid .cmp-col').length);
  check('A4 列数 = 候选数 (3)', cols === 3, `cols=${cols}`);

  // B. 共享凭据上屏
  const head = await page.evaluate(() => document.getElementById('cmpHead').textContent);
  check('B1 头部含 D=0.47', head.includes('0.47'), head.replace(/\s+/g, ' ').slice(0, 80));
  check('B2 头部含路形 分岔路口', head.includes('分岔路口'));
  check('B3 头部含候选 3', head.includes('候选') && head.includes('3'));
  check('B4 头部含分叉 2', head.includes('分叉') && head.includes('2'));
  check('B5 头部含耗时 14.5 s', head.includes('14.5 s'));
  check('B6 头部来源标 模型推演（非兜底）', head.includes('模型推演') && !head.includes('兜底'));

  // C. 每列内容 + 聚类归属
  const colInfo = await page.evaluate(() => {
    return [...document.querySelectorAll('#cmpGrid .cmp-col')].map(c => ({
      label: c.querySelector('.clbl').textContent,
      steps: c.querySelectorAll('ol li').length,
      rat: c.querySelector('.crat').textContent,
      clust: c.querySelector('.cclust').textContent,
    }));
  });
  check('C1 列0 标签=查资料 且 3 步骤', colInfo[0].label.includes('查资料') && colInfo[0].steps === 3, JSON.stringify(colInfo[0]));
  check('C2 列1 标签=梳理政策 且 2 步骤', colInfo[1].label.includes('梳理政策') && colInfo[1].steps === 2, JSON.stringify(colInfo[1]));
  check('C3 列2 标签=对比数据 且 2 步骤', colInfo[2].label.includes('对比数据') && colInfo[2].steps === 2, JSON.stringify(colInfo[2]));
  check('C4 列0/1 归第 1 簇（可核对聚类）', colInfo[0].clust.includes('第 1 簇') && colInfo[1].clust.includes('第 1 簇'), colInfo[0].clust + ' | ' + colInfo[1].clust);
  check('C5 列2 归第 2 簇', colInfo[2].clust.includes('第 2 簇'), colInfo[2].clust);
  check('C6 每列都带理由', colInfo.every(c => c.rat.includes('💡')));

  // C 键关闭
  await page.keyboard.press('c');
  await sleep(120);
  check('A5 C 键关闭对比面板', await page.evaluate(() => !document.getElementById('comparePanel').classList.contains('show')));
  await page.keyboard.press('c');
  await sleep(120);
  check('A6 C 键再次打开', await page.evaluate(() => document.getElementById('comparePanel').classList.contains('show')));

  // D. 自定义方向
  const before = await page.evaluate(() => window.__cockpit.candidates.length);
  await page.fill('#customDirInput', '我自己的分析视角');
  await page.click('#customDirAdd');
  await sleep(200);
  const after = await page.evaluate(() => window.__cockpit.candidates.length);
  check('D1 自定义加入后候选数 +1', after === before + 1, `before=${before} after=${after}`);
  const cust = await page.evaluate(() => {
    const cs = window.__cockpit.candidates;
    const c = cs[cs.length - 1];
    return { label: c.label, custom: !!c.custom, steps: (c.steps || []).length };
  });
  check('D2 自定义候选带 custom 标记且无伪造步骤', cust.custom && cust.steps === 0, JSON.stringify(cust));
  check('D3 卡片渲染为 custom 样式', await page.evaluate(() => !!document.querySelector('.branch-card.custom')));

  // 对比里自定义列带标签
  const custCol = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('#cmpGrid .cmp-col')];
    const c = cols[cols.length - 1];
    return { label: c.querySelector('.clbl').textContent, tag: !!c.querySelector('.ctag'), note: c.querySelector('.cnote') ? c.querySelector('.cnote').textContent : '' };
  });
  check('D4 对比中自定义列带「自定义」标签', custCol.tag && custCol.label.includes('我自己的分析视角'), JSON.stringify(custCol));
  check('D5 自定义列无伪造步骤且说明真实', custCol.note.includes('未为这条路径单独规划') || custCol.note.includes('真实'), custCol.note);

  // D6 跨 fast→llm 升级保留自定义
  await page.evaluate(f => window.__cockpit._applyForecast(JSON.parse(f)), JSON.stringify(FORECAST));
  await sleep(150);
  const kept = await page.evaluate(() => window.__cockpit.candidates.length);
  check('D6 fast→llm 升级后自定义方向仍保留', kept === CANDS.length + 1, `kept=${kept}`);
  check('D7 升级后自定义仍是最后一项', await page.evaluate(() => window.__cockpit.candidates.slice(-1)[0].custom === true));

  // E. 不变量 / 无错误
  const inv = await page.evaluate(() => window.__cockpit.camOffRail);
  check('E1 camOffRail 仍≈0（3D 不变量未回退）', inv < 0.001, `camOffRail=${inv}`);
  check('E2 全程 0 个 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`\n===== test_compare.js: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
