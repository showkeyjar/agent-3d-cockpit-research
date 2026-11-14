// 两轮诊断：第一轮选分支→看未来牌；第二轮 travelFuture 深入→看第二轮未来牌是否还在
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function snap(){
  const cp = window.__cockpit;
  const signs = cp.signs || [];
  const futs = signs.filter(s => s.userData && s.userData.branchId !== undefined && s.userData.branchId <= -3);
  const cands = signs.filter(s => s.userData && s.userData.branchId !== undefined && s.userData.branchId >= 0);
  const arr = signs.filter(s => s.userData && s.userData.branchId === -2);
  return {
    future: futs.length,
    cand: cands.length,
    arr: arr.length,
    driving: cp.isDriving,
    bids: signs.filter(s=>s.userData&&s.userData.branchId!==undefined).map(s=>s.userData.branchId).sort((a,b)=>a-b),
    futCands: (cp.future||[]).length,
  };
}

async function waitFuture(page, label){
  let last=null;
  for (let i=0;i<60;i++){
    const s = await page.evaluate(snap);
    if (s.future>0 && !s.driving){ return s; }
    last=s; await sleep(1000);
  }
  return last;
}

async function main(){
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const logs=[];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push('PAGEERROR: '+e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await sleep(2500);

  // 第一轮
  await page.fill('#msgInput', '把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。');
  await page.click('#sendBtn');
  let cand=[];
  for (let i=0;i<60;i++){ cand = await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand.length) break; await sleep(1000); }
  console.log('第一轮候选:', JSON.stringify(cand));
  await sleep(3000);
  let idx = cand.findIndex(l=>/总结|归纳|概述|梳理|整理/.test(l)); if(idx<0) idx=cand.length-1;
  console.log('第一轮选 idx=', idx, '(', cand[idx], ')');
  await page.evaluate(i=>window.selectBranch(i), idx);
  const r1 = await waitFuture(page, 'r1');
  console.log('第一轮完成 →', JSON.stringify(r1));

  // 第二轮：深入第一块未来牌
  await sleep(1500);
  const beforeR2 = await page.evaluate(snap);
  console.log('深入前(round2前) →', JSON.stringify(beforeR2));
  await page.evaluate(()=>window.travelFuture(0));
  console.log('已调用 window.travelFuture(0)');
  // 等待行驶结束
  for (let i=0;i<120;i++){ const s=await page.evaluate(snap); if(!s.driving && i>3) break; await sleep(1000); }
  // 等异步 autoExploreNext 推演回来（最多 40s），记录 future 变化
  let maxFut=0, lastFut=-1;
  for (let i=0;i<40;i++){
    const s = await page.evaluate(snap);
    if (s.future!==lastFut){ console.log(`  t+${i}s future=${s.future} cand=${s.cand} arr=${s.arr} bids=${JSON.stringify(s.bids)}`); lastFut=s.future; }
    maxFut=Math.max(maxFut,s.future);
    if (s.future>0 && i>8) break;
    await sleep(1000);
  }
  const r2 = await page.evaluate(snap);
  console.log('第二轮最终 →', JSON.stringify(r2), 'maxFut=', maxFut);

  // 打印与探索相关的日志
  const rel = logs.filter(l=>/铺出|推演|未来|fallback|下一方向|结合你刚走|出错|异常|Error|error/.test(l));
  console.log('\n=== 相关控制台日志 ===');
  console.log(rel.slice(0,40).join('\n') || '(无)');
  console.log('\n结论:', r2.future>0 ? '✅ 第二轮未来牌存在' : '❌ 第二轮未来牌消失');
  await browser.close();
  process.exit(r2.future>0?0:2);
}
main().catch(e=>{ console.error(e); process.exit(1); });
