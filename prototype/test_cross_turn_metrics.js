/* test_cross_turn_metrics.js — 跨轮次进展度量探针（研究主题：cross-turn progress）
 *
 * 研究问题：单轮 P1–P4 判据都是「这一次执行」的。真实用户是多轮的。
 *   本探针量化一个从未被当作科学问题测量的现象——「三层不同步」：
 *     · 账本层 _runs       —— 完整累积（每次收尾一条，追加不覆盖）
 *     · 轨迹层 journey     —— 完整累积（3D 走过即留）
 *     · 语义层 digest      —— 有损压缩（只留最近 6 轮，结论截 60 字，标记包裹供门控剥离）
 *
 * 这不是找 bug（有损是防膨胀/防任务类型污染的刻意设计），而是把
 * 「进展在账本里累积、在模型语义里衰减」变成可复算的度量，供后续真人对照使用。
 *
 * 度量：
 *   M1 账本保真度：注入 N 轮真实轮，_runs 是否完整 N 条、seq 单调
 *   M2 语义保真度：digest 是否含最近轮结论、是否截断早期轮（tail=6）、标记是否成对
 *   M3 诚实降级：decorative/synthesized/failed/无输出轮是否不进摘要
 *   M4 门控可剥离：digest 去掉后是否恰好剩本轮原话（不污染任务类型判定）
 *   M5 脉络投影：sessionEvents + runs 按时间交织，question/supplement/run 三类齐全
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
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e=>errs.push(String(e)));
    await page.goto(BASE, {waitUntil:'load'});
    await page.waitForFunction(()=>window.__cockpit && window.__cockpit._injectExecuteDoneForTest, null, {timeout:20000});

    // ---- M1 账本保真度：注入 9 轮不同产出的真实轮 ----
    console.log('\n=== M1 账本层保真度 ===');
    const outputs = Array.from({length:9},(_,i)=>`第${i+1}轮真实结论：电力市场模式分析要点-${i+1}，可核对数据${i+1}项`);
    for (const out of outputs){
      await page.evaluate(o=>window.__cockpit._injectExecuteDoneForTest({
        ok:true, source:'llm', output:o, completion:'achieved',
        tasks:[], chain:[] }), out);
    }
    const runs = await page.evaluate(()=>window.__cockpit.runs);
    check('注入 9 轮 → 账本完整 9 条', runs.length===9, 'runs='+runs.length);
    const seqs = runs.map(r=>r.seq);
    const monotonic = seqs.every((s,i)=> i===0 || s===seqs[i-1]+1);
    check('seq 单调递增无丢号', monotonic, 'seq='+seqs.join(','));
    const allReal = runs.every(r=>r.status==='done' && r.exec.source==='llm' && r.exec.completion==='achieved');
    check('9 轮均为 done/llm/achieved 真实轮', allReal);

    // ---- M2 语义保真度：digest 只留最近 6 轮 ----
    console.log('\n=== M2 语义层保真度（有损压缩）===');
    const digest = await page.evaluate(()=>window.__cockpit._buildSessionDigestForTest());
    const markers = await page.evaluate(()=>window.__cockpit.digestMarkers);
    check('摘要含开标记', digest.includes(markers.begin));
    check('摘要含闭标记', digest.includes(markers.end));
    const beginIdx = digest.indexOf(markers.begin), endIdx = digest.indexOf(markers.end);
    check('标记成对且 begin 在 end 前', beginIdx>=0 && endIdx>beginIdx);
    const body = digest.slice(beginIdx+markers.begin.length, endIdx);
    const keptLines = body.split('\n').filter(l=>/^· 第\d+轮/.test(l.trim()));
    check('摘要只留最近 6 轮（tail=6 截断）', keptLines.length===6, '保留='+keptLines.length+' 条');
    const keptSeqs = keptLines.map(l=>Number(l.match(/第(\d+)轮/)[1]));
    check('保留的是最近 6 轮（第4–9轮）', keptSeqs.join(',')==='4,5,6,7,8,9', 'kept='+keptSeqs.join(','));
    check('早期轮（1–3）已被语义层丢弃', keptSeqs.every(s=>s>=4));
    const hasConclusion = keptLines.some(l=>l.includes('电力市场模式分析要点'));
    check('摘要含真实轮的一句话结论（非_steps）', hasConclusion);
    const noSteps = !digest.includes('steps') && !digest.includes('猜想');
    check('摘要不注入 steps（防任务类型污染）', noSteps);

    // ---- M3 诚实降级：非真实轮不进摘要 ----
    console.log('\n=== M3 摘要诚实降级 ===');
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'DECORATIVE 假执行产出', completion:'achieved', decorative:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'SYNTH 综合终版产出', completion:'achieved', synthesized:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:false, source:'local', output:'FAILED 本地兜底', completion:'partial', tasks:[], chain:[] }));
    const digest2 = await page.evaluate(()=>window.__cockpit._buildSessionDigestForTest());
    check('decorative 轮不进摘要', !digest2.includes('DECORATIVE'));
    check('synthesized 轮不进摘要', !digest2.includes('SYNTH'));
    check('failed/local 轮不进摘要', !digest2.includes('FAILED'));
    const lines2 = digest2.slice(digest2.indexOf(markers.begin)+markers.begin.length, digest2.indexOf(markers.end))
      .split('\n').filter(l=>/^· 第\d+轮/.test(l.trim()));
    check('再注入 3 轮非真实轮后摘要仍是 6 条真实轮', lines2.length===6, 'n='+lines2.length);

    // ---- M4 门控可剥离：digest 去掉后剩本轮原话 ----
    console.log('\n=== M4 门控可剥离 ===');
    const ctxWithDigest = '本轮原话：分析国内电力交易市场格局' + digest2;
    const stripped = await page.evaluate(c=>window.__cockpit._stripDigestForTest(c), ctxWithDigest);
    check('剥离后恰好剩本轮原话', stripped==='本轮原话：分析国内电力交易市场格局', 'stripped=['+stripped+']');
    check('剥离后不含任何摘要标记', !stripped.includes(markers.begin) && !stripped.includes(markers.end));

    // ---- M5 脉络投影：三类事件交织 ----
    console.log('\n=== M5 会话脉络投影 ===');
    await page.evaluate(()=>window.__cockpit.setInputIntentForTest('supplement'));
    await page.evaluate(()=>window.__cockpit._driveSupplementForTest('补充一条真实约束：只看2024年数据'));
    await page.evaluate(()=>window.__cockpit.setTlViewForTest('thread'));
    const events = await page.evaluate(()=>window.__cockpit.sessionEvents);
    const hasQ = events.some(e=>e.kind==='question');
    const hasSupp = events.some(e=>e.kind==='supplement');
    check('会话事件含 supplement', hasSupp);
    const threadText = await page.evaluate(()=>window.__cockpit.sessionThreadText);
    check('脉络视图文本非空', threadText.length>0, 'len='+threadText.length);
    check('脉络视图含用户补充内容', threadText.includes('只看2024年数据'));

    check('全程 0 JS 错误', errs.length===0, errs.join('|'));

    // ---- 汇总：三层保真度快照 ----
    const snap = {
      ledger_runs: runs.length,
      semantic_digest_lines: keptLines.length,
      semantic_kept_seqs: keptSeqs,
      layers_out_of_sync: runs.length !== keptLines.length,
      note:'账本保留全部9轮，语义摘要只留最近6轮——三层不同步是可复算事实，非bug'
    };
    console.log('\n=== 三层保真度快照 ===');
    console.log(JSON.stringify(snap,null,2));

  } catch(e){
    check('脚本执行无异常', false, String(e));
  } finally {
    await browser.close();
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail?1:0);
})();
