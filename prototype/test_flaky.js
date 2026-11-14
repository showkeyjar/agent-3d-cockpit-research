// 多次复现：每次测「卡片出现瞬间」vs「6s 后稳定」的未来牌数量，判定是真失败还是异步延迟
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const TASK = '国内电力交易市场的格局？';

function countFut(page){return page.evaluate(()=>{
  const s=window.__cockpit.signs||[]; let f=0,p=-9;
  s.forEach(x=>{const b=x.userData&&x.userData.branchId; if(b===undefined)return;
    if(b<=-3){ if(b===-9)p=-9; else f++; }});
  return {realFuture:f, hasPlaceholder:(p===-9), fc:(window.__cockpit.future||[]).length};
});}

(async()=>{
  const browser=await chromium.launch({executablePath:CHROME,headless:true});
  for(let trial=1; trial<=3; trial++){
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
    const immediate=await countFut(page);
    await page.waitForTimeout(6000);
    const settled=await countFut(page);
    // 再测一次 12s 后，看是否稳定/消失
    await page.waitForTimeout(6000);
    const late=await countFut(page);
    console.log(`TRIAL ${trial}: 候选=${JSON.stringify(cands)} 选=${idx}`);
    console.log(`  即时(卡片弹出): realFuture=${immediate.realFuture} placeholder=${immediate.hasPlaceholder} fc=${immediate.fc}`);
    console.log(`  6s后: realFuture=${settled.realFuture} fc=${settled.fc}`);
    console.log(`  12s后: realFuture=${late.realFuture} fc=${late.fc}`);
    await page.close();
  }
  await browser.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
