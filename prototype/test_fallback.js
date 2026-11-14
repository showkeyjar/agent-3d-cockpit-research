const { resolveChromePath } = require('./chrome_helper');
// 验证：当 /api/forecast 返回空候选时，前端是否仍能通过 drawFutureSignsFallback 铺出未来牌。
// 用 Playwright 拦截 /api/forecast 返回 {candidates:[]}，看未来牌是否出现。
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function snap(){ const cp=window.__cockpit; const s=cp.signs||[];
  return { future:s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId<=-3).length,
           cand:s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId>=0).length,
           arr:s.filter(x=>x.userData&&x.userData.branchId===-2).length, driving:cp.isDriving, futCands:(cp.future||[]).length }; }

async function main(){
  const browser=await chromium.launch({headless:true,executablePath:CHROME});
  const page=await browser.newPage(); await page.setViewportSize({width:1440,height:900});
  const errs=[]; page.on('pageerror',e=>errs.push('PE:'+e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});

  // 拦截 forecast：只拦「第二次及以后」的调用（即 autoExploreNext 的推演），
  // 首次调用（初始候选生成）放行，否则连初始分支都没有。
  let fc=0;
  await page.route('**/api/forecast**', route => {
    fc++;
    if (fc === 1) return route.fallback();
    return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({candidates:[]}) });
  });

  await page.goto('http://localhost:8770/',{waitUntil:'networkidle'}); await sleep(2500);
  await page.fill('#msgInput','把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。');
  await page.click('#sendBtn');
  let cand=[]; for(let i=0;i<60;i++){cand=await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand.length)break; await sleep(1000);}
  console.log('候选:',JSON.stringify(cand));
  await sleep(3000);
  let idx=cand.findIndex(l=>/总结|归纳|概述|梳理|整理/.test(l)); if(idx<0)idx=cand.length-1;
  await page.evaluate(i=>window.selectBranch(i),idx);
  let last=null;
  for(let i=0;i<120;i++){ const s=await page.evaluate(snap); if(s.future>0 && s.futCands>0 && !s.driving){last=s;break;} last=s; if(i===119)break; await sleep(1000); }
  console.log('空forecast下 到达快照:', JSON.stringify(last));
  console.log('  → 未来牌(兜底):', (last.future>0&&last.futCands>0)?'✅ 兜底仍铺出':'❌ 完全消失');
  console.log('  控制台错误:', errs.slice(0,5));
  await browser.close();
  process.exit((last.future>0&&last.futCands>0)?0:2);
}
main().catch(e=>{console.error(e);process.exit(1);});
