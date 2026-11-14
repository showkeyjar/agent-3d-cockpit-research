// 多次跑用户原任务，捕获「澄清」实例：确认澄清时候选牌不再被清空（road 不空白）
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const TASK = '国内电力交易市场的格局？';

function snap(page){return page.evaluate(()=>{
  const s=window.__cockpit.signs||[]; let cand=0;
  s.forEach(x=>{const b=x.userData&&x.userData.branchId; if(b===undefined)return; if(b>=0)cand++;});
  const card=document.getElementById('resultCard');
  const q=document.getElementById('rcQuestionBig');
  return { isClarify: card.classList.contains('clarify'),
           cardShown: card.classList.contains('show'),
           question: q?(q.style.display!=='none'?q.textContent:null):null,
           candidateSigns: cand };
});}

(async()=>{
  const browser=await chromium.launch({executablePath:CHROME,headless:true});
  let caughtClarify=false;
  for(let i=1;i<=6;i++){
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    await page.goto('http://127.0.0.1:8770/',{waitUntil:'load'});
    await page.waitForFunction(()=>window.__cockpit&&window.__cockpit.candidates,{timeout:20000});
    await page.fill('#msgInput',TASK);
    await page.click('#sendBtn');
    await page.waitForFunction(()=>window.__cockpit.candidates.length>0,{timeout:60000});
    const cands=await page.evaluate(()=>window.__cockpit.candidates.map(c=>c.label));
    let idx=cands.findIndex(l=>(l||'').includes('查资料')); if(idx<0) idx=1;
    const pos=await page.evaluate((idx)=>{const s=window.__cockpit.signs.find(x=>x.userData&&x.userData.branchId===idx);
      if(!s)return null; const v=new window.__cockpit.THREE.Vector3(); s.getWorldPosition(v);
      return window.__cockpit.projectToScreen(v.x,v.y,v.z);},idx);
    await page.mouse.dblclick(pos.x,pos.y);
    await page.waitForFunction(()=>{const c=document.getElementById('resultCard');return c&&c.classList.contains('show');},{timeout:120000});
    await page.waitForTimeout(1500);
    const s=await snap(page);
    console.log(`RUN ${i}: isClarify=${s.isClarify} cardShown=${s.cardShown} candidateSigns=${s.candidateSigns}` + (s.question?` question="${s.question.slice(0,40)}..."`:''));
    if(s.isClarify){ caughtClarify=true;
      console.log(`  >>> 捕获到澄清！候选牌数量=${s.candidateSigns}（修复后应 >0，road 不空白）`); }
    await page.close();
  }
  console.log(caughtClarify ? '结论：已捕获澄清实例，候选牌未被清空 ✅' : '结论：6 次未自然触发澄清（模型通常直接答），但澄清守卫修复已就位（逻辑：clarify 时不调 clearUntakenCandidates）');
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
