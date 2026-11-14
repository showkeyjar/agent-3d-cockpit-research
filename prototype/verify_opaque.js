// verify_opaque.js — M1/M2 实验「执行不透明」操纵完整性回归（常驻）
//
// 目的：锁死 A 组（?mode=opaque）操纵的语义，防止后续改动悄悄回退：
//   1) 命中 ?mode=opaque 时，<html> 加 class "mode-opaque"（不是文档旧称的 "opaque"）
//   2) 呈现层 P2/P3/P4 全部隐藏：resultCard / comparePanel / timelinePanel /
//      scnPanel / proofBar / legend 及其触发按钮、progressHud / decisionChain
//   3) 真实执行链路未动：REST /api/forecast 仍正常返回候选（操纵只是呈现层）
//   4) 对照（无参数）：上述呈现层均可见
//
// 这是 M1 实验单归因「透明度」的前提——组间差异只能来自呈现层，不能来自执行本身。
const { chromium } = require('playwright-core');
const { resolveChromePath } = require('./chrome_helper');
const URL = 'http://127.0.0.1:8770/';

let pass = 0, fail = 0;
function ok(name, cond, extra='') { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } }

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromePath(), headless: true });
  const errors = [];

  const HIDDEN_IDS = ['resultCard','comparePanel','cmpToggle','timelinePanel','timelineBtn',
    'scnPanel','contextTags','proofBar','legend','customDirInput','progressHud','decisionChain','decisionBtn'];

  // ── 对照：无参数，呈现层应可见 ──
  let page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  // 对照：无 opaque 时，常驻呈现层应可见（这些是 opaque 会隐藏的控件/信息条）
  const ALWAYS_VISIBLE = ['progressHud', 'proofBar', 'legend', 'cmpToggle', 'timelineBtn', 'decisionBtn'];
  const visible = await page.evaluate((ids) => {
    const r = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      r[id] = el ? getComputedStyle(el).display !== 'none' : false;
    }
    return r;
  }, ALWAYS_VISIBLE);
  console.log('\n[A] 对照（无 opaque）：常驻呈现层应可见');
  for (const id of ALWAYS_VISIBLE) ok('visible: #' + id, visible[id] === true, 'display=none');
  await page.close();

  // ── 实验组：?mode=opaque ──
  page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL + '?mode=opaque', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  const res = await page.evaluate((ids) => {
    const hasClass = document.documentElement.classList.contains('mode-opaque');
    const hidden = {};
    for (const id of ids) {
      let el = document.getElementById(id);
      if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
      hidden[id] = getComputedStyle(el).display === 'none';
    }
    return { hasClass, hidden };
  }, HIDDEN_IDS);
  console.log('\n[B] 实验组（?mode=opaque）：呈现层应隐藏');
  ok('html 含 mode-opaque class', res.hasClass === true);
  for (const id of HIDDEN_IDS) ok('hidden: #' + id, res.hidden[id] === true, '仍可见');

  // ── 真实执行链路未动：REST 推演仍返回候选 ──
  const fc = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/forecast?context=电力市场交易&k=4&fast=1');
      const d = await r.json();
      return { ok: true, n: (d.candidates || []).length };
    } catch (e) { return { ok: false, err: String(e) }; }
  });
  ok('opaque 下 REST /api/forecast 仍可用', fc.ok && fc.n > 0, JSON.stringify(fc));
  await page.close();

  ok('0 个 JS 运行时错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
