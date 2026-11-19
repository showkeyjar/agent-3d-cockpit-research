/* test_no_fingerprint.js — v0.9.43 B2 组：仅隐藏指纹环的呈现层门控
 * 验证 B2 相对 B 是「单一差异」：
 *   1. ?mode=no-fingerprint 生效（noFingerprintMode=true）
 *   2. 同样注入 available 指纹：B 组有环 / B2 组无环
 *   3. B2 组路牌照常铺（forkTopology 非空）—— 不误伤其它呈现
 *   4. B2 组账本仍如实记 internal_state=available —— 数据层不撒谎
 *   5. 0 JS 错误
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const BASE = 'http://127.0.0.1:8770/';

let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log(`  ${ok?'✅':'❌'} ${name}${extra?'  '+extra:''}`);
  ok?pass++:fail++;
};

async function prepare(page, withFp){
  await page.goto(BASE + (withFp?'':'?mode=no-fingerprint'), {waitUntil:'load'});
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._applyForecast, null, {timeout:20000});
  await page.evaluate(() => {
    // 建一条带 available 指纹的真实轮（走 _injectExecuteDoneForTest 确保 recordRun）
    window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'上一步真实执行产出。', completion:'achieved', tasks:[], chain:[]
    });
    const dist = Array.from({length:512}, (_,i)=>0.0002 + ((i*53)%512)/512000);
    window.__cockpit._setInternalStateForTest(null, {
      status:'available', source:'llm-expert-stats', endpoint:'/experts', model:'local-primary',
      n_expert:512, n_layers:48, temperature:0.6, dist,
      top_experts:[{expert:7,share:0.003}], captured_at:'2026-11-19T12:00:00Z',
      n_tokens_delta:103, expert_hits:49890
    });
    const palette = ['#5ee0ff','#ff5fe0','#ffd23f','#34f5a0'];
    const labels = ['检索资料','拆解误差','对照方案','落地建议'];
    const candidates = labels.map((label,i)=>({
      label, sub:'围绕任务的深入方向', steps:['a','b','c'], rationale:'r',
      color:palette[i], modality:'text', pos3d:[(i-1.5)*2.2,(i%2)*1.5,(i-1.5)*0.8],
    }));
    window.__cockpit._applyForecast({
      type:'forecast_result', source:'llm', road_type:'fork', divergence:0.62,
      execution_mode:'choice', fork_count:2, cost_ms:120, clusters:[[0,1],[2],[3]], candidates,
    });
  });
  await page.waitForTimeout(700);
  return page.evaluate(() => ({
    noFpMode: window.__cockpit.noFingerprintMode,
    ring: window.__cockpit.fingerprintRing,
    fork: window.__cockpit.forkTopology,
    lastInternal: window.__cockpit.lastInternalState,
  }));
}

(async () => {
  const browser = await chromium.launch({ executablePath:EXE, headless:true,
    args:['--no-sandbox','--use-gl=swiftshader'] });
  const errors = [];
  const page = await browser.newPage({ viewport:{width:1440,height:900} });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('console: '+m.text()); });

  console.log('\n=== 1. B 组（默认，有指纹环）===');
  const b = await prepare(page, true);
  check('B 组 noFingerprintMode=false', b.noFpMode===false);
  check('B 组 指纹环 present=true', b.ring.present===true, JSON.stringify({seg:b.ring.segCount}));

  console.log('\n=== 2. B2 组（no-fingerprint，隐藏环）===');
  const b2 = await prepare(page, false);
  check('B2 组 noFingerprintMode=true', b2.noFpMode===true);
  check('B2 组 指纹环 present=false', b2.ring.present===false, JSON.stringify(b2.ring));

  console.log('\n=== 3. 单一差异：其它呈现与数据层不受影响 ===');
  check('B2 组路牌照常铺（forkTopology 非空）', Array.isArray(b2.fork) && b2.fork.length>0,
        'fork segments='+(b2.fork?b2.fork.length:0));
  check('B 组与 B2 组 forkTopology 一致', JSON.stringify(b.fork)===JSON.stringify(b2.fork));
  const ist = b2.lastInternal;
  check('B2 组账本 internal_state 仍 available（数据诚实）',
        !!ist && ist.status==='available', JSON.stringify(ist && {status:ist.status,src:ist.source}));

  console.log('\n=== 4. 0 JS 错误 ===');
  check('0 JS 错误', errors.length===0, errors.slice(0,3).join(' | '));

  await browser.close();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
