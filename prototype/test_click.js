const { resolveChromePath } = require('./chrome_helper');
// 端到端点击测试：验证「提问 → 选路出发 → 到达牌点击 → 下一步未来路牌点击」链路
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

const probe = (port) => new Promise(res => {
  const http = require('http');
  const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 5000 }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(`${port}: ${d.slice(0,120)}`));
  });
  req.on('error', e => res(`${port}: ERR ${e.message}`));
  req.on('timeout', () => res(`${port}: TIMEOUT`));
});

async function main() {
  console.log('llama-8083:', await probe(8083));
  console.log('backend-8770:', await probe(8770));

  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const ready = await page.evaluate(() => !!window.__cockpit);
  console.log('调试导出就绪:', ready);
  if (!ready) { console.log('FAIL: 页面脚本未完成初始化'); await browser.close(); process.exit(1); }

  // 提问
  await page.fill('#msgInput', '分析国内电力交易市场格局');
  await page.click('#sendBtn');
  await page.waitForTimeout(9000);

  const candidates = await page.evaluate(() => window.__cockpit.candidates.map(c => c.label));
  console.log('候选路牌:', JSON.stringify(candidates));

  let idx = candidates.findIndex(l => /查|资料|检索|调研/.test(l));
  if (idx < 0 && candidates.length) idx = 0;  // LLM 候选随机，无查资料类分支时回退首个
  console.log('选中下标:', idx);
  if (idx < 0) {
    console.log('FAIL: 无候选');
    await browser.close();
    process.exit(1);
  }

  // 相机归位，双击该路牌出发
  await page.evaluate(() => window.__cockpit.resetCamera());
  await page.waitForTimeout(2000);

// 双击落在「路牌面板」位置：applyForecastResult 里 sequential 每站路牌挂于分支位置 y+2.9
  let pos = await page.evaluate((i) => {
    const p = window.__cockpit.positions[i];
    if (!p) return null;
    return window.__cockpit.projectToScreen(p[0], p[1] + 2.9, p[2]);
  }, idx);
  console.log('路牌屏幕坐标:', JSON.stringify(pos));

  if (pos) {
    await page.mouse.click(pos.x, pos.y, { clickCount: 2, delay: 120 });
  }

  // 轮询等待到达牌出现（sequential 整链很慢，最多 240s）
  let arrived = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => ({
      hasArrival: window.__cockpit.hasArrival,
      mode: window.__cockpit.mode,
      count: window.__cockpit.signs.filter(s => s.userData.branchId === -2).length,
    }));
    if (st.count > 0 || st.hasArrival) { arrived = true; break; }
    if (i % 8 === 0) console.log(`  ...等待到达牌 (${i*5}s) mode=${st.mode} hasArrival=${st.hasArrival}`);
  }
  if (!arrived) console.log('FAIL: 240s 内未出现到达牌');

  const arrival = await page.evaluate(() => {
    const c = window.__cockpit;
    return {
      arrivalSignCount: c.signs.filter(s => s.userData.branchId === -2).length,
      futureSignCount: c.signs.filter(s => s.userData.branchId <= -3).length,
      futureCandidates: c.future.length,
    };
  });
  console.log('到达后状态:', JSON.stringify(arrival));

  // 等待相机静止：连续两次投影坐标一致且 pickAt 命中同一 id
  const settle = async (getter) => {
    for (let i = 0; i < 20; i++) {
      const s1 = await page.evaluate(getter);
      await page.waitForTimeout(400);
      const s2 = await page.evaluate(getter);
      if (Math.abs(s1.x - s2.x) < 1 && Math.abs(s1.y - s2.y) < 1) return s1;
    }
    return null;
  };

  // ① 点击到达牌：先收起结果卡（排除执行结束时已自动展开的假阳性），再验证点击能重新展开
  if (arrival.arrivalSignCount > 0) {
    await page.evaluate(() => document.getElementById('rcClose').click());
    await page.waitForTimeout(500);
    const hidden = await page.evaluate(() => !document.getElementById('resultCard').classList.contains('show'));
    console.log('① 先收起结果卡:', hidden ? 'ok' : '仍显示?');

    const ap = await settle(() => {
      const sign = window.__cockpit.signs.find(s => s.userData.branchId === -2);
      if (!sign) return null;
      const p = window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
      return p;
    });
    if (!ap) { console.log('① FAIL: 到达牌投影不稳定'); }
    else {
      const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), ap);
      console.log('① pickAt(到达牌坐标) =', picked);
      await page.mouse.click(ap.x, ap.y);
      await page.waitForTimeout(1500);
      const rc = await page.evaluate(() => ({
        shown: document.getElementById('resultCard').classList.contains('show'),
        output: document.getElementById('rcOutput').textContent.slice(0, 50),
      }));
      console.log('① 点击到达牌后结果卡:', JSON.stringify(rc));
    }
  }

  // ② 点击未来路牌 → 解释卡展开
  if (arrival.futureSignCount > 0) {
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
    if (!fp) { console.log('② FAIL: 无可点击的未来路牌'); }
    else {
      const picked = await page.evaluate((xy) => window.__cockpit.pickAt(xy.x, xy.y), fp);
      console.log('② pickAt(未来路牌坐标) =', picked);
      await page.mouse.click(fp.x, fp.y);
      await page.waitForTimeout(2500);
      const ec = await page.evaluate(() => ({
        shown: document.getElementById('explainCard').classList.contains('show'),
        title: document.getElementById('ecTitle').textContent,
      }));
      console.log('② 点击未来路牌后解释卡:', JSON.stringify(ec));
    }
  } else {
    console.log('WARN: 没有未来路牌');
  }

  console.log('JS错误:', errors.length ? errors.slice(0,5) : '无');
  await browser.close();
  console.log('TEST DONE');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
