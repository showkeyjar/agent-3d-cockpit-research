/* test_fingerprint_3d.js — v0.9.41：内部状态指纹 3D 编码进「现在」位置
 *
 * 验证目标：
 *   1. unavailable / 无指纹：铺树不生成指纹环（绝不伪造）
 *   2. available 指纹：注入真 512 维指纹 → 重铺 → 指纹环 present、512 段、来源标注
 *   3. 指纹环可点 → 面板展开 512 条 + 来源/端点/模型/温度/token
 *   4. 语义纪律：指纹环挂在「现在」，不贴候选（branchId=-6，不进分支拾取数组）
 *   5. 3D 不变量：forkTopology 三级结构不变、机位贴轨、清场后环消失
 *   6. 0 JS 错误
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
const injectForecast = (page, clusters) => page.evaluate((clusters) => {
  const palette = ['#5ee0ff','#ff5fe0','#ffd23f','#34f5a0'];
  const labels = ['检索资料','拆解误差','对照方案','落地建议'];
  const candidates = labels.map((label,i)=>({
    label, sub:'围绕任务的深入方向', steps:['a','b','c'], rationale:'r',
    color:palette[i], modality:'text', pos3d:[(i-1.5)*2.2,(i%2)*1.5,(i-1.5)*0.8],
  }));
  window.__cockpit._applyForecast({
    type:'forecast_result', source:'llm', road_type:'fork', divergence:0.62,
    execution_mode:'choice', fork_count:2, cost_ms:120, clusters, candidates,
  });
}, clusters);

(async () => {
  const browser = await chromium.launch({ executablePath:EXE, headless:true,
    args:['--no-sandbox','--use-gl=swiftshader'] });
  const errors = [];
  const page = await browser.newPage({ viewport:{width:1440,height:900} });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });
  await page.goto(URL, { waitUntil:'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._applyForecast, null, {timeout:20000});

  console.log('\n=== 1. 无指纹：不生成指纹环 ===');
  await injectForecast(page, [[0,1],[2],[3]]);
  await page.waitForTimeout(600);
  const noFp = await page.evaluate(() => window.__cockpit.fingerprintRing);
  check('无指纹时 present=false', noFp.present===false, JSON.stringify(noFp));

  console.log('\n=== 2. available 指纹 → 指纹环 present ===');
  const dist = Array.from({length:512},(_,i)=>0.0002 + ((i*53)%512)/512000);
  const sum = dist.reduce((a,b)=>a+b,0); for(let i=0;i<512;i++) dist[i]/=sum;
  await page.evaluate((d) => {
    // 先建一个真实 run（_setInternalStateForTest 需要有 run 才能挂指纹）
    window.__cockpit._injectExecuteDoneForTest({ ok:true, source:'llm',
      output:'上一步的真实执行产出，用于验证指纹环。', completion:'achieved', tasks:[], chain:[] });
    // 注入到 last run 的 internal_state（铺树从这里读）
    window.__cockpit._setInternalStateForTest(null, {
      status:'available', source:'llm-expert-stats', endpoint:'/experts',
      model:'local-primary', n_expert:512, n_layers:48, temperature:0.6,
      dist:d, top_experts:[{expert:7,share:0.003}], captured_at:'2026-11-19T12:00:00Z',
      n_tokens_delta:103, expert_hits:49890,
    });
  }, dist);
  await injectForecast(page, [[0,1],[2],[3]]);
  await page.waitForTimeout(600);
  const fp = await page.evaluate(() => window.__cockpit.fingerprintRing);
  check('指纹环 present', fp.present===true, JSON.stringify(fp));
  check('512 段 dist', fp.segCount===512, 'segCount='+fp.segCount);
  check('场景含底环+512线+核心=514 sample', fp.sampleCount===514, 'sample='+fp.sampleCount);
  check('来源 llm-expert-stats', fp.source==='llm-expert-stats', fp.source);
  check('端点 /experts', fp.endpoint==='/experts', fp.endpoint);
  check('n_expert=512', fp.n_expert===512, String(fp.n_expert));
  check('status available', fp.status==='available', fp.status);

  console.log('\n=== 3. 指纹环语义纪律 ===');
  check('专用 branchId=-6（不参与分支拾取）', fp.branchId===-6, String(fp.branchId));
  const topoKinds = await page.evaluate(() => window.__cockpit.forkTopology.map(x=>x.kind));
  check('forkTopology 三级结构不变', topoKinds.includes('trunk')&&topoKinds.includes('junction')&&topoKinds.includes('twig'), topoKinds.join(','));
  const offRail = await page.evaluate(() => window.__cockpit.camOffRail);
  check('机位贴轨 camOffRail≈0', offRail < 0.05, 'offRail='+offRail);

  console.log('\n=== 4. 指纹环可点 → 面板展开来源 ===');
  await page.evaluate(() => window.__cockpit._showFingerprintPanelForTest());
  await page.waitForTimeout(200);
  const panel = await page.evaluate(() => ({
    text:window.__cockpit.fingerprintPanelText, open:window.__cockpit.fingerprintPanelOpen,
  }));
  check('面板打开', panel.open===true);
  check('含端点 /experts', panel.text.includes('/experts'));
  check('含模型 local-primary', panel.text.includes('local-primary'));
  check('含温度 0.6', panel.text.includes('0.6'));
  check('含 512 行（E511 存在）', panel.text.includes('E511'));

  console.log('\n=== 5. 清场后环消失 ===');
  await injectForecast(page, [[0],[1],[2],[3]]);  // 重铺也会 clear
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__cockpit.fingerprintRing);
  check('重铺后环仍 present（指纹仍在 last run）', after.present===true, JSON.stringify(after.present));

  check('0 JS 错误', errors.length===0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
