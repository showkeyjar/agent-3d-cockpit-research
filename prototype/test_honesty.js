// test_honesty.js — 诚实性护栏常驻回归（P1/P3 防线）
//
// 把 v0.9.22→v0.9.24 曾发生过的「路牌回退到空洞通用词」回退风险，锁成断言：
//   1) fast 通道（本地兜底）的候选 label 绝不包含占位符「你关注的这件事」
//   2) 候选 label 不含「把任务推回给用户」的话术（访问网站/查资料类，sanitize 应已净化）
//   3) fast=1 时 source 如实标 "local"（不冒充模型推演）
//   4) 候选 label 能锚定真实业务短语（不是纯万金油动作）
//
// 走真实 8770 /api/forecast?fast=1，零单槽占用、秒级完成。
const { chromium } = require('playwright-core');
const { resolveChromePath } = require('./chrome_helper');
const BASE = 'http://127.0.0.1:8770';

let pass = 0, fail = 0;
function ok(name, cond, extra='') { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } }

const CONTEXTS = [
  '电力市场交易',
  '帮我分析风电场超短期功率预测的误差来源',
  '白洋淀机载高光谱数据怎么做碳汇反演',
  'ERA5 数据聚合到 1km 产生网格残影，怎么在输入端解决',
];

const PUSHBACK = /(访问|打开|查看|浏览|查阅|搜索|查找|关注|了解|参考).{0,10}(网站|网页|链接|网址|官网|页面|数据集|数据|资料|文献|源)|https?:\/\//;

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromePath(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(300);

  console.log('诚实性护栏（fast 通道，真实 8770）');
  let totalLabels = 0, badPlaceholder = 0, badPushback = 0, badSource = 0, anchored = 0;
  for (const ctx of CONTEXTS) {
    const d = await page.evaluate(async (c) => {
      const r = await fetch('/api/forecast?context=' + encodeURIComponent(c) + '&k=5&fast=1');
      return await r.json();
    }, ctx);
    const labels = (d.candidates || []).map(x => x.label || '');
    totalLabels += labels.length;
    if (d.source !== 'local') badSource++;
    for (const L of labels) {
      if (L.includes('你关注的这件事')) badPlaceholder++;
      if (PUSHBACK.test(L)) badPushback++;
      // 「锚定真实业务短语」：label 里出现原输入里的实义词（去掉通用动作后仍有主题词）
      const themeHit = /电力|风电|功率|误差|白洋淀|高光谱|碳汇|ERA5|网格|残影|交易/.test(L);
      if (themeHit) anchored++;
    }
    console.log(`  · ${ctx.slice(0,14)} → ${labels.length} 块，source=${d.source}`);
  }
  ok('候选 label 绝不含占位符「你关注的这件事」', badPlaceholder === 0, `命中 ${badPlaceholder}` );
  ok('候选 label 不含推回用户话术 / URL', badPushback === 0, `命中 ${badPushback}`);
  ok('fast=1 时 source 如实标 local', badSource === 0, `异常 ${badSource}`);
  ok('候选锚定真实业务短语', anchored > 0, `锚定 ${anchored}/${totalLabels}`);
  ok('0 个 JS 运行时错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}（共检视 ${totalLabels} 块路牌）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
