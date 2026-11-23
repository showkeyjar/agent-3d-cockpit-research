/* test_future_refine.js — FI-03（v0.9.51）探索环异步模型精修回归
 *
 * 验证：fast 本地牌先秒级立住（source=local 诚实标注），模型槽空闲时后台完整推演，
 *   回来后仅当本轮仍有效才升级牌面 + 换标 llm；作废判据（token 变化/已选路/执行中）
 *   成立时丢弃陈旧精修结果，不清场、不覆盖新牌；模型忙/失败时静默保留本地牌。
 *
 * 全部用 page.route mock /api/forecast，不占真实模型槽，秒级完成。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/?test=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const LOCAL_CANDS = [
  { label: '本地方向甲', sub: '预览', steps: ['检索', '整理'], rationale: '本地', color: '#34f5a0' },
  { label: '本地方向乙', sub: '预览', steps: ['对比'], rationale: '本地', color: '#ffb13d' },
];
const LLM_CANDS = [
  { label: '模型方向一', sub: '扎根会话', steps: ['拉取数据', '比对'], rationale: '模型', color: '#5ee0ff' },
  { label: '模型方向二', sub: '扎根会话', steps: ['建模', '验证'], rationale: '模型', color: '#ff5fe0' },
  { label: '模型方向三', sub: '扎根会话', steps: ['评估', '归因'], rationale: '模型', color: '#ffd23f' },
];
const BASE = { divergence: 0.47, road_type: 'fork', execution_mode: 'choice', fork_count: 2, cost_ms: 100 };

// 安装 mock：fast=1 → local；完整请求 → 由 mode 决定
async function installMock(page, mode) {
  let counters = { fast: 0, full: 0 };
  await page.route('**/api/forecast**', async route => {
    const fast = route.request().url().includes('fast=1');
    if (fast) {
      counters.fast++;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...BASE, source: 'local', fast: true, candidates: LOCAL_CANDS }) });
    }
    counters.full++;
    let body;
    if (mode === 'llm') body = { ...BASE, source: 'llm', fast: false, candidates: LLM_CANDS };
    else if (mode === 'offline') body = { ...BASE, source: 'offline', fast: false, candidates: [] };
    else body = { ...BASE, source: 'local', fast: false, candidates: LLM_CANDS };
    // slow-llm：响应延迟 1.2s，给测试窗口在响应回来前让 token 失效
    await sleep(mode === 'slow-llm' ? 1200 : 120);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return counters;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const errors = [];

  // ── A. fast 立牌正常 + 精修升级为 llm ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    const counters = await installMock(page, 'llm');
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await sleep(200);
    await page.evaluate(() => window.__cockpit._stubWs(true));

    // 触发探索环（fast 立牌 → 精修定时 3s 后触发）
    await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '完成甲', ['检索', '整理']));
    await page.waitForFunction(() => window.__cockpit.forecastProof.future !== null, null, { timeout: 10000 });
    const fastState = await page.evaluate(() => ({
      kind: window.__cockpit.forecastProof.future.kind,
      labels: window.__cockpit.futureRefineState.candidates,
    }));
    check('A1 fast 先立本地牌（kind=local/fast，非 llm）',
      fastState.kind === 'local' || fastState.kind === 'fast', JSON.stringify(fastState.kind));
    check('A2 fast 牌面是本地候选',
      fastState.labels.some(l => l.includes('本地')), JSON.stringify(fastState.labels));

    // 等精修：3s 定时 + 请求 120ms，给 8s 余量
    await page.waitForFunction(() => {
      const f = window.__cockpit.forecastProof.future;
      return f && f.kind === 'llm' && f.refined === true;
    }, null, { timeout: 10000 }).catch(() => {});
    const refined = await page.evaluate(() => ({
      kind: window.__cockpit.forecastProof.future.kind,
      refined: window.__cockpit.forecastProof.future.refined,
      labels: window.__cockpit.futureRefineState.candidates,
      full: window.__cockpit.futureRefineState.active,
    }));
    check('A3 精修回来后凭据升级为 llm 且标 refined',
      refined.kind === 'llm' && refined.refined === true, JSON.stringify(refined));
    check('A4 牌面换成模型候选（模型方向出现）',
      refined.labels.some(l => l.includes('模型')), JSON.stringify(refined.labels));
    check('A5 完整请求确实发出（非 fast）', counters.full >= 1, `full=${counters.full}`);
    await page.close();
  }

  // ── B. 作废判据：响应回来前 token 失效 → 陈旧精修被丢弃 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await installMock(page, 'slow-llm');
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await sleep(200);
    await page.evaluate(() => window.__cockpit._stubWs(true));

    // 先铺本地牌（用 local 模式的 fast 立牌，但完整请求是 slow-llm）
    await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '完成甲', ['检索']));
    await page.waitForFunction(() => window.__cockpit.forecastProof.future !== null, null, { timeout: 10000 });
    // 精修定时器 3s 后触发；在其完整请求发出前，先等它进入 active，然后让 token 失效
    await page.waitForFunction(() => window.__cockpit.futureRefineState.active === true, null, { timeout: 8000 }).catch(() => {});
    const before = await page.evaluate(() => window.__cockpit.futureRefineState.candidates.slice());
    // token 失效（模拟新一轮开始）——用 cancel 钩子清掉定时器，并递增 token 通过新一轮 explore
    await page.evaluate(() => {
      window.__cockpit._cancelFutureRefine();
      window.__cockpit._exploreNext([8, 0, 8], '新一轮', ['检索']);
    });
    await sleep(1800);   // 越过 slow-llm 的 1.2s 响应延迟
    const after = await page.evaluate(() => ({
      labels: window.__cockpit.futureRefineState.candidates,
      refined: !!(window.__cockpit.forecastProof.future && window.__cockpit.forecastProof.future.refined),
    }));
    check('B1 作废后旧精修未把牌升级为 refined',
      after.refined !== true || after.labels.some(l => l.includes('本地')),
      JSON.stringify(after));
    check('B2 牌面未被清空（作废只丢弃、不清场）', after.labels.length > 0, JSON.stringify(after));
    await page.close();
  }

  // ── C. 模型未真正参与（offline）→ 保留本地牌、不升级 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await installMock(page, 'offline');
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cockpit && Array.isArray(window.__cockpit.candidates), null, { timeout: 20000 });
    await sleep(200);
    await page.evaluate(() => window.__cockpit._stubWs(true));
    await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '完成甲', ['检索']));
    await page.waitForFunction(() => window.__cockpit.forecastProof.future !== null, null, { timeout: 10000 });
    await sleep(4200);
    const st = await page.evaluate(() => ({
      kind: window.__cockpit.forecastProof.future && window.__cockpit.forecastProof.future.kind,
      labels: window.__cockpit.futureRefineState.candidates,
    }));
    check('C1 offline 精修结果不冒充 llm', st.kind !== 'llm', JSON.stringify(st.kind));
    check('C2 本地牌保留（未被清空）', st.labels.length > 0, JSON.stringify(st.labels));
    await page.close();
  }

  check('D 全程 0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n=== test_future_refine: ${pass} PASS / ${fail} FAIL ===`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
