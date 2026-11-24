// 模型设置面板回归：打开/加载/测试连接/保存/恢复默认。
// 不消耗推理槽（测试探针只探 /health），秒级。用 LIVE 目录的 playwright-core。
const path = require('path');
// playwright-core 解析：优先用 COCKPIT_LIVE_DIR（异机/LIVE 跑），否则用本目录 node_modules。
//   v0.9.55：去掉"未设 LIVE 就报错退出"——repo 同样装了 playwright-core，默认回归在 repo 跑应可直接用。
const LIVE = process.env.COCKPIT_LIVE_DIR;
const MODULE_BASE = LIVE || __dirname;
const { chromium } = require(path.join(MODULE_BASE, 'node_modules/playwright-core'));
const { resolveChromePath } = require(path.join(MODULE_BASE, 'chrome_helper'));
const EXE = resolveChromePath();

let pass = 0, fail = 0;
function ok(name, cond, extra){ if (cond){ pass++; console.log('  ✓ '+name); } else { fail++; console.log('  ✗ '+name+(extra?'  → '+JSON.stringify(extra):'')); } }

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // 1. 按钮存在
  ok('模型按钮存在', await page.locator('#modelBtn').count() === 1);
  ok('面板默认隐藏', !(await page.locator('#modelPanel').evaluate(el => el.classList.contains('show'))));

  // 2. 打开面板
  await page.locator('#modelBtn').click();
  await page.waitForTimeout(500);
  ok('点击后面板显示', await page.locator('#modelPanel').evaluate(el => el.classList.contains('show')));

  // 3. 配置已加载（base_url / model 有值）
  const baseUrl = await page.locator('#mpBaseUrl').inputValue();
  const model = await page.locator('#mpModel').inputValue();
  ok('base_url 已加载', baseUrl.length > 0, {baseUrl});
  ok('model 已加载', model.length > 0, {model});
  // 4. 来源标注存在
  const src = await page.locator('#src-base_url').textContent();
  ok('来源标注显示', ['file','env','default'].some(s => (src||'').includes(s)), {src});

  // 5. 测试连接（真实探 8083，不占槽）
  await page.locator('#mpTest').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('mpResult');
    return el && el.classList.contains('show') && /可达|失败|不可达/.test(el.textContent||'');
  }, null, {timeout: 12000}).catch(()=>{});
  const testTxt = await page.locator('#mpResult').textContent();
  ok('测试连接返回可达', /可达/.test(testTxt||'') && !/不可达/.test(testTxt||''), {testTxt:(testTxt||'').slice(0,120)});

  // 6. 保存（不改实质值，只写一次盘验证流程）
  await page.locator('#mpSave').click();
  await page.waitForFunction(() => /已保存/.test(document.getElementById('mpResult')?.textContent||''), null, {timeout: 8000}).catch(()=>{});
  const saveTxt = await page.locator('#mpResult').textContent();
  ok('保存成功并提示生效', /已保存/.test(saveTxt||''), {saveTxt:(saveTxt||'').slice(0,120)});

  // 7. 恢复默认
  await page.locator('#mpReset').click();
  await page.waitForFunction(() => /已恢复默认/.test(document.getElementById('mpResult')?.textContent||''), null, {timeout: 8000}).catch(()=>{});
  const resetTxt = await page.locator('#mpResult').textContent();
  ok('恢复默认成功', /已恢复默认/.test(resetTxt||''), {resetTxt:(resetTxt||'').slice(0,120)});

  ok('无 JS 运行时错误', errors.length === 0, errors.slice(0,3));

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
