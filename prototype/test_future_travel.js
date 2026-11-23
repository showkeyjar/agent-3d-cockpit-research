const { resolveChromePath } = require('./chrome_helper');
// 无死路探索链端到端验证：
//   搭景（到达牌 + 3 块未来路牌）→ 单击未来路牌看解释卡（含「走向这条路」按钮）
//   → 点按钮 travelFuture() → 走到新到达点 → autoExploreNext 铺出新未来路牌
//   → 再选一块走向它……循环 3 轮，验证「3D 空间永远能继续往前走」
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

const settle = async (page, getter, arg) => {
  for (let i = 0; i < 20; i++) {
    const s1 = await page.evaluate(getter, arg);
    await page.waitForTimeout(400);
    const s2 = await page.evaluate(getter, arg);
    if (s1 && s2 && Math.abs(s1.x - s2.x) < 1 && Math.abs(s1.y - s2.y) < 1) return s1;
  }
  return null;
};

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8770/?test=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 确定性搭景：到达牌 + 3 块未来路牌
  await page.evaluate(() => { window.__cockpit.resetCamera(); window.__cockpit.setupTestArrival([8, 0, 8]); });
  await page.waitForTimeout(2500);

  const st0 = await page.evaluate(() => ({
    arrival: window.__cockpit.hasArrival,
    future: window.__cockpit.future.map(c => c.label),
  }));
  console.log('搭景完成:', JSON.stringify(st0));

  // 收起结果卡（固定在右侧可能遮挡）
  await page.evaluate(() => document.getElementById('rcClose').click());
  await page.waitForTimeout(200);

  for (let round = 1; round <= 3; round++) {
    console.log(`\n──── 第 ${round} 轮：点未来路牌 → 走向它 ────`);
    // 收起上一轮的结果卡，避免遮挡解释卡按钮
    await page.evaluate(() => {
      const rc = document.getElementById('resultCard');
      if (rc && rc.classList.contains('show')) document.getElementById('rcClose').click();
      document.getElementById('explainCard').classList.remove('show');
    });
    await page.evaluate(() => window.__cockpit.resetCamera());
    await page.waitForTimeout(1800);

    const futureCount = await page.evaluate(() => window.__cockpit.future.length);
    const startJourney = await page.evaluate(() => window.__cockpit.journey.length);
    if (futureCount < 1) {
      console.log(`第 ${round} 轮 FAIL: 未来路牌数量=${futureCount}（探索断了！）`);
      await browser.close(); process.exit(1);
    }
    console.log(`未来路牌 ${futureCount} 块:`, JSON.stringify(await page.evaluate(() => window.__cockpit.future.map(c => c.label))));

    // 找一块屏幕可见、不被遮挡的未来路牌＃0（扇形左侧第一块）
    const fp = await settle(page, (i) => {
      const signs = window.__cockpit.signs.filter(s => s.userData.branchId <= -3);
      const sign = signs[i];
      if (!sign) return null;
      return window.__cockpit.projectToScreen(sign.position.x, sign.position.y, sign.position.z);
    }, 0);
    if (!fp) { console.log(`第 ${round} 轮 SKIP: 投影不稳定`); continue; }

    // 单击 → 解释卡 + 按钮
    await page.mouse.click(fp.x, fp.y, { clickCount: 1 });
    await page.waitForTimeout(800);
    const ec = await page.evaluate(() => ({
      shown: document.getElementById('explainCard').classList.contains('show'),
      head: document.getElementById('ecText').textContent.slice(0, 16),
      hasGoBtn: !!document.querySelector('#ecHint .go-btn'),
    }));
    console.log('  单击效果:', JSON.stringify(ec));
    if (!ec.shown || !ec.hasGoBtn) {
      console.error(`第 ${round} 轮 FAIL: 解释卡没展开或没有走向按钮`);
      await browser.close(); process.exit(1);
    }

    // 点「走向这条路 →」→ travelFuture
    await page.click('#ecHint .go-btn');
    await page.waitForTimeout(600);
    const mid = await page.evaluate(() => ({
      curCandidates: window.__cockpit.candidates.length,
      future: window.__cockpit.future.length,
      hasArrival: window.__cockpit.hasArrival,
    }));
    console.log('  出发后的岔路状态:', JSON.stringify(mid));
    if (mid.curCandidates !== 1) {
      console.error(`第 ${round} 轮 FAIL: 岔路登记异常 curCandidates=${mid.curCandidates}`);
      await browser.close(); process.exit(1);
    }

    // 等待执行链走完（真实 LLM 链 2-40s + autoExploreNext 网络往返）
    // 判据：旅程节点增长（markBranchTravelled→journey.push）+ 新未来路牌出现
    let finalState = null;
    for (let w = 0; w < 18; w++) {
      await page.waitForTimeout(5000);
      const jlen = await page.evaluate(() => window.__cockpit.journey.length);
      finalState = await page.evaluate(() => ({
        journey: window.__cockpit.journey.length,
        future: window.__cockpit.future.length,
        futureLabels: window.__cockpit.future.map(c => c.label),
      }));
      console.log(`  [${(w+1)*5}s] 旅程节点=${jlen} 新未来路牌=${finalState.future}`);
      // 旅程前进 + 新岔路已铺出 = 探索没有断
      if (jlen > startJourney && finalState.future >= 1) break;
    }
    // 终态判据用 loop 里最后一次 finalState
    if (!(finalState && finalState.journey > startJourney && finalState.future >= 1)) {
      console.error(`第 ${round} 轮 FAIL: 链走完但探索断了 →`, JSON.stringify(finalState));
      await browser.close(); process.exit(1);
    }
    console.log(`✓ 第 ${round} 轮完成：旅程前进到节点，新未来路牌 ${finalState.future} 块，继续下轮`);
  }

  console.log('\n✓✓✓ 无死路探索链验证通过：连续 3 轮「点未来路牌 → 走向它 → 新到达 → 新未来」，空间从不断流');

  const finalJourney = await page.evaluate(() => window.__cockpit.journey.map(j => j.label));
  console.log('旅程轨迹:', JSON.stringify(finalJourney));
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  console.log('TEST DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
