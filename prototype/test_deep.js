// 深度诊断：逐层 travelFuture 深入，每层等「真实」未来候选(futCands>0)出现，
// 报告未来牌夹角/距离/是否被遮挡/位置是否 NaN，捕捉「第二轮路牌消失/看不见」根因。
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function metricsFn(){
  const cp = window.__cockpit;
  const THREE = cp.THREE, cam = cp.camera;
  const fwd = cam.getWorldDirection(new THREE.Vector3()).normalize();
  const camPos = cam.position.clone();
  const signs = cp.signs; const ray = new THREE.Raycaster();
  const out=[];
  for (const s of signs){
    const bid=s.userData.branchId; if(bid===undefined) continue;
    const wp=s.getWorldPosition(new THREE.Vector3());
    const toS=wp.clone().sub(camPos); const dist=toS.length(); if(dist<0.01) continue;
    const dir=toS.clone().normalize();
    const ang=Math.acos(THREE.MathUtils.clamp(fwd.dot(dir),-1,1))*180/Math.PI;
    ray.set(camPos,dir); ray.far=dist+0.5;
    const hits=ray.intersectObjects(signs,true); let occ=null;
    for(const h of hits){ let r=h.object; while(r&&r.userData.branchId===undefined) r=r.parent;
      const hb=r?r.userData.branchId:null; if(hb!==bid&&h.distance<dist-0.3){occ={bid:hb,d:Math.round(h.distance*10)/10};break;} }
    const nan = [wp.x,wp.y,wp.z].some(v=>!isFinite(v));
    out.push({bid,ang:Math.round(ang*10)/10,dist:Math.round(dist*10)/10,occ,nan});
  }
  return {
    yaw: cp._camYaw?cp._camYaw():null, travelYaw: cp.travelYaw, isDriving: cp.isDriving,
    future: (cp.future||[]).length, futCands: (cp.future||[]).length,
    signs: out,
  };
}
function snap(){
  const cp=window.__cockpit; const s=cp.signs||[];
  return { future: s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId<=-3).length,
           cand: s.filter(x=>x.userData&&x.userData.branchId!==undefined&&x.userData.branchId>=0).length,
           arr: s.filter(x=>x.userData&&x.userData.branchId===-2).length,
           driving: cp.isDriving, futCands:(cp.future||[]).length };
}
async function waitReal(page, max=120){
  let last=null;
  for(let i=0;i<max;i++){ const s=await page.evaluate(snap); if(s.future>0 && s.futCands>0 && !s.driving) return s;
    last=s; if(i===max-1) return last; await sleep(1000); }
  return last;
}

async function main(){
  const browser=await chromium.launch({headless:true,executablePath:CHROME});
  const page=await browser.newPage(); await page.setViewportSize({width:1440,height:900});
  const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text());}); page.on('pageerror',e=>errors.push('PE:'+e.message));
  await page.goto('http://localhost:8770/',{waitUntil:'networkidle'}); await sleep(2500);

  await page.fill('#msgInput','把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。');
  await page.click('#sendBtn');
  let cand=[]; for(let i=0;i<60;i++){cand=await page.evaluate(()=>(window.__cockpit.candidates||[]).map(c=>c.label)); if(cand.length)break; await sleep(1000);}
  console.log('候选:',JSON.stringify(cand));
  await sleep(3000);
  let idx=cand.findIndex(l=>/总结|归纳|概述|梳理|整理/.test(l)); if(idx<0)idx=cand.length-1;
  await page.evaluate(i=>window.selectBranch(i),idx);
  console.log('L1 选 idx=',idx);

  for(let lvl=1; lvl<=3; lvl++){
    const w=await waitReal(page,120);
    console.log(`\n===== L${lvl} 到达后 =====`, JSON.stringify(w));
    const m=await page.evaluate(metricsFn);
    const futs=m.signs.filter(s=>s.bid<=-3);
    const nanFut=futs.filter(s=>s.nan);
    console.log(`  yaw=${m.yaw?.toFixed?.(2)} travelYaw=${m.travelYaw?.toFixed?.(2)} future=${m.future} futCands=${m.futCands}`);
    console.log(`  未来牌(${futs.length}):`, JSON.stringify(futs.map(s=>({bid:s.bid,ang:s.ang,dist:s.dist,occ:s.occ,nan:s.nan}))));
    console.log(`  被遮挡:`, JSON.stringify(m.signs.filter(s=>s.occ)));
    console.log(`  NaN牌:`, nanFut.length);
    if(lvl<3){
      // 深入第一块未来牌
      await sleep(1200);
      await page.evaluate(()=>window.travelFuture(0));
      console.log(`  → travelFuture(0) 深入 L${lvl+1}`);
      for(let i=0;i<120;i++){const s=await page.evaluate(snap); if(!s.driving&&i>3)break; await sleep(1000);}
    }
  }
  console.log('\n控制台错误:', errors.length?errors.slice(0,8):'无');
  await browser.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
