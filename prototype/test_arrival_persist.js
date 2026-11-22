/* v0.9.49 回归：到达结果牌不再「滚动一下就没了」
   机制 A：发新问题/新一轮推演清场时保留 -2 到达牌（clearBranches keepArrival + applyForecastResult 数组保留）
   机制 B：有 -2 到达牌时滚轮拉近下限抬到 3.4，结果牌始终在视锥内
   用 setupTestArrival 确定性搭景（真实建牌，不依赖 LLM）；断言 0 JS 错误。*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
let pass=0, fail=0;
const check=(n,ok,x='')=>{ console.log(`  ${ok?'✅':'❌'} ${n}${x?'  '+x:''}`); ok?pass++:fail++; };
const ARR=(c)=>c.signs.filter(s=>s.userData && s.userData.branchId===-2).length;

(async()=>{
  const browser=await chromium.launch({executablePath:CHROME,headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/?test=1',{waitUntil:'load'});
  await page.waitForFunction(()=>window.__cockpit&&window.__cockpit.setupTestArrival,
                             null,{timeout:20000});

  // 搭一个真实到达牌场景（建 -2 牌 + 3 未来牌），并让相机落位
  const setup=async()=>await page.evaluate(()=>{
    const c=window.__cockpit;
    c.clearBranches();
    const n=c.setupTestArrival([8,0,8]);
    return {arr:c.signs.filter(s=>s.userData&&s.userData.branchId===-2).length,
            future:c.futureSigns.length, built:n};
  });

  console.log('\n=== 1. 搭景基线：真实 -2 到达牌存在 ===');
  const s0=await setup();
  check('setupTestArrival 建出 1 块到达牌', s0.arr===1, `arr=${s0.arr}`);
  check('同时铺出 3 张未来牌', s0.future===3, `future=${s0.future}`);

  console.log('\n=== 2. 机制A：clearBranches({keepArrival:true}) 保留到达牌 ===');
  const keep=await page.evaluate(()=>{
    const c=window.__cockpit;
    c.clearBranches({keepArrival:true});
    return {arr:c.signs.filter(s=>s.userData&&s.userData.branchId===-2).length,
            future:c.futureSigns.length};
  });
  check('保留调用后 -2 到达牌仍在', keep.arr===1, `arr=${keep.arr}`);
  check('候选/未来牌照常清掉', keep.future===0, `future=${keep.future}`);

  console.log('\n=== 3. 默认全清（reset/回退语义不变）===');
  const full=await page.evaluate(()=>{
    const c=window.__cockpit;
    c.clearBranches();
    return {arr:c.signs.filter(s=>s.userData&&s.userData.branchId===-2).length};
  });
  check('默认 clearBranches 仍清空到达牌', full.arr===0, `arr=${full.arr}`);

  console.log('\n=== 4. 机制A续：applyForecastResult 重建岔牌不抹 -2 ===');
  // 重新搭景后发一次 forecast 结果（走 applyForecastResult 重铺路径）
  await setup();
  const reap=await page.evaluate(()=>{
    const c=window.__cockpit;
    c.applyForecastResultForTest({
      execution_mode:'choice',
      candidates:[
        {label:'甲方向',sub:'子1',steps:['a'],rationale:'r',color:'#34f5a0',modality:'text'},
        {label:'乙方向',sub:'子2',steps:['b'],rationale:'r',color:'#5ee0ff',modality:'text'},
      ],
      divergence:0.5, source:'llm'
    });
    return {arr:c.signs.filter(s=>s.userData&&s.userData.branchId===-2).length,
            branches:c.signs.filter(s=>s.userData&&s.userData.branchId>=0).length};
  });
  check('推演重铺后 -2 到达牌仍在', reap.arr===1, `arr=${reap.arr}`);
  check('推演重铺出新候选牌', reap.branches===2, `branches=${reap.branches}`);

  console.log('\n=== 5. 机制B：有到达牌时滚轮拉近下限 3.4，牌不出视锥 ===');
  // 前几组（尤其 applyForecastResult 重铺）会改相机朝向状态；reload 隔离出干净落位场景
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>window.__cockpit&&window.__cockpit.dockCameraForTest,null,{timeout:20000});
  await setup();
  await page.evaluate(()=>window.__cockpit.dockCameraForTest());  // 落到真实到达停靠态（dist=5,pitch=-0.16）
  await page.waitForTimeout(1400);  // 机位锚点逐帧收敛到 currentPos（实测约 1.2s；半路读会误判出视锥）
  await page.mouse.move(640,400);
  for(let i=0;i<12;i++){ await page.mouse.wheel(0,-300); await page.waitForTimeout(40); }
  await page.waitForTimeout(1600);
  const zin=await page.evaluate(()=>{
    const c=window.__cockpit;
    const arr=c.signs.filter(s=>s.userData&&s.userData.branchId===-2);
    const rows=arr.map(s=>{
      const v=new c.THREE.Vector3(); s.getWorldPosition(v);
      const ndc=v.clone().project(c.camera);
      return {y:+ndc.y.toFixed(3), inFrustum:Math.abs(ndc.x)<=1&&Math.abs(ndc.y)<=1&&ndc.z>-1&&ndc.z<1, visible:s.visible};
    });
    return {camDist:+c.camDist.toFixed(2), arr:arr.length, rows,
            journeyLen:c.journey.length, camPos:c.camera.position.toArray().map(n=>+n.toFixed(2))};
  });
  check('拉近后 camDist 不低于 3.4', zin.camDist>=3.39, `dist=${zin.camDist}`);
  check('拉近到底到达牌仍在场景', zin.arr===1, `arr=${zin.arr}`);
  check('牌中心在视锥内（未贴底边消失）',
        zin.rows.length===1&&zin.rows[0].inFrustum&&zin.rows[0].y>-0.92,
        `ndcY=${zin.rows[0]&&zin.rows[0].y} journey=${zin.journeyLen} camPos=${zin.camPos}`);

  console.log('\n=== 6. 无到达牌时仍可拉近到 3.0（探索态不受限）===');
  await page.evaluate(()=>{ window.__cockpit.clearBranches(); window.__cockpit.resetCamera(); });
  await page.waitForTimeout(300);
  for(let i=0;i<14;i++){ await page.mouse.wheel(0,-300); await page.waitForTimeout(40); }
  await page.waitForTimeout(1000);
  const zfree=await page.evaluate(()=>({camDist:+window.__cockpit.camDist.toFixed(2),arr:window.__cockpit.signs.filter(s=>s.userData&&s.userData.branchId===-2).length}));
  check('无到达牌时可拉近到 3.0', zfree.camDist<=3.05, `dist=${zfree.camDist}`);
  check('确认此时无到达牌', zfree.arr===0, `arr=${zfree.arr}`);

  console.log('\n=== 7. 0 JS 错误 ===');
  check('无 pageerror', errors.length===0, errors.slice(0,3).join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail?1:0);
})().catch(e=>{ console.error('FATAL',e); process.exit(1); });
