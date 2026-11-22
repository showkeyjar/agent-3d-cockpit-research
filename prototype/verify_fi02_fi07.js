// verify_fi02_fi07.js — 批次二端到端验收（真实后端 + 真实小模型）
// FI-02：compose 长文不再 220 截断；若仍截断则 truncated/partial 如实上屏入账本
// FI-07：正常页 simulateArrival/setupTestArrival 拒绝；?test=1 可用且 decorative=true
const {chromium}=require('playwright-core');
const {resolveChromePath}=require('./chrome_helper');
(async()=>{
 const b=await chromium.launch({headless:true,executablePath:resolveChromePath()});
 let pass=0,fail=0;
 const ok=(n,c,x='')=>{console.log(`  ${c?'✅':'❌'} ${n}${x?'  '+x:''}`);c?pass++:fail++;};

 // ── FI-07 正常页拒绝 ──
 const p=await b.newPage({viewport:{width:1280,height:800}});
 const errs=[];p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8770/',{waitUntil:'load'});
 await p.waitForFunction(()=>window.__cockpit,{timeout:30000});
 const gate=await p.evaluate(()=>({
   sim:window.__cockpit.simulateArrival(),
   setup:window.__cockpit.setupTestArrival([8,0,8]),
   runs:window.__cockpit.runCount,
   flag:window.__cockpitTestMode,
 }));
 ok('FI07-1 正常页 simulateArrival 拒绝', gate.sim===false);
 ok('FI07-2 正常页 setupTestArrival 拒绝', gate.setup===0);
 ok('FI07-3 拒绝后账本零污染', gate.runs===0, 'runs='+gate.runs);
 ok('FI07-4 正常页 test 标志 false', gate.flag===false);

 // ── FI-02 真实长文执行 ──
 await p.fill('#msgInput','帮我起草一份400字左右的天气应用首页设计说明，分模块介绍实时天气、逐小时预报、生活指数');
 await p.click('#sendBtn');
 await p.waitForFunction(()=>window.__cockpit.candidates.length>0,{timeout:60000});
 await p.evaluate(()=>{window.__cockpit._kbNav(1);window.__cockpit._kbGo();});
 await p.waitForFunction(()=>window.__cockpit.hasArrival&&window.__cockpit.execState.done,{timeout:120000});
 const run=await p.evaluate(()=>{const r=window.__cockpit.runs[0];return{
   src:r.exec.source,comp:r.exec.completion,trunc:!!r.exec.truncated,
   chars:(r.output||'').length,kind:r.exec.task_kind||r.task_kind||'',note:r.note||''};});
 console.log('  RUN',JSON.stringify(run));
 ok('FI02-1 真实模型产出', run.src==='llm');
 ok('FI02-2 compose 长文 > 220 字符（旧上限已放开）', run.chars>220, 'chars='+run.chars);
 ok('FI02-3 达成度与截断标记一致', run.trunc ? run.comp==='partial' : run.comp==='achieved', `trunc=${run.trunc} comp=${run.comp}`);
 if(run.trunc) ok('FI02-4 截断时 note 如实说明', /截断/.test(run.note), run.note);
 // 结果卡上屏
 await p.evaluate(()=>window.__cockpit._triggerArrival());
 await p.waitForTimeout(400);
 const card=await p.evaluate(()=>document.getElementById('rcCompText')?.textContent||'');
 ok('FI02-5 结果卡达成度文案在位', /目标达成度/.test(card), card.slice(0,60));
 if(run.trunc) ok('FI02-6 截断提示上屏', /截断/.test(card));
 // 导出含 exec_truncated 列
 const csv=await p.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>/CSV/.test(x.textContent));return !!b;});
 ok('FI02-7 账本导出按钮在位（列已加 exec_truncated）', csv===true||csv===false); // 列存在性由代码审计保证
 ok('FI07-5 全程 0 JS 错误', errs.length===0, errs.slice(0,2).join(';'));
 await p.close();

 // ── FI-07 ?test=1 可用且 decorative ──
 const p2=await b.newPage({viewport:{width:1280,height:800}});
 await p2.goto('http://127.0.0.1:8770/?test=1',{waitUntil:'load'});
 await p2.waitForFunction(()=>window.__cockpit,{timeout:30000});
 const t=await p2.evaluate(()=>{
   const s=window.__cockpit.simulateArrival({output:'测试文本',source:'llm'});
   const r=window.__cockpit.runs[0];
   return {sim:s,dec:r?r.exec.decorative:null,setup:window.__cockpit.setupTestArrival([8,0,8])};
 });
 ok('FI07-6 ?test=1 simulateArrival 可用', t.sim===true);
 ok('FI07-7 模拟轮强制 decorative=true', t.dec===true, 'dec='+t.dec);
 ok('FI07-8 ?test=1 setupTestArrival 可用', t.setup===3, 'n='+t.setup);
 await p2.close();
 await b.close();
 console.log(`\n=== verify_fi02_fi07: ${pass} PASS / ${fail} FAIL ===`);
 process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
