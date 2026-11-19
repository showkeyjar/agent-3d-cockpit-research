// test_p0_action.js —— v0.9.31 P0 行动化回归
// 验证：①达成度→下一步按钮（achieved=复制/导出、partial=展开、无产出=隐藏）
//       ②整轮成果汇总导出只收真实 LLM 成果、带达成度与父轮关系。
const { chromium } = require('playwright-core');
const path = require('path');
const chromeHelper = require('./chrome_helper.js');

const INDEX = 'http://127.0.0.1:8770/';
let pass=0, fail=0;
function ok(label, cond){ if(cond){pass++;console.log('  OK  '+label);} else {fail++;console.log('  FAIL '+label);} }

(async () => {
  const browser = await chromium.launch({ headless:true, executablePath: chromeHelper.resolveChromePath ? chromeHelper.resolveChromePath() : undefined });
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
  await page.goto(INDEX);
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._exportAllDeliverablesPreview, null, {timeout:20000});

  // ---- ① achieved → 复制/导出按钮 ----
  let r = await page.evaluate(() => {
    const c = window.__cockpit;
    c._rcSet({ok:true, source:'llm', completion:'achieved', label:'起草指南',
      context:'起草团队协作指南', output:'一、代码评审……二、文档更新……三、问题响应……',
      elapsed_ms:5000, tokens:120, chain:['output'], tasks:[]});
    c._rcShow();
    return { shown:c.compActionShown, labels:c.compActionLabels };
  });
  ok('achieved 显示行动按钮', r.shown);
  ok('achieved 按钮含复制+导出', r.labels.some(x=>x.includes('复制')) && r.labels.some(x=>x.includes('导出')));

  // ---- ② partial → 展开按钮 ----
  r = await page.evaluate(() => {
    const c = window.__cockpit;
    c._rcSet({ok:true, source:'llm', completion:'partial', label:'分析',
      context:'分析数据', output:'要点摘要（150字）……',
      elapsed_ms:3000, tokens:60, chain:['output'], tasks:[]});
    c._rcShow();
    return { shown:c.compActionShown, labels:c.compActionLabels };
  });
  ok('partial 显示行动按钮', r.shown);
  ok('partial 按钮=展开完整成果', r.labels.some(x=>x.includes('展开')));

  // ---- ③ 无真实产出 → 隐藏 ----
  r = await page.evaluate(() => {
    const c = window.__cockpit;
    c._rcSet({ok:false, source:'local', completion:'partial', label:'失败',
      context:'x', output:'', reason:'llm_failed', tasks:[]});
    c._rcShow();
    return { shown:c.compActionShown };
  });
  ok('无真实产出不显示行动按钮', !r.shown);

  // ---- ④ 整轮汇总导出 ----
  const sum = await page.evaluate(() => {
    const c = window.__cockpit;
    // 注入两类 run：真实 llm done + 兜底 local + clarify，汇总应只收 llm done
    c._recordRun({ok:true, source:'llm', completion:'achieved', label:'起草',
      context:'起草团队协作指南', output:'成果A完整正文：一、代码评审流程……',
      elapsed_ms:5000, tokens:120, chain:['output'], tasks:[]}, 'done');
    c._recordRun({ok:false, source:'local', completion:'partial', label:'兜底',
      context:'起草团队协作指南', output:'本地降级文本', tasks:[]}, 'done');
    c._recordRun({clarify:true, source:'llm', completion:'need_input',
      context:'起草团队协作指南', question:'请说明工具', tasks:[]}, 'clarify');
    // refine 轮：承接第1轮，带 parent
    c._rcSet({ok:true, source:'llm', completion:'achieved', label:'起草',
      context:'起草团队协作指南', output:'成果A完整正文：一、代码评审流程……',
      elapsed_ms:5000, tokens:120, chain:['output'], tasks:[]});
    c._rcShow();
    c._injectRefineDone({output:'成果A展开完整版：一、代码评审流程（细化）……二、文档更新……',
      completion:'achieved', self_rating:'达成', mode:'expand', source:'llm'});
    return c._exportAllDeliverablesPreview();
  });
  ok('汇总导出返回文本', typeof sum === 'string' && sum.length > 0);
  ok('汇总含标题', sum.includes('# 本次旅程 · 成果汇总'));
  ok('汇总含真实成果正文', sum.includes('成果A') && sum.includes('代码评审'));
  ok('汇总含 refine 完整版', sum.includes('展开完整版'));
  ok('汇总标注 refine 类型', sum.includes('refine'));
  ok('汇总排除本地兜底文本', !sum.includes('本地降级文本'));
  ok('汇总不含 clarify 反问', !sum.includes('请说明工具'));
  ok('汇总含达成度标注', sum.includes('目标达成') || sum.includes('达成度'));

  ok('无 JS 错误', errors.length===0);
  console.log(`\nRESULT: ${pass}/${pass+fail} ${fail===0?'PASS':'FAIL'}`);
  if(errors.length) console.log('errors:', errors.join(' | '));
  await browser.close();
  process.exit(fail===0?0:1);
})().catch(e=>{ console.error('EXCEPTION', e); process.exit(2); });
