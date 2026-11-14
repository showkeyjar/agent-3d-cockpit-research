const { resolveChromePath } = require('./chrome_helper');
// 量化诊断 v4：走「正常完成」分支，验证选分支后的遮挡修复
//  - 外层最多 3 次尝试（规避 35B 偶发 429/兜底候选导致 execute 未完成）
//  - 每次：发任务 → 等候选 → 选「总结/归纳」类 → 轮询正常完成 → 等相机稳定 → 量化路牌
//  - 判定：① 无未选候选牌(branchId>=0)；② 到达牌(-2)不挡正前方未来牌；③ 未来牌无被遮挡项
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function metricsFn() {
  const cp = window.__cockpit;
  const THREE = cp.THREE;
  const cam = cp.camera;
  const fwd = cam.getWorldDirection(new THREE.Vector3()).normalize();
  const camPos = cam.position.clone();
  const signs = cp.signs;
  const ray = new THREE.Raycaster();
  const out = [];
  for (const s of signs) {
    const bid = s.userData.branchId;
    if (bid === undefined) continue;
    const wp = s.getWorldPosition(new THREE.Vector3());
    const toS = wp.clone().sub(camPos);
    const dist = toS.length();
    if (dist < 0.01) continue;
    const dir = toS.clone().normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(fwd.dot(dir), -1, 1)) * 180 / Math.PI;
    ray.set(camPos, dir); ray.far = dist + 0.5;
    const hits = ray.intersectObjects(signs, true);
    let occ = null;
    for (const h of hits) {
      let root = h.object;
      while (root && root.userData.branchId === undefined) root = root.parent;
      const hbid = root ? root.userData.branchId : null;
      if (hbid !== bid && h.distance < dist - 0.3) { occ = { bid: hbid, d: Math.round(h.distance*10)/10 }; break; }
    }
    out.push({ bid, ang: Math.round(ang*10)/10, dist: Math.round(dist*10)/10, occ });
  }
  const res = cp.results ? cp.results.get(-2) : null;
  return {
    yaw: cp._camYaw ? cp._camYaw() : null,
    travelYaw: cp.travelYaw, curPos: cp.curPos, camDist: cp.camDist, isDriving: cp.isDriving,
    fwd: fwd.toArray().map(v => Math.round(v*100)/100),
    hasArrival: cp.hasArrival, journeyLen: (cp.journey||[]).length,
    future: (cp.future||[]).length,
    clarify: res ? !!res.clarify : null,
    signs: out,
  };
}

async function attempt(page, n) {
  console.log(`\n========== 尝试 ${n} ==========`);
  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await sleep(2500);

  await page.fill('#msgInput', '把下面3个要点整理成一段连贯的话：模型能主动澄清缺的信息、界面有交互提醒、结果可核对可追溯。');
  await page.click('#sendBtn');

  let cand = [];
  for (let i = 0; i < 60; i++) {
    cand = await page.evaluate(() => (window.__cockpit.candidates||[]).map(c=>c.label));
    if (cand.length) break;
    await sleep(1000);
  }
  console.log('候选:', JSON.stringify(cand));
  if (!cand.length) { console.log('  ✗ 未产生候选（可能 429/兜底），本尝试失败'); return null; }
  if (cand.length === 1 && /无法|缺/.test(cand[0])) { console.log('  ✗ 兜底候选，本尝试失败'); return null; }
  await sleep(3000);

  let idx = cand.findIndex(l => /总结|归纳|概述|梳理|整理/.test(l));
  if (idx < 0) idx = cand.length - 1;
  console.log('选择分支 idx=', idx, '(', cand[idx], ')');
  await page.evaluate(i => window.selectBranch(i), idx);

  let state = 'waiting';
  let answeredClarify = false;
  for (let i = 0; i < 150; i++) {
    const st = await page.evaluate(() => {
      const r = window.__cockpit.results ? window.__cockpit.results.get(-2) : null;
      return { future: (window.__cockpit.future||[]).length, driving: window.__cockpit.isDriving,
               clarify: r ? !!r.clarify : false, hasArrival: window.__cockpit.hasArrival };
    });
    if (st.future > 0 && !st.driving && !st.clarify) { state = 'completed'; break; }
    if (st.hasArrival && st.clarify && !answeredClarify) {
      const ok = await page.evaluate(() => {
        const inp = document.getElementById('rcAnswerInput');
        const btn = document.getElementById('rcAnswerBtn');
        if (!inp || !btn) return false;
        inp.value = '周五前发出正式报告即可，按此执行';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        btn.click();
        return true;
      });
      if (ok) { answeredClarify = true; console.log('  → 触发澄清，已模拟补答，等待第二轮…'); }
    }
    await sleep(1000);
  }
  console.log('状态:', state, '已补答澄清=', answeredClarify);
  if (state !== 'completed') { console.log('  ✗ 未在超时内完成，本尝试失败'); return null; }

  // 等相机稳定
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const y = await page.evaluate(() => window.__cockpit._camYaw ? window.__cockpit._camYaw() : null);
    if (prev !== null && y !== null && Math.abs(y - prev) < 0.01) break;
    prev = y; await sleep(700);
  }
  await sleep(1500);

  const post = await page.evaluate(metricsFn);
  const cats = {
    cand: post.signs.filter(s=>s.bid>=0),
    arr: post.signs.filter(s=>s.bid===-2),
    fut: post.signs.filter(s=>s.bid<=-3),
  };
  // 正前方未来牌：夹角最小且 < 12°
  const front = cats.fut.slice().sort((a,b)=>a.ang-b.ang)[0];
  const frontOccluded = front && front.ang < 12 && front.occ;
  const anyFutOcc = cats.fut.filter(s=>s.occ);
  const arrOccludesFront = frontOccluded && front.occ.bid === -2;

  const verdict = {
    c1_noUntakenCand: cats.cand.length === 0,
    c2_arrNotBlockFront: !frontOccluded || !arrOccludesFront,
    c3_noFutureOccluded: anyFutOcc.length === 0,
  };

  console.log('\n--- 最终状态 ---');
  console.log('  yaw=%s travelYaw=%s dist=%s',
    post.yaw?.toFixed?.(2), post.travelYaw?.toFixed?.(2), post.camDist);
  console.log('  journeyLen=%d hasArrival=%s future=%d clarify=%s', post.journeyLen, post.hasArrival, post.future, post.clarify);
  console.log('  候选牌(%d):', cats.cand.length, JSON.stringify(cats.cand.map(s=>({bid:s.bid,ang:s.ang,dist:s.dist,occ:s.occ}))));
  console.log('  到达牌(%d):', cats.arr.length, JSON.stringify(cats.arr.map(s=>({bid:s.bid,ang:s.ang,dist:s.dist,occ:s.occ}))));
  console.log('  未来牌(%d):', cats.fut.length, JSON.stringify(cats.fut.map(s=>({bid:s.bid,ang:s.ang,dist:s.dist,occ:s.occ}))));
  console.log('  正前方未来牌:', JSON.stringify(front), '被到达牌遮挡=', arrOccludesFront);
  console.log('  判定: ①无未选候选=%s ②到达牌不挡前方=%s ③未来牌无遮挡=%s',
    verdict.c1_noUntakenCand, verdict.c2_arrNotBlockFront, verdict.c3_noFutureOccluded);
  const pass = verdict.c1_noUntakenCand && verdict.c2_arrNotBlockFront && verdict.c3_noFutureOccluded;
  console.log(pass ? '  ✅ PASS' : '  ❌ FAIL');
  return { pass, post, verdict, cats };
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  let finalRes = null;
  for (let n = 1; n <= 3; n++) {
    const r = await attempt(page, n);
    if (r && r.pass) { finalRes = r; break; }
    if (r) { finalRes = r; } // 保留最后一次明细
    await sleep(3000);
  }
  console.log('\n控制台错误:', errors.length ? errors.slice(0,5) : '无');
  await browser.close();
  process.exit(finalRes && finalRes.pass ? 0 : 2);
}
main().catch(e => { console.error(e); process.exit(1); });
