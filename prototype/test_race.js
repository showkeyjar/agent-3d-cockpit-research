const { resolveChromePath } = require('./chrome_helper');
// 竞态复现：让「第一轮」的 autoExploreNext fetch 故意很慢，使其在「第二轮」的有效 fetch 之后才返回，
// 从而命中 autoExploreNext 守卫里的 clearFutureSigns()，把第二轮未来牌清掉 → 复现「第二轮路牌完全消失」。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAMPLE = JSON.stringify({candidates:[
  {label:'复盘这一步', sub:'收拢成果', color:'#34f5a0', steps:['汇总','提炼','输出'], rationale:'常见延续', modality:'text'},
  {label:'再深入一步', sub:'继续往下挖', color:'#5ee0ff', steps:['展开','验证','结论'], rationale:'更深一层', modality:'text'},
  {label:'换个角度', sub:'不同方向看', color:'#ffb13d', steps:['换视角','对比','结论'], rationale:'避免走死', modality:'text'},
  {label:'跑一遍自检', sub:'检查跑偏', color:'#ff5fe0', steps:['对照','检查','调整'], rationale:'减少跑偏', modality:'text'},
  {label:'回到原问题', sub:'对齐初心', color:'#4fa8ff', steps:['回看','校准','再走'], rationale:'别跑偏', modality:'text'},
]});
function snap(){ const cp=window.__cockpit; const s=cp.signs||[];
  return { future:s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId<=-3).length,
           driving:cp.isDriving, futCands:(cp.future||[]).length }; }

async function main(){
  const browser=await chromium.launch({headless:true,executablePath:CHROME});
  const page=await browser.newPage(); await page.setViewportSize({width:1440,height:900});
  const errs=[]; page.on('pageerror',e=>errs.push('PE:'+e.message));
  let n=0;
  await page.route('**/api/forecast**', route => {
    n++;
    // 第2次调用=第一轮 autoExploreNext（故意很慢 12s）；第4次=第二轮 autoExploreNext（快 3s）
    const delay = (n===2) ? 12000 : (n===4 ? 3000 : 400);
    setTimeout(()=>route.fulfill({status:200, contentType:'application/json', body:SAMPLE}), delay);
  });
  await page.goto('http://localhost:8770/',{waitUntil:'networkidle'}); await sleep(2500);

  // 第一轮
  await page.fill('#msgInput','把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。');
  await page.click('#sendBtn');
  let cand=[]; for(let i=0;i<40;i++){cand=await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand.length)break; await sleep(800);}
  console.log('R1 候选:', JSON.stringify(cand)); await sleep(2000);
  await page.evaluate(()=>window.selectBranch(0));   // 选第一个
  console.log('R1 已选，第一轮 autoExploreNext fetch 在后台(12s后)才返回…');

  // 不等第一轮完成，立刻发第二轮消息（此时第一轮 fetch 仍在飞）
  await sleep(3000);
  await page.fill('#msgInput','再帮我把上面这个例子，改成面向小白的讲解版本，分三步说明。');
  await page.click('#sendBtn');
  let cand2=[]; for(let i=0;i<40;i++){cand2=await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand2.length)break; await sleep(800);}
  console.log('R2 候选:', JSON.stringify(cand2)); await sleep(2000);
  await page.evaluate(()=>window.selectBranch(0));
  console.log('R2 已选，第二轮有效 fetch 3s 后返回(应画出未来牌)，第一轮陈旧 fetch 12s 后才返回(会清场)');

  // 轮询 20s，捕捉「先有后无」的消失
  let everPos=0, droppedTo0=false;
  for(let i=0;i<20;i++){
    const s=await page.evaluate(snap);
    if(s.future>everPos) everPos=s.future;
    if(everPos>0 && s.future===0) droppedTo0=true;
    if(i%2===0) console.log(`  t+${i}s future=${s.future} futCands=${s.futCands} driving=${s.driving}`);
    await sleep(1000);
  }
  console.log(`\n结果: 曾经出现 future=${everPos}; 之后是否掉到0=${droppedTo0}`);
  console.log(droppedTo0 ? '❌ 复现成功：第二轮未来牌被陈旧 fetch 清掉（完全消失）' : '✅ 未消失');
  console.log('错误:', errs.slice(0,4));
  await browser.close();
  process.exit(droppedTo0?2:0);
}
main().catch(e=>{console.error(e);process.exit(1);});
