// test_exec_drive.js — FI-01（v0.9.50）事件驱动执行行驶回归
// 桩 WS（不占模型槽）+ 真实 startExecution 入口，验证：
//   A. 出发即行驶：startExecution 后 execDriveState.active=true、isDriving=true
//   B. token 驱动：字数↑ → target/p 单调↑；执行期 p ≤ 0.9（不到站）
//   C. execute_done 落位：p 单调滑到 1、精确停靠（camDist=ARRIVAL_CAM_DIST、docked）、
//      anchor 收敛 anchorT、camOffRail≈0、落位后 2s 无回弹
//   D. 中断就地停车：p 冻结不滑向 1、无到达牌、不写轨迹
//   E. 澄清退回岔口：p 单调回 0、currentPos 回到出发点、不铺到达牌
//   F. 失败就地停车：p 冻结、无完成宣告
//   G. 重试 reset：p 回落且单调性不被破坏（重走后仍可达 1）
//   H. 全程 camOffRail≈0（每一采样点）
const {chromium}=require('playwright-core');
const {resolveChromePath}=require('./chrome_helper');
const CHROME=resolveChromePath();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const ok=(n,c,x='')=>{console.log(`  ${c?'✓':'✗'} ${n}${x?'  '+x:''}`);c?pass++:fail++;};

async function newPage(b){
  const p=await b.newPage();
  await p.setViewportSize({width:1280,height:800});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:8770/?test=1',{waitUntil:'load'});
  await p.waitForFunction(()=>window.__cockpit,{timeout:30000});
  // 桩：真实 startExecution 会检查 wsConnected——注入最小候选后走 _beginExec+beginExecDrive
  // 不真实发 WS；用 _injectWs 喂 token/done，与真实协议同路径。
  await p.evaluate(()=>{
    window.__cockpit._applyForecast({
      candidates:[{label:'起草说明',sub:'写一段',steps:['起草'],rationale:'r',color:'#34f5a0',modality:'text',pos3d:[12,0,9]}],
      execution_mode:'choice',divergence:0.4,source:'local',fast:true,
    });
  });
  await p.waitForFunction(()=>window.__cockpit.candidates.length>0,{timeout:15000});
  await sleep(400);
  return {p,errs};
}
const drive=p=>p.evaluate(()=>({d:window.__cockpit.execDriveState,rail:window.__cockpit.camOffRail,
  pos:window.__cockpit.curPos,dist:window.__cockpit.camDist,docked:window.__cockpit.camDocked,
  anchor:window.__cockpit.camAnchorYaw,anchorT:window.__cockpit.camAnchorYawT,
  driving:window.__cockpit.isDriving,arr:window.__cockpit.hasArrival,runs:window.__cockpit.runCount}));

(async()=>{
 const b=await chromium.launch({headless:true,executablePath:CHROME});

 console.log('\n=== A0. 无 ack/token 时静止待命（GPT 评审 #1，v0.9.55）===');
 {
  const {p,errs}=await newPage(b);
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  // 只出发、不注入 execute_ack / token；等待 2.5s 观察进度
  const samples=[];
  for(let i=0;i<6;i++){ await sleep(420); const s=await drive(p); samples.push({p:s.d.p,target:s.d.target,started:s.d.started,chars:s.d.chars}); }
  ok('A0-1 全程无 started（无 ack/token）',samples.every(x=>x.started===false),JSON.stringify(samples.map(x=>x.started)));
  ok('A0-2 全程 chars=0',samples.every(x=>x.chars===0));
  ok('A0-3 等待 2.5s 进度恒为 0（无假前进）',samples.every(x=>x.p===0),JSON.stringify(samples.map(x=>x.p)));
  ok('A0-4 target 不被时间累加',samples.every(x=>x.target===0),JSON.stringify(samples.map(x=>x.target)));
  ok('A0-5 0 JS 错误',errs.length===0,errs.slice(0,2).join(';'));
  await p.close();
 }

 console.log('\n=== A/B/C. token 驱动巡航 → done 落位 ===');
 {
  const {p,errs}=await newPage(b);
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  let s=await drive(p);
  ok('A1 出发即 active+isDriving',s.d.active&&s.driving,JSON.stringify(s.d));
  ok('A2 初始 p=0',s.d.p===0);
  const ps=[];
  for(const chars of [30,80,150,240]){
    await p.evaluate(n=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(n)}),chars===30?30:chars-[30,80,150][[80,150,240].indexOf(chars)]);
    await sleep(450);
    s=await drive(p);ps.push(s.d.p);
    ok(`B chars=${chars} p≤0.9`,s.d.p<=0.9+1e-6,`p=${s.d.p}`);
    ok(`H rail≈0 @chars=${chars}`,s.rail<0.02,`rail=${s.rail}`);
  }
  ok('B4 p 随字数单调不减',ps.every((v,i)=>i===0||v>=ps[i-1]-1e-6),JSON.stringify(ps));
  ok('B5 执行期未 done',!s.d.done&&s.d.p<0.95);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'execute_done',ok:true,output:'成果文本',
    source:'llm',chain:['output'],tokens:120,elapsed_ms:2000,label:'起草说明',tasks:[{name:'output',sub:'生成',status:'done'}]}));
  await p.waitForFunction(()=>!window.__cockpit.execDriveState.active,{timeout:8000});
  await sleep(300);
  s=await drive(p);
  ok('C1 落位后 docked+camDist=5',s.docked&&Math.abs(s.dist-5)<0.05,`dist=${s.dist}`);
  ok('C2 anchor 收敛 anchorT',Math.abs(s.anchor-s.anchorT)<0.05,`${s.anchor} vs ${s.anchorT}`);
  ok('C3 rail≈0',s.rail<0.02);
  ok('C4 到达广播已发生（runs=1）',s.runs===1,`runs=${s.runs}`);
  const pos1=s.pos,dist1=s.dist;
  await sleep(2000);
  const s2=await drive(p);
  ok('C5 落位 2s 无回弹',Math.hypot(s2.pos[0]-pos1[0],s2.pos[2]-pos1[2])<0.05&&Math.abs(s2.dist-dist1)<0.05);
  ok('C6 0 JS 错误',errs.length===0,errs.slice(0,2).join(';'));
  await p.close();
 }

 console.log('\n=== D. 中断就地停车 ===');
 {
  const {p,errs}=await newPage(b);
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(100)}));
  await sleep(600);
  const before=await drive(p);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'execute_done',ok:false,interrupted:true,
    output:'部分文本',source:'llm',reason:'user_cancelled',chain:['output'],tokens:50,elapsed_ms:1200,label:'起草说明',tasks:[]}));
  await p.waitForFunction(()=>!window.__cockpit.execDriveState.active,{timeout:8000});
  const after=await drive(p);
  ok('D1 中断后 p 不滑向 1（就地停）',Math.abs(after.pos[0]-before.pos[0])<1.5&&Math.abs(after.pos[2]-before.pos[2])<1.5,
    `before=${before.pos} after=${after.pos}`);
  ok('D2 无「已完成」到达牌',!(await p.evaluate(()=>window.__cockpit.signs.some(s=>s.userData.branchId===-2))));
  ok('D3 中断进账本（interrupted）',after.runs===1);
  ok('D4 rail≈0',after.rail<0.02);
  ok('D5 0 JS 错误',errs.length===0);
  await p.close();
 }

 console.log('\n=== E. 澄清退回岔口 ===');
 {
  const {p,errs}=await newPage(b);
  const start=(await drive(p)).pos;
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(120)}));
  await sleep(600);
  const mid=await drive(p);
  ok('E1 澄清前已前进',mid.d.p>0.05,`p=${mid.d.p}`);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'execute_done',ok:true,clarify:true,
    question:'请提供数据',output:'',source:'llm',chain:['clarify'],tokens:10,elapsed_ms:800,label:'起草说明',tasks:[]}));
  await p.waitForFunction(()=>!window.__cockpit.execDriveState.active,{timeout:8000});
  const after=await drive(p);
  ok('E2 退回出发点',Math.hypot(after.pos[0]-start[0],after.pos[2]-start[2])<0.1,`start=${start} after=${after.pos}`);
  ok('E3 澄清不铺「已完成」到达牌',!(await p.evaluate(()=>window.__cockpit.signs.some(s=>s.userData.branchId===-2))));
  ok('E4 rail≈0',after.rail<0.02);
  ok('E5 0 JS 错误',errs.length===0);
  await p.close();
 }

 console.log('\n=== F. 失败就地停车 ===');
 {
  const {p,errs}=await newPage(b);
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(80)}));
  await sleep(500);
  const before=await drive(p);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'execute_done',ok:false,output:'',
    source:'local',reason:'timeout',chain:['output'],tokens:0,elapsed_ms:70000,label:'起草说明',tasks:[]}));
  await p.waitForFunction(()=>!window.__cockpit.execDriveState.active,{timeout:8000});
  const after=await drive(p);
  ok('F1 失败不滑向终点',Math.hypot(after.pos[0]-before.pos[0],after.pos[2]-before.pos[2])<1.5);
  ok('F2 未 docked（没拿到结果不收近）',!after.docked);
  ok('F3 rail≈0',after.rail<0.02);
  ok('F4 0 JS 错误',errs.length===0);
  await p.close();
 }

 console.log('\n=== G. 重试 reset 后仍可达终点 ===');
 {
  const {p,errs}=await newPage(b);
  await p.evaluate(()=>{window.__cockpit._beginExec(0);window.__cockpit._startExecDriveForTest(0);});
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(150)}));
  await sleep(500);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',reset:true}));
  await sleep(200);
  const reset=await drive(p);
  ok('G1 reset 后 p 回落',reset.d.p<=0.06,`p=${reset.d.p}`);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'token',text:'字'.repeat(260)}));
  await sleep(600);
  await p.evaluate(()=>window.__cockpit._injectWs({type:'execute_done',ok:true,output:'重试后的完整成果',
    source:'llm',chain:['output'],tokens:130,elapsed_ms:2500,label:'起草说明',tasks:[]}));
  await p.waitForFunction(()=>!window.__cockpit.execDriveState.active,{timeout:8000});
  const fin=await drive(p);
  ok('G2 重走后仍精确落位',fin.docked&&Math.abs(fin.dist-5)<0.05);
  ok('G3 rail≈0',fin.rail<0.02);
  ok('G4 0 JS 错误',errs.length===0);
  await p.close();
 }

 await b.close();
 console.log(`\n=== test_exec_drive.js: ${pass} PASS / ${fail} FAIL ===`);
 process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
