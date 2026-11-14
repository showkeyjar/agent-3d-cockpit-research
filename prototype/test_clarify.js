// 澄清回路端到端验证：缺数据任务 → 模型澄清卡 → 用户回答 → 真实第二轮 LLM
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8770/', { waitUntil: 'networkidle' });
  await sleep(2500);

  // ── 真实缺数据任务 ──
  await page.fill('#msgInput', '分析近6个月销售数据找出异常月份');
  await page.click('#sendBtn');

  let candidates = [];
  for (let i = 0; i < 30; i++) {
    candidates = await page.evaluate(() => (window.__cockpit?.candidates || []).map(c => c.label));
    if (candidates.length) break;
    await sleep(700);
  }
  console.log('候选数:', candidates.length, JSON.stringify(candidates));
  if (!candidates.length) { console.log('FAIL: 推演未出候选'); console.log('ERRORS:', errors); await browser.close(); process.exit(1); }

  await page.evaluate(() => window.selectBranch(0));   // 走第 0 条候选（等价于点「走这条路」）
  await sleep(800);

  // 等澄清卡出现
  let clarifyText = '';
  for (let i = 0; i < 70; i++) {
    const st = await page.evaluate(() => {
      const card = document.getElementById('resultCard');
      const q = document.getElementById('rcQuestionBig');
      return { clarify: card.classList.contains('clarify'), qVisible: q.style.display === 'block', q: q.textContent || '' };
    });
    if (st.clarify && st.qVisible) { clarifyText = st.q; break; }
    await sleep(1000);
  }
  console.log('澄清卡问题:', JSON.stringify(clarifyText));
  if (!clarifyText) { console.log('FAIL: 未出现澄清交互卡'); console.log('ERRORS:', errors); await browser.close(); process.exit(1); }

  // 回答
  await page.fill('#rcAnswerInput', '1月100,2月120,3月90,4月130,5月80,6月140（单位：万元）');
  await page.click('#rcAnswerBtn');
  await sleep(800);

  // 等第二轮结果：澄清类消失，且出现真实产出
  let finalState = null;
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate(() => {
      const card = document.getElementById('resultCard');
      const out = document.getElementById('rcOutput');
      const src = document.getElementById('rcSource');
      return { clarify: card.classList.contains('clarify'), outText: out.textContent || '', src: src.textContent || '', shows: card.classList.contains('show') };
    });
    if (!st.clarify && st.shows && st.outText.length > 10) { finalState = st; break; }
    await sleep(1000);
  }
  console.log('第二轮结果:', finalState ? JSON.stringify({ clarify: finalState.clarify, src: finalState.src, outLen: finalState.outText.length, outHead: finalState.outText.slice(0, 90) }) : 'null');

  console.log('CONSOLE_ERRORS:', errors.length, JSON.stringify(errors.slice(0, 5)));

  const pass = !!clarifyText && finalState && !finalState.clarify && finalState.outText.length > 10;
  console.log(pass ? 'CLARIFY_E2E_PASS' : 'CLARIFY_E2E_FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('SCRIPT_ERR', e); process.exit(2); });
