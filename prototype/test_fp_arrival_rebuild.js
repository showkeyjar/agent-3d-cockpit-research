/* v0.9.47 指纹环时序修复回归：
   1. 放大：ringRadius 从 0.9 → 1.7
   2. 结果态重建：用本轮（新）指纹在到达点重建，不再显示上一轮旧信号
   3. 挂到结果位置：worldPos 落在到达点 p 附近（非起点原点）
   4. B2 门控不变：调用方门控仍生效（这里只测函数本身行为）
   5. 0 JS 错误 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
let pass=0, fail=0;
const check=(n,ok,x='')=>{ console.log(`  ${ok?'✅':'❌'} ${n}${x?'  '+x:''}`); ok?pass++:fail++; };

(async()=>{
  const browser=await chromium.launch({executablePath:CHROME,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/',{waitUntil:'load'});
  await page.waitForFunction(()=>window.__cockpit&&window.__cockpit._rebuildFingerprintAtArrivalForTest,
                             null,{timeout:20000});

  console.log('\n=== 1. 放大增强 ===');
  const p=[6,0,8];
  const stA={status:'available',source:'llm-expert-stats',dist:Array.from({length:512},(_,i)=>0.0002+Math.abs(Math.sin(i*1.7))*0.006),top_experts:[51,359],n_expert:512};
  const r1=await page.evaluate(({p,st})=>{
    window.__cockpit._rebuildFingerprintAtArrivalForTest(p,st);
    return window.__cockpit.fingerprintRing;
  },{p,st:stA});
  check('环半径放大到 1.7（旧 0.9）', Math.abs(r1.ringRadius-1.7)<0.01, `r=${r1.ringRadius}`);
  check('512 段真信号', r1.present&&r1.segCount===512, `seg=${r1.segCount}`);

  console.log('\n=== 2. 时序：本轮指纹替换上一轮 ===');
  const stB={status:'available',source:'llm-expert-stats',dist:Array.from({length:512},(_,i)=>0.0004+Math.abs(Math.cos(i*0.9))*0.009),top_experts:[7,8,9,10],n_expert:512};
  const r2=await page.evaluate(({p,st})=>{
    window.__cockpit._rebuildFingerprintAtArrivalForTest(p,st);
    return {ring:window.__cockpit.fingerprintRing, panel:window.__cockpit.fingerprintPanelText};
  },{p,st:stB});
  check('重建后 maxDist 换成本轮新指纹', Math.abs(r2.ring.maxDist-r1.maxDist)>0.001,
        `old=${r1.maxDist.toFixed(4)} new=${r2.ring.maxDist.toFixed(4)}`);

  console.log('\n=== 3. 挂到结果位置（非起点） ===');
  check('worldPos 落在到达点 p 附近',
        Math.abs(r2.ring.worldPos[0]-p[0])<0.01&&Math.abs(r2.ring.worldPos[2]-p[2])<0.01,
        `wp=${r2.ring.worldPos.map(v=>v.toFixed(1))} p=${p}`);
  check('挂高 1.4（避开沉下去的结果牌）', Math.abs(r2.ring.attachedY-1.4)<0.01, `y=${r2.ring.attachedY}`);

  console.log('\n=== 4. 诚实降级 ===');
  const r3=await page.evaluate((p)=>{
    const ok=window.__cockpit._rebuildFingerprintAtArrivalForTest(p,{status:'unavailable',reason:'no_new_expert_activity'});
    return {ok,ring:window.__cockpit.fingerprintRing};
  },p);
  check('unavailable 不建环（不伪造）', r3.ok===false&&r3.ring.present===false, `ok=${r3.ok}`);

  check('0 JS 错误', errors.length===0, errors.slice(0,3));
  console.log(`\n${pass}/${pass+fail} PASS`);
  await browser.close();
  process.exit(pass===pass+fail?0:1);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
