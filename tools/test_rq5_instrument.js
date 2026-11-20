/* test_rq5_instrument.js — RQ5 跨轮次进展真人采集工具验证
 * 用无头浏览器 file:// 打开 tools/rq5-instrument.html，验证：
 *   1. 量表页显示 r1–r5 五题
 *   2. 行为 B1/B2 必答校验（缺任一被拦截）
 *   3. 补齐后提交成功，localStorage 记录 r1–r5 / 行为 / 文本字段正确
 *   4. 提交字段含 prototype_ver=rq5-v1 / proto_url / ts
 *   5. toCSV 导出含 r1–r5 + 行为列且值对齐（RFC 转义）
 *   6. 下一位被试复位 radio + 文本域（防残留）
 *   7. 0 JS 错误
 * 纯前端、不占 8083 模型槽。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');

const EXE = resolveChromePath();
const HTML = 'file:///' + 'D:/code/ai/agent-3d-cockpit-research/tools/rq5-instrument.html';

let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log(`  ${ok?'✅':'❌'} ${name}${extra?'  '+extra:''}`);
  ok?pass++:fail++;
};

async function newPage(browser){
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(HTML, {waitUntil:'load'});
  return {page, errs};
}

async function fillRadio(page, name, value){
  await page.click(`input[name="${name}"][value="${value}"] + span`).catch(async()=>{
    await page.locator(`input[name="${name}"][value="${value}"]`).evaluate(el=>{ el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); });
  });
}
// 量表/yn 的 label 包裹 input，直接点 input 的父 label
async function pick(page, name, value){
  await page.locator(`input[name="${name}"][value="${value}"]`).evaluate(el=>{
    el.checked = true;
    const lbl = el.closest('label'); if(lbl) lbl.classList.add('on');
  });
}

async function toSurvey(page, obs){
  await page.check('#consentChk');
  await page.click('#btnStart');
  await page.click('#btnToObs');
  await page.fill('#rounds_done','9');
  if(obs && obs.think) await page.fill('#rq_think_aloud', obs.think);
  await page.click('#btnToSurvey');
}

(async()=>{
  const browser = await chromium.launch({executablePath:EXE, headless:true});
  try{
    // ---- 1. 量表显示 ----
    console.log('\n=== 1 量表显示 ===');
    {
      const {page, errs} = await newPage(browser);
      await page.evaluate(()=>window.__rq5.clear());
      await toSurvey(page);
      const keys = await page.evaluate(()=>window.__rq5.rScaleKeys);
      check('r1–r5 五题齐全', keys.join(',')==='r1,r2,r3,r4,r5', keys.join(','));
      const qCount = await page.$$eval('#rqScaleBox .q', els=>els.length);
      check('量表 DOM 渲染 5 题', qCount===5, 'count='+qCount);
      check('0 JS 错误', errs.length===0, errs.join('|'));
      await page.close();
    }

    // ---- 2. 行为必答校验 ----
    console.log('\n=== 2 必答校验 ===');
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>window.__rq5.clear());
      await toSurvey(page);
      for(let i=1;i<=5;i++) await pick(page,'r'+i,7);
      // 故意不填 B1/B2
      await page.click('#btnSubmit');
      const saved = await page.evaluate(()=>window.__rq5.records.length);
      check('缺 B1/B2 被拦截（未入账）', saved===0, 'records='+saved);
      // 补 B1/B2
      await pick(page,'rq_anchor_recalled',1);
      await pick(page,'rq_thread_used',0);
      await page.click('#btnSubmit');
      const recs = await page.evaluate(()=>window.__rq5.records);
      check('补齐后提交成功（1 条）', recs.length===1, 'records='+recs.length);
      await page.close();
    }

    // ---- 3. 提交字段完整 ----
    console.log('\n=== 3 提交字段 ===');
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>window.__rq5.clear());
      await toSurvey(page, {think:'我记得那个代号'});
      for(let i=1;i<=5;i++) await pick(page,'r'+i,6);
      await pick(page,'rq_anchor_recalled',1);
      await pick(page,'rq_thread_used',1);
      await page.fill('#rq_interview','感觉被接上了');
      await page.fill('#rq_notes','无');
      await page.click('#btnSubmit');
      const rec = await page.evaluate(()=>window.__rq5.records[0]);
      check('r1–r5 收集正确', [1,2,3,4,5].every(i=>rec['r'+i]===6));
      check('行为项收集正确', rec.rq_anchor_recalled===1 && rec.rq_thread_used===1);
      check('rounds_done=9', rec.rounds_done===9, 'v='+rec.rounds_done);
      check('prototype_ver=rq5-v1', rec.prototype_ver==='rq5-v1', rec.prototype_ver);
      check('proto_url 记录', /8770/.test(rec.proto_url||''), rec.proto_url);
      check('文本字段收集', rec.rq_think_aloud==='我记得那个代号' && rec.rq_interview==='感觉被接上了');
      check('ts ISO8601', /^\d{4}-\d\d-\d\dT/.test(rec.ts||''), rec.ts);
      await page.close();
    }

    // ---- 4. CSV 导出对齐 ----
    console.log('\n=== 4 CSV 对齐 ===');
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>window.__rq5.clear());
      const csv = await page.evaluate(()=>{
        const recs=[
          {pid:'X1',prototype_ver:'rq5-v1',proto_url:'u',r1:1,r2:2,r3:3,r4:4,r5:5,
           rq_anchor_recalled:1,rq_thread_used:0,rounds_done:9,
           rq_think_aloud:'含,逗号',rq_interview:'i',rq_notes:'n',ts:'2026-01-01T00:00:00.000Z'},
          {pid:'X2',prototype_ver:'rq5-v1',proto_url:'u',r1:7,r2:7,r3:7,r4:7,r5:7,
           rq_anchor_recalled:0,rq_thread_used:1,rounds_done:8,
           rq_think_aloud:'',rq_interview:'',rq_notes:'',ts:'2026-01-02T00:00:00.000Z'}
        ];
        return window.__rq5.toCSV(recs);
      });
      const lines = csv.replace(/^\uFEFF/,'').trim().split('\n');
      const head = lines[0].split(',');
      const need = ['pid','prototype_ver','r1','r2','r3','r4','r5','rq_anchor_recalled','rq_thread_used','rounds_done','ts'];
      check('CSV 含全部关键列', need.every(c=>head.includes(c)), head.length+' cols');
      // RFC：逗号字段被引号包裹，简单 split 会多切；用文本片段检查引号存在
      check('逗号字段按 RFC 加引号', /"含,逗号"/.test(csv));
      const idx = head.indexOf('r3');
      check('r3 列值对齐（X1=3,X2=7）', lines[1].split(',')[idx]==='3' && lines[2].split(',')[idx]==='7');
      await page.close();
    }

    // ---- 5. radio/文本复位 ----
    console.log('\n=== 5 复位 ===');
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>window.__rq5.clear());
      await toSurvey(page);
      for(let i=1;i<=5;i++) await pick(page,'r'+i,7);
      await pick(page,'rq_anchor_recalled',1);
      await pick(page,'rq_thread_used',1);
      await page.fill('#rq_interview','上一条');
      await page.click('#btnSubmit');
      await page.click('#btnNext');
      await toSurvey(page);
      const checked = await page.$$eval('input[type=radio]:checked', els=>els.length);
      const interview = await page.inputValue('#rq_interview');
      check('下一位 radio 全清', checked===0, 'checked='+checked);
      check('下一位文本域清空', interview==='', 'v='+interview);
      await page.close();
    }

    console.log(`\nRESULT: ${pass}/${pass+fail} passed`);
    if(fail) process.exitCode=1;
  } finally {
    await browser.close();
  }
})().catch(e=>{ console.error('FATAL', e); process.exitCode=1; });
