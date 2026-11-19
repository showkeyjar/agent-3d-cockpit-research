/* v0.9.35 回归：达成度与「有无产出」判据一致性
   断点：旧 looksLikeLog 正则把真实 LLM 短答案 /「已生成…」开头正文误判为无产出，
   导致 completion=achieved 却显示「没有拿到模型生成的答案」、工具隐藏（自相矛盾）。
   验证：
   1) 真实短答案（<8字）with completion=achieved → 正文显示该答案、达成度=目标达成、工具显示
   2) 「已生成…」开头正文 → 同样一致（不被旧正则误伤）
   3) local 失败 / clarify / 以 [ 开头 → 如实显示无产出、不显示复制导出工具
   4) 未回传 completion 的老数据 → fallback 与 hasReal 一致推导
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._rcSet, null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
  const render = (d) => page.evaluate((detail) => {
    const c = window.__cockpit;
    c._rcSet(detail); c._rcShow();
    return {
      output: document.getElementById('rcOutput').textContent,
      source: document.getElementById('rcSource').textContent,
      compText: document.getElementById('rcCompText').textContent,
      deliver: c.deliverShown,
      compAction: c.compActionShown,
    };
  }, d);

  // 1) 真实短答案 + achieved
  let r = await render({ ok:true, source:'llm', output:'建议选A方案', completion:'achieved',
                         mode:'choice', label:'测试', idx:0 });
  check('短答案：正文显示真实产出', r.output === '建议选A方案', r.output);
  check('短答案：来源标为来自大模型', /大模型/.test(r.source), r.source);
  check('短答案：达成度=目标达成', /目标达成/.test(r.compText) && !/部分/.test(r.compText), r.compText);
  check('短答案：交付工具可用', r.deliver === true, r.deliver);
  check('短答案：复制/导出行动按钮出现', r.compAction === true, r.compAction);

  // 2) 「已生成…」开头 + achieved（旧正则误伤场景）
  r = await render({ ok:true, source:'llm', output:'已生成完整的市场分析报告，要点如下……', completion:'achieved',
                     mode:'choice', label:'测试', idx:0 });
  check('已生成开头：正文显示真实产出（非「没有成果」）',
    /已生成完整的市场分析报告/.test(r.output) && !/没有拿到模型生成的答案/.test(r.output), r.output);
  check('已生成开头：达成度与产出一致', /目标达成/.test(r.compText) && r.deliver === true,
    { comp: r.compText, deliver: r.deliver });

  // 3a) local 失败 → 如实无产出
  r = await render({ ok:false, source:'local', output:'', completion:'partial', reason:'model_busy',
                     note:'推理槽被占用', mode:'choice', label:'测试', idx:0 });
  check('local 失败：如实显示无产出', /没有拿到模型生成的答案|执行未成功/.test(r.output), r.output);
  check('local 失败：来源标为无真实产出', /无真实产出/.test(r.source), r.source);
  check('local 失败：交付工具隐藏', r.deliver === false, r.deliver);

  // 3b) clarify → need_input，不显示工具
  r = await render({ ok:true, clarify:true, source:'llm', output:'', completion:'need_input',
                     question:'请提供数据', mode:'choice', label:'测试', idx:-1 });
  // 注：clarify 卡走专门分支（问题区/回答条/引导），达成度语义由卡面呈现，
  // 不依赖 rcCompletion 区；此处只验证 P0 纪律「无真实产出不给交付工具」。
  check('clarify：不显示交付工具', r.deliver === false, r.deliver);
  check('clarify：问题文本在卡面呈现',
    /请提供数据/.test(await page.evaluate(() => document.getElementById('rcQuestionBig').textContent)), 'question');

  // 3c) 以 [ 开头 → 后端判 need_input，前端也应无产出
  r = await render({ ok:true, source:'llm', output:'[需要输入: 请提供销售数据]', completion:'need_input',
                     mode:'choice', label:'测试', idx:0 });
  check('[开头：如实无产出', !r.deliver && /无真实产出|没有拿到/.test(r.source + r.output),
    { source: r.source, output: r.output, deliver: r.deliver });

  // 4) 老数据无 completion：fallback 由 hasReal 推导，短答案也算 achieved
  r = await render({ ok:true, source:'llm', output:'用方案B', mode:'choice', label:'测试', idx:0 });
  check('老数据 fallback：短答案推导为目标达成', /目标达成/.test(r.compText), r.compText);
  check('老数据 fallback：交付工具可用', r.deliver === true, r.deliver);

  check('JS 零错误', errors.length === 0, errors.slice(0, 3));

  console.log('=== v0.9.35 达成度/产出判据一致性回归 ===');
  results.forEach(x => console.log((x.ok ? '✅' : '❌') + ' ' + x.name + (x.ok ? '' : ' → ' + JSON.stringify(x.detail))));
  const pass = results.every(x => x.ok) && errors.length === 0;
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 有失败项');
  console.log('JS错误:', errors.length ? errors.slice(0, 3) : '无');
  await browser.close();
  if (!pass) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
