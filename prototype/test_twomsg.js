const { resolveChromePath } = require('./chrome_helper');
// 双消息路径：发第一条消息→选分支→看未来牌(round1)；再发第二条消息(第二轮)→选分支→看未来牌是否还在
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function snap(){ const cp=window.__cockpit; const s=cp.signs||[];
  return { future:s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId<=-3).length,
           cand:s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId>=0).length,
           arr:s.filter(x=>x.userData&&x.userData.branchId===-2).length, driving:cp.isDriving, futCands:(cp.future||[]).length }; }
async function doRound(page, msg, tag){
  await page.fill('#msgInput', msg);
  await page.click('#sendBtn');
  let cand=[]; for(let i=0;i<60;i++){cand=await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand.length)break; await sleep(1000);}
  console.log(`[${tag}] 候选:`, JSON.stringify(cand));
  await sleep(3000);
  let idx=cand.findIndex(l=>/总结|归纳|概述|梳理|整理|查|写|识别/.test(l)); if(idx<0)idx=cand.length-1;
  await page.evaluate(i=>window.selectBranch(i),idx);
  let last=null;
  for(let i=0;i<120;i++){ const s=await page.evaluate(snap); if(s.future>0 && s.futCands>0 && !s.driving){last=s;break;} last=s; if(i===119)break; await sleep(1000); }
  console.log(`[${tag}] 到达快照:`, JSON.stringify(last), last.future>0&&last.futCands>0?'✅有未来牌':'❌无未来牌');
  return last;
}
async function main(){
  const browser=await chromium.launch({headless:true,executablePath:CHROME});
  const page=await browser.newPage(); await page.setViewportSize({width:1440,height:900});
  const errs=[]; page.on('pageerror',e=>errs.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  await page.goto('http://localhost:8770/',{waitUntil:'networkidle'}); await sleep(2500);
  await doRound(page, '把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。', 'R1');
  await sleep(2000);
  await doRound(page, '再帮我把上面这个例子，改成面向小白的讲解版本，分三步说明。', 'R2(第二轮消息)');
  console.log('\n控制台错误:', errs.slice(0,6));
  await browser.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
