// v0.9.24 回归：3D 路牌必须显示对话里的具体业务词（本地兜底不再空洞）
// 走真实 8770 fast=1 链路（不占 35B 单槽），验证路牌文字随会话主题变化、
// 凭据仍如实标「本地预览/模型未参与」，且 3D 不变量零回退。
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const HOLLOW = /写代码|查文档|给示例|查资料|对比分析|查数据|你关注的这件事|^总结$|^先问清楚$|^分步推理$/;

async function explore(page, question){
  await page.evaluate(q => window.__cockpit.setContext(q), question);
  await page.evaluate(() => window.__cockpit._exploreNext([8, 0, 8], '', []));
  await page.waitForFunction(() => window.__cockpit.kbFutures.length >= 3, { timeout: 15000 });
  return page.evaluate(() => ({
    labels: window.__cockpit.kbFutures.map(x => x.label),
    signs: window.__cockpit.futureSigns.length,
    proof: window.__cockpit.forecastProof.future,
    badge: window.__cockpit.proofBadge,
    offRail: window.__cockpit.camOffRail,
  }));
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  console.log('\n[A] 业务问题 ①：电力市场交易');
  const a = await explore(page, '电力市场交易');
  ok('未来牌铺出 ≥3 块', a.signs >= 3, a.signs);
  ok('每块牌都含真实业务词「电力市场交易」',
     a.labels.length > 0 && a.labels.every(l => l.includes('电力市场交易')), a.labels);
  ok('不含空洞通用词 / 占位符', !a.labels.some(l => HOLLOW.test(l)), a.labels);
  ok('牌面是「动作 + 业务对象」而非纯动作',
     a.labels.every(l => /^(检索|拆解|对照|核算|落地|汇总)/.test(l)), a.labels);
  ok('凭据如实标本地预览（未调用模型）',
     a.proof && a.proof.source === 'local' && a.proof.kind === 'fast', a.proof);
  ok('徽章不冒充模型推演', /本地预览|本地兜底/.test(a.badge), a.badge);

  console.log('\n[B] 业务问题 ②：换主题后路牌跟着变（不是固定模板）');
  const b = await explore(page, '白洋淀机载高光谱数据怎么做碳汇反演');
  ok('未来牌重新铺出 ≥3 块', b.signs >= 3, b.signs);
  ok('每块牌锚定新主题（高光谱数据 / 碳汇反演）',
     b.labels.length > 0 && b.labels.every(l => /高光谱数据|碳汇反演/.test(l)), b.labels);
  ok('长业务对象没被丢弃（旧版整句抽不到主题）',
     b.labels.some(l => l.includes('高光谱数据')), b.labels);
  ok('不残留上一个问题的词', !b.labels.some(l => l.includes('电力市场')), b.labels);
  ok('换主题后凭据仍标本地', b.proof && b.proof.source === 'local', b.proof);

  console.log('\n[C] 业务问题 ③：英文缩写 + 真实产出上下文');
  const c = await explore(page, 'ERA5 数据聚合到 1km 产生网格残影，怎么在输入端解决');
  ok('英文缩写 ERA5 出现在牌面', c.labels.some(l => l.includes('ERA5')), c.labels);
  ok('网格残影等业务词出现在牌面',
     c.labels.some(l => /网格残影|数据聚合/.test(l)), c.labels);
  ok('疑问残片「怎么在输入端解决」不进牌面',
     !c.labels.some(l => l.includes('输入端解决')), c.labels);
  ok('不含空洞词', !c.labels.some(l => HOLLOW.test(l)), c.labels);

  console.log('\n[D] 不变量');
  ok('机位仍贴轨（camOffRail≈0）', c.offRail < 0.01, c.offRail);
  ok('全程 0 JS 错误', errors.length === 0, errors.slice(0, 3));

  console.log(`\n===== v0.9.24 路牌业务词回归：${pass} 通过 / ${fail} 失败 =====`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
