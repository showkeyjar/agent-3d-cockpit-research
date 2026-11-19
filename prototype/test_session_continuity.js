/* v0.9.37 会话脉络连续性 —— 前端回归（钩子驱动，不依赖真实模型槽位）
   覆盖四块：
   ① 会话摘要：真实轮次进摘要、兜底/模拟/综合轮不进；标记正确；剥离只留本轮
   ② 意图切换：新提问/补充当前会话 两态 UI 与 _inputIntent
   ③ 补充通道：补充不清 journey、拼进 _lastContext、记 sessionEvents
   ④ need_input 补充动作 + 会话脉络视图交织显示
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
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._injectExecuteDoneForTest,
                             null, { timeout: 20000 });

  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

  // 注入若干真实轮次作为历史（含应被排除的兜底/模拟/综合轮）
  await page.evaluate(() => {
    const c = window.__cockpit;
    c._injectExecuteDoneForTest({ ok:true, source:'llm', output:'ERA5 数据显示火险等级上升，建议加强巡护',
      label:'火险分析', completion:'achieved' });
    c._injectExecuteDoneForTest({ ok:true, source:'llm', output:'完成了巡护方案初稿，含三段式响应流程',
      label:'方案起草', completion:'achieved' });
    c._injectExecuteDoneForTest({ ok:false, source:'local', output:'本地兜底文本',
      label:'兜底轮', completion:'partial' });
    c._injectExecuteDoneForTest({ ok:true, source:'llm', output:'模拟产出', decorative:true,
      label:'演示轮', completion:'achieved' });
    c._injectExecuteDoneForTest({ ok:true, source:'llm', output:'综合终版', synthesized:true,
      label:'综合轮', completion:'achieved' });
  });

  // ── ①会话摘要 ──
  const dig = await page.evaluate(() => {
    const c = window.__cockpit;
    const d = c._buildSessionDigestForTest();
    const markers = c.digestMarkers;
    return { digest:d, begin:markers.begin, end:markers.end,
             stripped:c._stripDigestForTest('写一份报告' + d) };
  });
  check('摘要含开始标记', dig.digest.includes(dig.begin), dig.digest.slice(0,60));
  check('摘要含结束标记', dig.digest.includes(dig.end));
  check('摘要含真实轮结论(火险)', /火险等级上升/.test(dig.digest), dig.digest);
  check('摘要含真实轮结论(方案)', /三段式响应流程/.test(dig.digest), dig.digest);
  check('摘要排除兜底轮', !/本地兜底文本/.test(dig.digest), dig.digest);
  check('摘要排除模拟轮', !/模拟产出/.test(dig.digest), dig.digest);
  check('摘要排除综合轮', !/综合终版/.test(dig.digest), dig.digest);
  check('剥离标记只留本轮原话', dig.stripped === '写一份报告', dig.stripped);

  // ── ②意图切换 ──
  const intent = await page.evaluate(() => {
    const c = window.__cockpit;
    const a = c.setInputIntentForTest('supplement');
    const modeOn = document.getElementById('inputBar').classList.contains('supplement-mode');
    const ph = document.getElementById('msgInput').placeholder;
    const btn = document.getElementById('sendBtn').textContent;
    c.setInputIntentForTest('ask');
    const back = c.inputIntent;
    return { a, modeOn, ph, btn, back };
  });
  check('切到补充模式-状态', intent.a === 'supplement', intent.a);
  check('切到补充模式-视觉态', intent.modeOn === true, intent.modeOn);
  check('切到补充模式-占位文案', /补充/.test(intent.ph), intent.ph);
  check('切到补充模式-按钮文案', /补充/.test(intent.btn), intent.btn);
  check('切回新提问-状态', intent.back === 'ask', intent.back);

  // ── ③补充通道：不清 journey、拼进上下文、记事件 ──
  const supp = await page.evaluate(() => {
    const c = window.__cockpit;
    const jBefore = c.journeyLen;
    const evBefore = c.sessionEvents.length;
    const ctxBefore = c.lastContextText2;
    c.setInputIntentForTest('supplement');
    const sent = c._driveSupplementForTest('补充一个约束：只能白天巡护');
    return {
      sent, jBefore, jAfter:c.journeyLen,
      evBefore, evAfter:c.sessionEvents.length,
      ctxHas:[ '[用户补充]', '白天巡护' ].map(s => c.lastContextText2.includes(s)),
      ctxBefore,
      lastEvent:c.sessionEvents[c.sessionEvents.length-1],
    };
  });
  check('补充-发送成功', supp.sent === true, supp.sent);
  check('补充-不清旅程(与提问根本区别)', supp.jAfter === supp.jBefore,
        `${supp.jBefore}->${supp.jAfter}`);
  check('补充-记一条会话事件', supp.evAfter === supp.evBefore + 1,
        `${supp.evBefore}->${supp.evAfter}`);
  check('补充-事件类型为supplement', supp.lastEvent && supp.lastEvent.kind === 'supplement',
        JSON.stringify(supp.lastEvent));
  check('补充-带来源标记', supp.ctxHas[0] === true, supp.ctxHas);
  check('补充-内容进上下文', supp.ctxHas[1] === true, supp.ctxHas);
  check('补充后-意图自动复位ask(反向bug)', await page.evaluate(() => window.__cockpit.inputIntent) === 'ask',
        await page.evaluate(() => window.__cockpit.inputIntent));

  // ③b 复核：连续多次补充不叠加 [prev]/旅程链/推演尾句，摘要不把系统样板当用户补充
  const multi = await page.evaluate(() => {
    const c = window.__cockpit;
    c.setInputIntentForTest('supplement');
    c._driveSupplementForTest('第二次补充：只在雨季巡护');
    const ctx = c.lastContextText2;
    const digest = c._buildSessionDigestForTest();
    return {
      prevCount:(ctx.match(/\[prev\]/g)||[]).length,
      journeyTail:(ctx.match(/旅程已走过/g)||[]).length,
      forecastTail:(ctx.match(/下一步还可能做什么/g)||[]).length,
      digestHasUserSupp:/用户曾补充/.test(digest),
      digestLeakSystem:/用户曾补充[^\n]*\[prev\]|旅程已走过|下一步还可能做什么/.test(digest),
      suppLogLen:c.sessionEvents.filter(e=>e.kind==='supplement').length,
    };
  });
  check('多次补充-无[prev]叠加', multi.prevCount === 0, multi.prevCount);
  check('多次补充-无旅程链叠加', multi.journeyTail === 0, multi.journeyTail);
  check('多次补充-无推演尾句叠加', multi.forecastTail === 0, multi.forecastTail);
  check('摘要-含用户曾补充', multi.digestHasUserSupp === true, multi.digestHasUserSupp);
  check('摘要-不把系统样板当用户补充', multi.digestLeakSystem === false, multi.digestLeakSystem);

  // ── ④need_input 补充动作 + 脉络视图 ──
  const needInput = await page.evaluate(() => {
    const c = window.__cockpit;
    // 非 clarify：模型返回了文本但达成度判 need_input（走通用卡渲染，才是缺补充出口的场景）
    c._rcSet({ ok:true, source:'llm', idx:-1, label:'缺数据',
               output:'目前只能给出框架，缺少具体观测数据来落地',
               completion:'need_input', task_kind:'analysis' });
    c._rcShow();
    return { shown:c.compActionShown, labels:c.compActionLabels2.slice() };
  });
  check('need_input-补充动作出现', needInput.shown === true, needInput.shown);
  check('need_input-按钮指向补充当前会话',
        needInput.labels.some(l => /补充/.test(l)), JSON.stringify(needInput.labels));

  const thread = await page.evaluate(() => {
    const c = window.__cockpit;
    c._rcHide();
    const view = c.setTlViewForTest('thread');
    const txt = c.sessionThreadText;
    return { view, txt };
  });
  check('脉络视图-可切换', thread.view === 'thread', thread.view);
  check('脉络视图-含新问题/补充事件', /用户补充/.test(thread.txt) || /补充/.test(thread.txt),
        thread.txt.slice(0,200));
  check('脉络视图-含执行轮', /火险分析|方案起草| ERA5/.test(thread.txt), thread.txt.slice(0,300));

  // 页面无运行时异常
  check('无页面运行时异常', errors.length === 0, errors.join(' | '));

  let ok = 0;
  for (const r of results){
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}` + (r.ok ? '' : `  -> ${r.detail}`));
    if (r.ok) ok++;
  }
  console.log(`\n${ok}/${results.length} passed`);
  await browser.close();
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
