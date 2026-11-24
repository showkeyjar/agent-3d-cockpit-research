/* test_view_horizon.js — v0.9.56 · Q-b 语义视野边界可视化回归
 *
 * 研究背景（docs/CROSS-TURN-PROGRESS.md §7 Q-b）：
 *   账本 _runs 完整累积、语义摘要 buildSessionDigest 只留 tail=6 真实轮。
 *   Q-d 已把「本轮收尾时视野内 seq」写进 digest_kept_seqs（只读投影）。
 *   Q-b 把这件事显式标到 2D 会话脉络视图：让用户看见模型忘了什么、要不要重提。
 *
 * 纪律：这是【呈现层只读投影】——不改账本写入、不改摘要内容、不改机位/执行链，
 *   不新增完成信号。本测试只验证「信息在界面上可核对」，不验证任何用户效果。
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:8770/';
const EXE = resolveChromePath();

let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log(`  ${ok?'✅':'❌'} ${name}${extra?'  '+extra:''}`);
  ok?pass++:fail++;
};

(async()=>{
  const browser = await chromium.launch({ executablePath: EXE, headless:true });
  try {
    const page = await browser.newPage({ viewport:{width:1440,height:900} });
    const errs = [];
    page.on('pageerror', e=>errs.push(String(e)));
    await page.goto(BASE, {waitUntil:'load'});
    await page.waitForFunction(()=>window.__cockpit && window.__cockpit.sessionThreadHorizon, null, {timeout:20000});

    console.log('\n=== A. 9 轮真实轮：视野边界与掉出时点 ===');
    for (let i=1;i<=9;i++){
      await page.evaluate(k=>window.__cockpit._injectExecuteDoneForTest({
        ok:true, source:'llm', output:`第${k}轮真实结论：视野边界回归-${k}`, completion:'achieved',
        tasks:[], chain:[] }), i);
    }
    const h = await page.evaluate(()=>window.__cockpit.sessionThreadHorizon);
    const kept = await page.evaluate(()=>window.__cockpit.digestKeptNow);
    check('9 轮账本完整', h.length===9, 'n='+h.length);
    check('当前视野只留最近 6 轮（4–9）', kept.join(',')==='4,5,6,7,8,9', 'kept='+kept.join(','));
    const inView = h.filter(x=>x.inView).map(x=>x.seq);
    const out = h.filter(x=>!x.inView).map(x=>x.seq);
    check('视野内 = 4–9', inView.join(',')==='4,5,6,7,8,9', 'in='+inView.join(','));
    check('已掉出 = 1–3', out.join(',')==='1,2,3', 'out='+out.join(','));
    const drops = h.filter(x=>!x.inView).map(x=>x.dropSeq);
    check('掉出时点逐轮递进 7/8/9', drops.join(',')==='7,8,9', 'drops='+drops.join(','));
    check('视野内轮无掉出时点', h.filter(x=>x.inView).every(x=>x.dropSeq===null));

    console.log('\n=== B. 脉络视图：标记真实上屏 ===');
    await page.evaluate(()=>window.__cockpit.setTlViewForTest('thread'));
    const txt = await page.evaluate(()=>window.__cockpit.sessionThreadText);
    check('有视图说明图例', txt.includes('模型视野') && txt.includes('只读投影'));
    check('视野内标记上屏', txt.includes('模型视野内'));
    check('掉出标记含时点（第7轮起）', txt.includes('已掉出模型视野（第7轮起）'), txt.slice(0,180));
    const dots = await page.evaluate(()=>({
      total:document.querySelectorAll('#tlThread .tt-row.run').length,
      outside:document.querySelectorAll('#tlThread .tt-row.run.outside').length,
    }));
    check('9 个执行轮全部上屏', dots.total===9, JSON.stringify(dots));
    check('3 个掉出轮用虚线圆点区分', dots.outside===3, JSON.stringify(dots));

    console.log('\n=== C. 非真实轮：诚实标为不进摘要，不冒充视野内 ===');
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'演示组假执行', completion:'achieved', decorative:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'综合终版', completion:'achieved', synthesized:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:false, source:'local', output:'本地兜底', completion:'partial', tasks:[], chain:[] }));
    const h2 = await page.evaluate(()=>window.__cockpit.sessionThreadHorizon);
    check('12 轮全部入账本', h2.length===12, 'n='+h2.length);
    check('3 个非真实轮标 real=false', h2.filter(x=>!x.real).length===3,
      JSON.stringify(h2.filter(x=>!x.real).map(x=>x.seq)));
    check('非真实轮不冒充视野内', h2.filter(x=>!x.real).every(x=>!x.inView && x.dropSeq===null));
    const kept2 = await page.evaluate(()=>window.__cockpit.digestKeptNow);
    check('非真实轮不改变视野集合', kept2.join(',')==='4,5,6,7,8,9');
    const txt2 = await page.evaluate(()=>window.__cockpit.sessionThreadText);
    const neverBadges = await page.evaluate(()=>document.querySelectorAll('#tlThread .tt-horizon.never').length);
    check('3 个「不进入语义摘要」标记上屏', neverBadges===3, 'n='+neverBadges);
    check('非真实轮文本不出现在视野标记里', txt2.includes('不进入语义摘要'));

    console.log('\n=== D. 只读性：账本未被可视化改动 ===');
    const runs = await page.evaluate(()=>window.__cockpit.runs);
    check('12 轮 status/来源未被投影改写', runs.length===12 && runs.every(r=>r.status==='done'||r.status==='failed'));
    check('digest_kept_seqs 字段仍在账本里', runs.every(r=>Array.isArray(r.digest_kept_seqs)));

    check('全程 0 JS 错误', errs.length===0, errs.join('|'));
  } catch(e){
    check('脚本执行无异常', false, String(e));
  } finally {
    await browser.close();
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail?1:0);
})();
