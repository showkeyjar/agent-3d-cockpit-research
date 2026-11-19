// test_m_instrument_p0.js —— 采集工具 P0 字段回归（v0.9.30）
// 走真实 file:// 页面：同意→分配→填 s1–s7 + 4 行为项→提交→验 JSON/CSV/M3 清单含 P0。
// 运行：在 LIVE 目录执行 node test_m_instrument_p0.js（playwright-core 在那里）
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const chromeHelper = require('./chrome_helper.js');

const INSTRUMENT = path.resolve(__dirname, 'tools', 'm-instrument.html');

let pass = 0, fail = 0;
function ok(label, cond){ if(cond){ pass++; console.log('  OK  '+label); } else { fail++; console.log('  FAIL '+label); } }

(async () => {
  const browser = await chromium.launch({ headless:true, executablePath: chromeHelper.resolveChromePath ? chromeHelper.resolveChromePath() : undefined });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = 'file:///' + INSTRUMENT.replace(/\\/g,'/');
  await page.goto(url);

  // 1. 同意 → 分配
  await page.check('#consentChk');
  await page.click('#btnStart');
  const arm = await page.textContent('#armLabel');
  ok('随机分配出 A/B 组', /组\s*[AB]/.test(arm || ''));

  // 2. 进量表
  await page.click('#btnToSurvey');
  const scaleCount = await page.$$eval('#scaleBox .scale[data-scale]', els => els.length);
  ok('量表有 7 项（s1–s7）', scaleCount === 7);

  // 3. 填 s1–s7 全 5 分 + 4 个行为项「能」
  // radio input 被 CSS 隐藏，直接设 checked（提交逻辑读 :checked）
  await page.evaluate(() => {
    for (let i=1;i<=7;i++){
      const el = document.querySelector(`input[name="s${i}"][value="5"]`);
      if (el) el.checked = true;
    }
    ['found_product','named_step','recited_evidence','took_result'].forEach(k=>{
      const el = document.querySelector(`input[name="${k}"][value="1"]`);
      if (el) el.checked = true;
    });
  });
  await page.fill('#think_aloud', '代理测试：拿到了成果');
  await page.click('#btnSubmit');

  // 4. M3 清单出现 P0 行
  const m3 = await page.innerHTML('#m3box');
  ok('M3 清单含 P0 可用性行', /P0 可用性/.test(m3));
  ok('M3 清单显示 s6/s7 证据', /s6=5/.test(m3) && /s7=5/.test(m3));
  ok('M3 清单显示带走成果=1', /带走成果=1/.test(m3));

  // 5. localStorage 记录含 s6/s7/took_result
  const rec = await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('m-exp-records') || '[]');
    return a[a.length-1];
  });
  ok('JSON 记录 s6=5', rec && rec.s6 === 5);
  ok('JSON 记录 s7=5', rec && rec.s7 === 5);
  ok('JSON 记录 took_result=1', rec && rec.took_result === 1);
  ok('JSON 记录 prototype_ver=v0.9.30', rec && rec.prototype_ver === 'v0.9.30');

  // 6. 导出 CSV 表头含新列（拦截 download 内容）
  const csv = await page.evaluate(() => {
    // 直接调用页面内的 toCSV（函数声明在全局）
    return typeof toCSV === 'function' ? toCSV([JSON.parse(localStorage.getItem('m-exp-records')).slice(-1)[0]]) : '';
  });
  ok('CSV 表头含 s6,s7,took_result', /s6,s7,/.test(csv) && /took_result/.test(csv));

  ok('无 JS 错误', errors.length === 0);
  console.log(`\nRESULT: ${pass}/${pass+fail} ${fail===0?'PASS':'FAIL'}`);
  if (errors.length) console.log('errors:', errors.join(' | '));
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('EXCEPTION', e); process.exit(2); });
