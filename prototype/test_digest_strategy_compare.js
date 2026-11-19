/* test_digest_strategy_compare.js — Q-a 摘要保留策略离线对比探针
 *
 * 研究主题：跨轮次进展（docs/CROSS-TURN-PROGRESS.md §7 Q-a）
 * 问题：buildSessionDigest 的 tail=6 是否最优？"最近 N 轮 + achieved 里程碑永久保留"
 *       能否在可控膨胀下提升跨轮累积保真？
 *
 * 方法（不碰生产默认值、不依赖真人、不占模型槽）：
 *   1. 用 _injectExecuteDoneForTest 注入一个含干扰轮的多轮账本；
 *   2. 读真实账本 runs + 真实 buildSessionDigest() 作为 golden；
 *   3. 用真实 run 对象跑离线模拟器，先用 S1(tail=6) 与 golden 逐字校验——
 *      逐字相等才证明模拟器忠实，随后才比较其它策略；
 *   4. 多策略对比 RQ1(累积保真) / 里程碑保留率 / 膨胀成本 / 诚实约束。
 *
 * 诚实边界：这是"摘要文本保留机制"的离线对比，用注入账本而非真实多轮 LLM 交互；
 *   它回答"哪种保留策略在信息层保留更多"，不回答"用户是否因此感到进展累积"(H4.1[真人])。
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

// ── 诚实边界：策略只在"真实轮"集合里挑；干扰轮永远排除 ──
function isRealRun(r){
  return r.status === 'done' && r.exec && r.exec.source === 'llm'
    && !r.exec.decorative && !r.exec.synthesized && String(r.output || '').trim();
}
// 逐字复刻 oneLineConclusion（30字截断），再复刻 digest 的 slice(0,60)
function oneLine(obj){
  if (!obj) return '';
  const o = String(obj.output || '').replace(/\s+/g, ' ').trim();
  if (o) return o.length > 30 ? o.slice(0,30) + '\u2026' : o;
  return obj.label || obj.branchLabel || obj.question || '\uff08无文本产出\uff09';
}
const COMP_TEXT = { achieved:'\u76ee\u6807\u8fbe\u6210', partial:'\u90e8\u5206\u8fbe\u6210', need_input:'\u5f85\u8865\u8f93\u5165' };

// 策略：tailN=最近N轮；milestone=是否永久保留全部 achieved 真实轮；maxTotal=保留上限(0=不限)
function selectKept(real, {tailN, milestone, maxTotal=0}){
  const tail = tailN > 0 ? real.slice(-tailN) : [];   // 注意 slice(-0)===slice(0)，必须显式处理 0
  if (!milestone) return tail;
  const achieved = real.filter(r => r.exec && r.exec.completion === 'achieved');
  const bySeq = new Map();
  [...tail, ...achieved].forEach(r => bySeq.set(r.seq, r));
  let kept = [...bySeq.values()].sort((a,b) => a.seq - b.seq);
  if (maxTotal > 0 && kept.length > maxTotal){
    // 优先保最近 tailN，再从里程碑里按 seq 由近及远补足
    const recent = new Set(tail.map(r=>r.seq));
    const extras = achieved.filter(r=>!recent.has(r.seq)).reverse();
    kept = [...tail];
    const room = maxTotal - tail.length;
    for (const r of extras){ if (kept.length >= maxTotal) break; kept.push(r); }
    kept.sort((a,b)=>a.seq-b.seq);
  }
  return kept;
}
function linesOf(kept){
  return kept.map(r => {
    const concl = oneLine(r).replace(/\s+/g,' ').slice(0,60);
    const dir = String(r.label || r.branch_label || '').slice(0,18);
    const comp = (r.exec && COMP_TEXT[r.exec.completion]) || (r.exec && r.exec.completion) || '';
    return `\u00b7 \u7b2c${r.seq}\u8f6e${dir ? `\u6cbf\u300c${dir}\u300d` : ''}\uff1a${concl}${comp ? `\uff08${comp}\uff09` : ''}`;
  });
}
function assemble(lines, markers){
  if (!lines.length) return '';
  return '\n\n' + markers.begin + '\n' + lines.join('\n') + '\n' + markers.end;
}

(async()=>{
  const browser = await chromium.launch({ executablePath: EXE, headless:true });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e=>errs.push(String(e)));
    await page.goto(BASE, {waitUntil:'load'});
    await page.waitForFunction(()=>window.__cockpit && window.__cockpit._injectExecuteDoneForTest, null, {timeout:20000});

    // ── 注入一个 12 真实轮 + 干扰轮的多轮账本 ──
    console.log('\n=== 构造账本：12 真实轮 + 干扰轮 ===');
    // 达成度分布：早期/中期多 achieved（里程碑），后期混杂 partial/need_input
    const comps = ['achieved','achieved','partial','achieved','need_input','achieved',
                   'partial','achieved','need_input','partial','achieved','achieved'];
    for (let i=0;i<comps.length;i++){
      await page.evaluate(m=>window.__cockpit._injectExecuteDoneForTest(m), {
        ok:true, source:'llm', completion:comps[i],
        label:'\u65b9\u5411'+String.fromCharCode(65+(i%6)),
        output:'\u7b2c'+(i+1)+'\u8f6e\u771f\u5b9e\u7ed3\u8bba\uff1a\u7535\u529b\u5e02\u573a\u6a21\u5f0f\u5206\u6790\u8981\u70b9-'
               +(i+1)+'\uff0c\u53ef\u6838\u5bf9\u6570\u636e'+String(i+1)+'\u9879\uff0c'+'\u8865\u5145\u8be6\u7ec6\u8bba\u8bc1\u4e0e\u6570\u636e\u6765\u6e90\u8bf4\u660e\u6587\u672c\u8f83\u957f\u90e8\u5206\u5e94\u88ab\u622a\u65ad',
        tasks:[], chain:[] });
    }
    // 干扰轮：decorative / synthesized / ok=false(failed) / 空输出 —— 都不该进摘要
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'\u88c5\u9970\u8f6e\u4e0d\u8fdb\u6458\u8981', completion:'achieved', decorative:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'\u7efc\u5408\u8f6e\u4e0d\u8fdb\u6458\u8981', completion:'achieved', synthesized:true, tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:false, source:'llm', output:'\u5931\u8d25\u8f6e\u4e0d\u8fdb\u6458\u8981', completion:'partial', tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', output:'', completion:'achieved', tasks:[], chain:[] }));

    const runs = await page.evaluate(()=>window.__cockpit.runs.map(r=>({
      seq:r.seq, status:r.status, output:r.output, label:r.label || r.branch_label || '',
      exec:{ source:r.exec && r.exec.source, completion:r.exec && r.exec.completion,
             decorative:!!(r.exec && r.exec.decorative), synthesized:!!(r.exec && r.exec.synthesized) }
    })));
    const golden = await page.evaluate(()=>window.__cockpit._buildSessionDigestForTest());
    const markers = await page.evaluate(()=>window.__cockpit.digestMarkers);
    const real = runs.filter(isRealRun);

    console.log(`  账本总轮数=${runs.length}  真实轮=${real.length}  干扰轮=${runs.length-real.length}`);
    check('真实轮识别 = 12', real.length===12, 'real='+real.length);
    check('干扰轮全部被排除', runs.length-real.length===4);

    // ── golden 校验：离线模拟器 S1(tail=6) 必须与真实 digest 逐字相等 ──
    console.log('\n=== Golden 校验：模拟器忠实性 ===');
    const s1lines = linesOf(selectKept(real, {tailN:6, milestone:false}));
    const s1assembled = assemble(s1lines, markers);
    check('S1(tail=6) 模拟输出 === 真实 buildSessionDigest() 逐字相等', s1assembled===golden,
          s1assembled===golden ? '' : `\n  SIM=${JSON.stringify(s1assembled)}\n  GOLD=${JSON.stringify(golden)}`);
    check('golden 含成对标记', golden.includes(markers.begin) && golden.includes(markers.end));

    // ── 多策略对比 ──
    console.log('\n=== 策略对比（mutually exclusive 的决议数据）===');
    const strategies = [
      {id:'S1', name:'tail=6（生产基线）',        tailN:6,  milestone:false, maxTotal:0},
      {id:'S2', name:'tail=3（更激进防膨胀）',    tailN:3,  milestone:false, maxTotal:0},
      {id:'S3', name:'tail=12（近全量）',         tailN:12, milestone:false, maxTotal:0},
      {id:'S4', name:'tail=6 + achieved 里程碑永久保留', tailN:6, milestone:true, maxTotal:0},
      {id:'S5', name:'tail=3 + 里程碑(上限6)',    tailN:3,  milestone:true, maxTotal:6},
      {id:'S6', name:'仅 achieved 里程碑',        tailN:0,  milestone:true, maxTotal:0},
    ];
    const rows = [];
    for (const s of strategies){
      const kept = selectKept(real, s);
      const lines = linesOf(kept);
      const text = lines.join('\n');
      const achievedSet = new Set(real.filter(r=>r.exec.completion==='achieved').map(r=>r.seq));
      const keptSet = new Set(kept.map(r=>r.seq));
      const achievedKept = [...achievedSet].filter(q=>keptSet.has(q)).length;
      const dropped = real.filter(r=>!keptSet.has(r.seq)).map(r=>r.seq);
      rows.push({
        id:s.id, name:s.name,
        kept:kept.length,
        recall:+(kept.length/real.length).toFixed(3),
        achKept:achievedKept, achTotal:achievedSet.size,
        achRate:+(achievedKept/achievedSet.size).toFixed(3),
        chars:text.length,
        dropped: dropped.join(','),
      });
    }
    console.log('\n  策略                                  保留   RQ1recall  里程碑      字符数  丢弃seq');
    console.log('  ------------------------------------------------------------------------------------');
    for (const r of rows){
      console.log(`  ${r.id} ${r.name.padEnd(30)} ${String(r.kept).padStart(2)}    ${r.recall.toFixed(3)}      ${r.achKept}/${r.achTotal}(${r.achRate.toFixed(2)})  ${String(r.chars).padStart(4)}   ${r.dropped}`);
    }

    // ── 断言：策略行为的必然性质 ──
    console.log('\n=== 策略性质断言 ===');
    const byId = Object.fromEntries(rows.map(r=>[r.id,r]));
    check('S1 基线保留 6 轮', byId.S1.kept===6, 'kept='+byId.S1.kept);
    check('S2(tail=3) 保留更少', byId.S2.kept===3);
    check('S3(tail=12) 保留全部 12 真实轮', byId.S3.kept===12);
    check('S3 字符数 > S1（膨胀代价成立）', byId.S3.chars>byId.S1.chars, `${byId.S3.chars}>${byId.S1.chars}`);
    check('S4 永久保住全部 achieved 里程碑', byId.S4.achRate===1, `${byId.S4.achKept}/${byId.S4.achTotal}`);
    check('S4 在 S1 基础上回收了早期 achieved', byId.S4.recall>byId.S1.recall,
          `${byId.S4.recall}>${byId.S1.recall}`);
    check('S5 有上限(6)，膨胀受控', byId.S5.kept<=6, 'kept='+byId.S5.kept);
    check('S5 上限受控下保住 5/7 里程碑（tail占3席+补3席，如实记录）',
          byId.S5.achKept===5, `${byId.S5.achKept}/${byId.S5.achTotal}`);
    check('S5 同等字符预算下比 S1 多保里程碑（302字符:5 vs 3）',
          byId.S5.chars===byId.S1.chars && byId.S5.achKept>byId.S1.achKept,
          `chars ${byId.S5.chars}/${byId.S1.chars} ach ${byId.S5.achKept}/${byId.S1.achKept}`);
    check('S6 只留 achieved（7个；丢弃5个 partial/need_input 最近轮）', byId.S6.kept===byId.S6.achTotal,
          `kept=${byId.S6.kept} ach=${byId.S6.achTotal}`);
    check('所有策略都未把干扰轮算进保留（诚实约束）',
          strategies.every(s=>selectKept(real,s).every(r=>isRealRun(r))));
    check('0 JS 错误', errs.length===0, errs.join('|'));

    // 落一份可复算快照
    const snapshot = { generatedAt:new Date().toISOString(), totalRuns:runs.length, realRuns:real.length,
      goldenMatchesSimulator: s1assembled===golden, strategies:rows };
    console.log('\n=== SNAPSHOT ===');
    console.log(JSON.stringify(snapshot, null, 2));

    console.log(`\n===== RESULT ${pass}/${pass+fail} =====`);
    if (fail) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(e=>{ console.error('FATAL', e); process.exitCode = 1; });
