// test_link_tint_pixel.js — B0/B1 联动判据的【像素层】有效性回归（GPT 评审 #2，v0.9.55）
//
// 背景：旧判据 plane.opacity base(1.0)+0.2=1.2 被 shader clamp 到 1，B0/B1 渲染像素完全相同——
//   假判据（JS 属性读到 1.2 才"通过"，画面并无差异）。GPT 用 Three.js 复测证实。
// 新判据：B1 联动把牌面 plane 的 material.color tint 设为暖白 ffd9a0，B0（?mode=transparent-nolink）
//   保持纯白 ffffff。tint 真实参与片元着色、不被 clamp。
// 本测试用 page.screenshot 抓真实合成画面，对牌面区域采样，断言两组像素有可见差异——
//   这验证的是"联动在画面里真的可分辨"，而不只是状态属性不同。
const { chromium } = require('playwright-core');
const { resolveChromePath } = require('./chrome_helper');
const CHROME = resolveChromePath();

let pass = 0, fail = 0;
const ok = (n, c, x='') => { console.log(`  ${c?'✓':'✗'} ${n}${x?'  '+x:''}`); c?pass++:fail++; };

async function samplePage(browser, mode) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const url = 'http://localhost:8770/?test=1' + (mode === 'B0' ? '&mode=transparent-nolink' : '');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__cockpit && typeof window.__cockpit._linkState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__cockpit.setupTestArrival([8,0,8]));
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.__cockpit._triggerArrival && window.__cockpit._triggerArrival());
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({
    scr: window.__cockpit.arrivalScreen,
    tint: (window.__cockpit._linkState().activeStats || {}).planeTint,
  }));
  const buf = await page.screenshot({ type: 'png' });
  const px = await page.evaluate(async ({ b64, scr }) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const x0 = Math.round(scr.x - 20), y0 = Math.round(scr.y - 30);
    const d = ctx.getImageData(x0, y0, 40, 14).data;
    let r=0,g=0,b=0,n=d.length/4;
    for(let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; }
    return [Math.round(r/n),Math.round(g/n),Math.round(b/n)];
  }, { b64: buf.toString('base64'), scr: info.scr });
  await page.close();
  return { mode, tint: info.tint, px, errs };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const b1 = await samplePage(browser, 'B1');
  const b0 = await samplePage(browser, 'B0');
  await browser.close();

  console.log('\n=== B1/B0 联动 tint 判据（像素层）===');
  ok('B1 tint=ffd9a0', b1.tint === 'ffd9a0', `tint=${b1.tint}`);
  ok('B0 tint=ffffff', b0.tint === 'ffffff', `tint=${b0.tint}`);
  console.log(`  B1 牌面像素 RGB=${b1.px.join(',')} · B0=${b0.px.join(',')}`);
  const delta = b1.px.map((v,i)=>Math.abs(v-b0.px[i]));
  ok('两组牌面像素真实不同（有可见差异）', Math.max(...delta) > 10, `ΔRGB=${delta.join(',')}`);
  ok('B1 0 JS 错误', b1.errs.length === 0, b1.errs.join(';'));
  ok('B0 0 JS 错误', b0.errs.length === 0, b0.errs.join(';'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
