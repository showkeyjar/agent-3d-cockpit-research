/* test_internal_state.js — v0.9.40 P1/P2：内部状态指纹凭据层（2D，诚实降级）
 *
 * 验证目标：
 *   1. 缺省诚实降级：后端未下发 internal_state 时，账本记 unavailable，绝不伪造
 *   2. available 场景：后端下发真指纹 → 规范化进账本 → 2D 详情显示摘要 + 可展开核对
 *   3. 恶意/残缺数据：不可用 dist、非法字段被规范化，不崩、不冒充 available
 *   4. 导出：JSON summary 含 internal_state_available 计数；CSV 含 4 个新列
 *   5. 3D 不变量不回退；0 JS 错误
 *
 * 纯前端 + 注入钩子，不占用 LLM 单槽，秒级完成。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function newPage(browser, errors){
  const page = await browser.newPage({ viewport:{ width:1280, height:800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
  await page.goto(URL, { waitUntil:'load' });
  await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.runs), null, { timeout:20000 });
  await sleep(300);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath:EXE, headless:true,
    args:['--no-sandbox','--use-gl=swiftshader'] });
  const errors = [];
  let page = await newPage(browser, errors);

  console.log('\n=== 1. 缺省诚实降级（当前 8083 无 /experts）===');
  const def = await page.evaluate(() => {
    window.__cockpit._injectExecuteDoneForTest({ ok:true, source:'llm', output:'真产出', completion:'achieved' });
    return { st:window.__cockpit.lastInternalState,
             detail:document.getElementById('tlDetail').textContent };
  });
  check('缺省 internal_state 记 unavailable（不伪造指纹）',
    def.st && def.st.status==='unavailable' && def.st.reason==='not_collected', JSON.stringify(def.st));

  console.log('\n=== 2. available 真指纹进账本 + 2D 详情 ===');
  const avail = await page.evaluate(() => {
    const dist = Array.from({length:60},(_,i)=>0.01 + (i%7)*0.002);
    const st = window.__cockpit._setInternalStateForTest(null, {
      status:'available', source:'llm-expert-stats', endpoint:'/experts',
      model:'probe-moe-q4', n_expert:60, n_layers:24, temperature:0,
      dist, top_experts:[3,37,2,48], captured_at:'2026-11-19T10:00:00Z',
    });
    return { st, detail:document.getElementById('tlDetail').textContent,
             bars:document.querySelectorAll('.td-is-bars i').length,
             toggle:!!document.getElementById('isToggle') };
  });
  check('available 规范化进账本（字段齐全）',
    avail.st.status==='available' && avail.st.n_expert===60 && avail.st.dist.length===60
    && avail.st.top_experts.length===4, JSON.stringify({s:avail.st.status,n:avail.st.n_expert}));
  check('2D 详情显示摘要（专家数/层/温度/Top）',
    avail.detail.includes('已采集') && avail.detail.includes('60 专家') && avail.detail.includes('Top 3, 37, 2, 48'));
  check('展开核对按钮 + 60 根指纹条渲染', avail.toggle && avail.bars===60, `bars=${avail.bars}`);
  const expand = await page.evaluate(() => {
    document.getElementById('isToggle').click();
    return { shown:document.getElementById('isPanel').style.display,
             src:document.getElementById('isPanel').textContent.includes('/experts') };
  });
  check('点击展开显示来源/端点/模型', expand.shown==='block' && expand.src);

  console.log('\n=== 3. 残缺/恶意数据不冒充 available ===');
  const guarded = await page.evaluate(() => {
    const a = window.__cockpit._setInternalStateForTest(null, { status:'available', dist:[] });
    const b = window.__cockpit._setInternalStateForTest(null, { status:'available', dist:['x', null, 'bad'] });
    const c = window.__cockpit._setInternalStateForTest(null, null);
    return { a, b, c };
  });
  check('空 dist → unavailable/empty_dist', guarded.a.status==='unavailable' && guarded.a.reason==='empty_dist');
  check('全非数值 dist → unavailable/empty_dist', guarded.b.status==='unavailable' && guarded.b.reason==='empty_dist');
  check('null 输入 → unavailable/not_collected', guarded.c.status==='unavailable' && guarded.c.reason==='not_collected');

  console.log('\n=== 4. 导出字段 ===');
  // 恢复一条 available 供导出核验
  await page.evaluate(() => {
    window.__cockpit._setInternalStateForTest(null, {
      status:'available', source:'llm-expert-stats', endpoint:'/experts',
      n_expert:60, n_layers:24, temperature:0,
      dist:Array.from({length:60},(_,i)=>0.01+i*0.0001), top_experts:[3,37] });
  });
  const exp = await page.evaluate(() => ({ json:window.__cockpit._exportRuns('json'), csv:window.__cockpit._exportRuns('csv') }));
  const J = JSON.parse(exp.json);
  check('summary 含 internal_state_available 计数（=1）', J.summary.internal_state_available===1,
    String(J.summary.internal_state_available));
  const runJ = J.runs.find(r => r.exec.internal_state?.status==='available');
  check('JSON run.exec.internal_state 含 dist/top', !!runJ && runJ.exec.internal_state.dist.length===60);
  check('CSV 表头含 4 个 internal_state_* 列',
    ['internal_state_status','internal_state_source','internal_state_dist','internal_state_top']
      .every(c => exp.csv.includes(c)));
  check('CSV 未泄漏内部 detail', !exp.csv.includes('"detail"'));

  console.log('\n=== 5. 3D 不变量 + 运行时错误 ===');
  const inv = await page.evaluate(() => ({
    fork: Array.isArray(window.__cockpit.forkTopology),
    cam: Number.isFinite(window.__cockpit.camDist),
    resultCard: window.__cockpit.resultCardOpen,
  }));
  check('3D 钩子仍在（分叉拓扑/机位未受影响）', inv.fork && inv.cam);
  check('0 个 JS 错误', errors.length===0, errors.join(' | ').slice(0,120));

  await browser.close();
  console.log(`\n${fail===0?'✅ ALL_PASS':'❌ FAIL'} — ${pass} passed / ${fail} failed`);
  process.exit(fail===0?0:1);
})();
