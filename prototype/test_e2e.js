const { resolveChromePath } = require('./chrome_helper');
// ⚠️ 已知环境项（FIELD-ISSUES/远端 CHANGELOG 均记录）：小模型（gemma3:1b）+ 无头环境下
//    「到达/未来牌投影不稳定」软观察项、顺序链拆分质量不足，基线 stash 对照同样失败，
//    不具判定力、不进回归门禁；判回归前做基线对照。
// 真实端到端：提问 → 双击第0站 → 完整顺序链 → 点击到达牌 → 点击未来路牌
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

const settle = async (page, getter) => {
  for (let i = 0; i < 20; i++) {
    const s1 = await page.evaluate(getter);
    await page.waitForTimeout(400);
    const s2 = await page.evaluate(getter);
    if (s1 && s2 && Math.abs(s1.x - s2.x) < 1 && Math.abs(s1.y - s2.y) < 1) return s1;
  }
  return null;
};

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 1. 提问 + 等待推演
  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForTimeout(9000);

  const candidates = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  const mode = await page.evaluate(() => window.__cockpit.mode);
  console.log('模式:', mode, '候选:', JSON.stringify(candidates));

  let idx = candidates.findIndex(l => /查|资料|检索|调研/.test(l));
  if (idx < 0 && candidates.length) idx = 0;  // LLM 候选随机，无查资料类分支时回退首个
  if (idx < 0) { console.log('FAIL: 无候选'); await browser.close(); process.exit(1); }

  // 2. 双击候选 3D 路牌触发执行。旧写法先 resetCamera 再用 positions[i]+2.9 固定偏移投影，
  //    相机阻尼期间「算投影」与「真点击」姿态不一致 → 双击点空、整条链等 300s（flaky）。
  //    改为：用牌的真实世界坐标投影，并逐块用 pickAt 校验射线确实命中该候选。
  await page.waitForTimeout(1200);
  const signPos = await page.evaluate((want) => {
    const cp = window.__cockpit;
    const list = cp.signs.filter(s => s.userData.branchId >= 0);
    const order = [...new Set([want, ...list.keys()])];
    for (const k of order) {
      const s = list[k]; if (!s) continue;
      const p = cp.projectToScreen(s.position.x, s.position.y, s.position.z);
      if (p && cp.pickAt(p.x, p.y) >= 0) return { x: p.x, y: p.y, id: s.userData.branchId };
    }
    for (const s of list) {   // 中心被前排牌挡住时小范围扫描
      const b = cp.projectToScreen(s.position.x, s.position.y, s.position.z);
      for (let dy = -40; dy <= 40; dy += 10)
        for (let dx = -40; dx <= 40; dx += 10)
          if (cp.pickAt(b.x + dx, b.y + dy) >= 0) return { x: b.x + dx, y: b.y + dy, id: s.userData.branchId };
    }
    return null;
  }, idx);
  if (!signPos) { console.log('FAIL: 无候选路牌可被射线命中'); await browser.close(); process.exit(1); }
  console.log('第0站屏幕坐标:', JSON.stringify(signPos));
  await page.mouse.click(signPos.x, signPos.y, { clickCount: 2, delay: 120 });

  // 3. 等待顺序链全部走完（最多 300s）
  // 35B 常走澄清：此时 hasArrival=true 但刻意不画 3D 到达牌（P3 不伪造完成态），
  // 旧脚本不补答就会空等 300s 报「未走完顺序链」——属测试 flaky，非应用回归。
  let chain = null;
  for (let round = 0; round < 30; round++) {
    await page.waitForTimeout(10000);
    const clar = await page.evaluate(() => {
      const c = document.getElementById('rcAnswerInput');
      return !!c && c.offsetParent !== null;
    });
    if (clar) {
      await page.fill('#rcAnswerInput', '请聚焦现货与中长期两类交易，说明各自定价方式与风险');
      await page.click('#rcAnswerBtn');
      console.log('  → 模型请求澄清，已补答并重跑该步');
    }
    const st = await page.evaluate(() => ({
      arrivalSigns: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
      dbg: window.__cockpit.seqDebug.slice(-2),
    }));
    if (st.arrivalSigns > 0) {
      chain = true;
      break;
    }
    if (round % 6 === 0) console.log(`  ...等待到达牌 (${round * 10}s)`);
  }
  if (!chain) { console.log('FAIL: 300s 内未走完顺序链'); }

  const post = await page.evaluate(() => ({
    arrivalSigns: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
    futureSigns: window.__cockpit.signs.filter(s => s.userData.branchId <= -3).length,
    futureCand: window.__cockpit.future.length,
    hasArrival: window.__cockpit.hasArrival,
  }));
  console.log('链条状态:', JSON.stringify(post));

  // 4. 点击到达牌 → 结果卡应出现（且 output 是真实内容而非「流程演示」兜底）
  // 五修后到达时结果卡已自动打开，点击到达牌是 toggle；先确保处于收起态，
  // 才能验证「点击展开」这一条（否则 shown=false 只是收起，属预期但会误导）。
  await page.evaluate(() => {
    const c = document.getElementById('resultCard');
    if (c && c.classList.contains('show')) document.getElementById('rcClose')?.click();
  });
  await page.waitForTimeout(500);
  let rcOk = false;
  const rp = await settle(page, () => {
    const sign = window.__cockpit.signs.find(s => s.userData.branchId === -2);
    if (!sign) return null;
    return window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
  });
  if (!rp) { console.log('FAIL: 到达牌投影不稳定'); }
  else {
    const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), rp);
    await page.mouse.click(rp.x, rp.y);
    await page.waitForTimeout(1500);
    const rc = await page.evaluate(() => ({
      shown: document.getElementById('resultCard').classList.contains('show'),
      title: document.getElementById('rcTitle').textContent,
      output: document.getElementById('rcOutput').textContent.slice(0, 80),
    }));
    console.log('① 点击到达牌 pickAt/=', picked, '结果卡:', JSON.stringify(rc));
    rcOk = picked === -2 && rc.shown === true;
  }

  // 5. 点击未来路牌 → 解释卡应出现
  // 先收起结果卡：其固定层可能与未来路牌投影重叠（候选布局随机），挡住鼠标点击
  const rcOpen = await page.evaluate(() => document.getElementById('resultCard').classList.contains('show'));
  if (rcOpen) { await page.click('#rcClose'); await page.waitForTimeout(600); }
  // 首块未来路牌可能被当前候选牌在屏幕空间遮挡（射线先命中前排牌）：
  // 遍历每块未来牌投影点，pickAt 实际命中（≤-3）的才点——与用户真实点击语义一致
  let fp = null;
  for (let attempt = 0; attempt < 40 && !fp; attempt++) {
    fp = await page.evaluate(() => {
      const signs = window.__cockpit.signs.filter(s => s.userData.branchId <= -3);
      for (const s of signs) {
        const p = window.__cockpit.projectToScreen(s.position.x, s.position.y, s.position.z);
        if (p && window.__cockpit.pickAt(p.x, p.y) <= -3) return { x: p.x, y: p.y };
      }
      return null;
    });
    if (!fp) await page.waitForTimeout(500);
  }
  if (!fp) { console.log('FAIL: 未来路牌投影不稳定'); }
  else {
    const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), fp);
    await page.mouse.click(fp.x, fp.y);
    await page.waitForTimeout(2500);
    const ec = await page.evaluate(() => ({
      shown: document.getElementById('explainCard')?.classList.contains('show'),
      title: document.getElementById('ecTitle')?.textContent,
    }));
    console.log('② 点击未来路牌 pickAt/=', picked, '解释卡:', JSON.stringify(ec));
  }

  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  console.log(rcOk && errors.length === 0 ? 'E2E PASS' : 'E2E FAIL');
  process.exit(rcOk && errors.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
