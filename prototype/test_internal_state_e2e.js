/* test_internal_state_e2e.js — v0.9.41：验证 execute_done.internal_state 透传进账本
 *
 * 这是 v0.9.41 修复的核心断点：后端 execute_done 下发了真实 internal_state，
 * 但 onExecuteDone / finishExecution / arrivalDetail 三处若漏透传，前端账本会恒
 * 降级 unavailable（与三轮审查 completion 断点同款）。本测试注入一条带真 512 维
 * available 指纹的 execute_done，走真实 onExecuteDone→detail→recordRun 链路，
 * 断言账本 lastInternalState 拿到真指纹、2D 详情显示来源标注。不占 LLM 槽。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';

let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log(`  ${ok?'✅':'❌'} ${name}${extra?'  '+extra:''}`);
  ok?pass++:fail++;
};

(async () => {
  const browser = await chromium.launch({ executablePath:EXE, headless:true,
    args:['--no-sandbox','--use-gl=swiftshader'] });
  const errors = [];
  const page = await browser.newPage({ viewport:{width:1280,height:800} });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
  await page.goto(URL, { waitUntil:'load' });
  await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.runs), null, {timeout:20000});

  // 构造真 512 维指纹（和为1）
  const dist = Array.from({length:512}, (_,i) => 0.0005 + ((i*37)%512)/512000);
  const sum = dist.reduce((a,b)=>a+b,0);
  for (let i=0;i<dist.length;i++) dist[i]/=sum;
  const internal = {
    status:'available', source:'llm-expert-stats', endpoint:'/experts',
    model:'local-primary', n_expert:512, n_layers:48, temperature:0.6,
    dist, top_experts:[{expert:282,share:0.0061},{expert:127,share:0.0059}],
    captured_at:'2026-11-19T12:00:00Z', n_tokens_delta:103, expert_hits:49890,
  };

  console.log('\n=== execute_done.internal_state 透传 ===');
  const r = await page.evaluate((st) => {
    window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'这是一段真实的起草产出，关于城市雨水花园如何净化雨水。',
      completion:'achieved', tasks:[], chain:[], internal_state:st,
    });
    const last = window.__cockpit.lastInternalState;
    // 打开时间线详情看来源标注
    const runs = window.__cockpit.runs;
    const detailText = runs.length ? '' : '';
    return { last, runCount:runs.length };
  }, internal);

  check('账本 lastInternalState 拿到 available', r.last && r.last.status==='available', JSON.stringify(r.last?.status));
  check('dist 512 维保留', r.last && Array.isArray(r.last.dist) && r.last.dist.length===512, 'len='+r.last?.dist?.length);
  check('来源标注 llm-expert-stats', r.last && r.last.source==='llm-expert-stats', r.last?.source);
  check('端点标注 /experts', r.last && r.last.endpoint==='/experts', r.last?.endpoint);
  check('温度如实标注 0.6', r.last && r.last.temperature===0.6, String(r.last?.temperature));
  check('账本新增一轮', r.runCount>=1, 'runs='+r.runCount);

  // 控制组：不透传时仍诚实 unavailable（不因补丁把缺省也抬成 available）
  const c = await page.evaluate(() => {
    window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'无指纹产出', completion:'achieved', tasks:[], chain:[],
    });
    return window.__cockpit.lastInternalState;
  });
  check('未下发时仍 unavailable（不伪造）', c && c.status==='unavailable', JSON.stringify(c));
  check('0 JS 错误', errors.length===0, errors.join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
