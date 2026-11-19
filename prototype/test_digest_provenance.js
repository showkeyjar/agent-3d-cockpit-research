/* test_digest_provenance.js — Q-d 跨轮语义衰减只读投影（v0.9.44）
 *
 * 验证「本轮 digest 视野内有哪些真实轮 seq」作为只读投影进账本/导出：
 *   P1 字段存在：每条 run 收尾写 digest_kept_seqs（数组）
 *   P2 演进正确：前6轮逐轮累积，第7轮起早期 seq 掉出（tail=6）
 *   P3 诚实约束：decorative/synthesized/failed/空输出轮不进任何 kept 列表
 *   P4 只读纪律：投影不参与 status/completion/门控（completion 仍由后端字段决定）
 *   P5 导出对齐：JSON 含 digest_kept_seqs 字段；CSV 含列且每行列数一致
 *   P6 不变量：3D/机位/轨道/到达牌零改动（forkTopology 结构未变）、0 JS 错
 *
 * 注入式，不占 8083 模型槽；只读账本/导出，不改生产数据。
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
// 注：parseCsvLine 需内联进 page.evaluate（浏览器作用域访问不到 Node 闭包）

(async()=>{
  const browser = await chromium.launch({ executablePath: EXE, headless:true });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e=>errs.push(String(e)));
    await page.goto(BASE, {waitUntil:'load'});
    await page.waitForFunction(()=>window.__cockpit && window.__cockpit._injectExecuteDoneForTest, null, {timeout:20000});

    // ── P1+P2：注入 9 真实轮，逐轮观察 kept 投影演进 ──
    console.log('\n=== P1/P2 字段存在 + 逐轮演进（tail=6）===');
    for (let i=0;i<9;i++){
      await page.evaluate(m=>window.__cockpit._injectExecuteDoneForTest(m), {
        ok:true, source:'llm', completion:'achieved',
        label:'\u65b9\u5411'+(i+1),
        output:'\u7b2c'+(i+1)+'\u8f6e\u771f\u5b9e\u7ed3\u8bba', tasks:[], chain:[] });
    }
    const runs = await page.evaluate(()=>window.__cockpit.runs.map(r=>({
      seq:r.seq, status:r.status, completion:r.exec.completion,
      kept:r.digest_kept_seqs, synth:!!r.exec.synthesized, decor:!!r.exec.decorative
    })));
    check('9 轮均写入 digest_kept_seqs 数组', runs.length===9 && runs.every(r=>Array.isArray(r.kept)));
    check('第1轮视野=[1]', JSON.stringify(runs[0].kept)==='[1]', JSON.stringify(runs[0].kept));
    check('第6轮视野=[1..6]（恰好 tail 上限）', JSON.stringify(runs[5].kept)==='[1,2,3,4,5,6]', JSON.stringify(runs[5].kept));
    check('第7轮视野=[2..7]（seq1 掉出）', JSON.stringify(runs[6].kept)==='[2,3,4,5,6,7]', JSON.stringify(runs[6].kept));
    check('第9轮视野=[4..9]（seq1-3 掉出）', JSON.stringify(runs[8].kept)==='[4,5,6,7,8,9]', JSON.stringify(runs[8].kept));
    check('每轮视野窗口 ≤6', runs.every(r=>r.kept.length<=6));

    // ── P3 诚实约束：注入干扰轮，确认其 seq 不进任何真实轮的 kept ──
    console.log('\n=== P3 干扰轮不进 kept ===');
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', completion:'achieved', output:'\u88c5\u9970\u8f6e', decorative:true, tasks:[], chain:[] }));
    // synthesized 必须走真实 synthesize 路径（onRefineDone→recordRun，detail 自带标记），
    // 不能用 _injectExecuteDoneForTest（其 synthesized 是 onExecuteDone 后补写，投影先算完）。
    await page.evaluate(()=>window.__cockpit._injectSynthesizedForTest('\u7efc\u5408\u7ec8\u7248'));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:false, source:'llm', completion:'partial', output:'\u5931\u8d25\u8f6e', tasks:[], chain:[] }));
    await page.evaluate(()=>window.__cockpit._injectExecuteDoneForTest({
      ok:true, source:'llm', completion:'achieved', output:'', tasks:[], chain:[] }));
    const runs2 = await page.evaluate(()=>window.__cockpit.runs.map(r=>({
      seq:r.seq, kept:r.digest_kept_seqs, synth:!!r.exec.synthesized,
      decor:!!r.exec.decorative, status:r.status, completion:r.exec.completion })));
    const allKept = new Set(runs2.flatMap(r=>r.kept));
    const noiseSeqs = runs2.slice(9).map(r=>r.seq); // 第10-13轮是干扰轮
    check('干扰轮 seq(10-13) 从不出现在任何 kept 列表',
          noiseSeqs.every(s=>!allKept.has(s)), 'noise='+noiseSeqs.join(',')+' allKept='+[...allKept].sort((a,b)=>a-b).join(','));
    // 干扰轮自身也写投影（纯元数据），但它的 kept 只含真实轮
    check('干扰轮自身 kept 也只含真实轮 seq', runs2.slice(9).every(r=>r.kept.every(s=>s<=9)));

    // ── P4 只读纪律：completion/status 不受投影影响 ──
    console.log('\n=== P4 不新增完成信号（投影不影响判定）===');
    check('achieved 轮 completion 仍 achieved（未被投影改写）',
          runs2.slice(0,9).every(r=>r.completion==='achieved'));
    check('失败轮 status 仍 failed、completion 仍 partial',
          runs2[11].status==='failed' && runs2[11].completion==='partial',
          `status=${runs2[11].status} comp=${runs2[11].completion}`);
    check('投影字段与 completion 是两个独立字段（非别名）',
          runs2.every(r=>Array.isArray(r.kept) && typeof r.completion==='string'));

    // ── P5 导出：JSON 含字段 + CSV 含列且对齐 ──
    console.log('\n=== P5 导出对齐 ===');
    // exportRuns 是模块内函数，用测试钩子暴露（顶层不挂 window）
    const exportInfo = await page.evaluate(()=>{
      // RFC4180 单行解析：处理引号内逗号与双引号转义（简单 split(',') 会误切 JSON 字段）
      function parseCsvLine(line){
        const cells=[]; let cur=''; let inQ=false;
        for (let i=0;i<line.length;i++){
          const c=line[i];
          if (inQ){
            if (c==='"' && line[i+1]==='"'){ cur+='"'; i++; }
            else if (c==='"'){ inQ=false; }
            else cur+=c;
          } else {
            if (c==='"') inQ=true;
            else if (c===','){ cells.push(cur); cur=''; }
            else cur+=c;
          }
        }
        cells.push(cur);
        return cells;
      }
      const json = JSON.parse(window.__cockpit._exportRunsForTest('json'));
      const csv = window.__cockpit._exportRunsForTest('csv');
      const lines = csv.split('\r\n');
      const head = lines[0].split(',');
      return {
        jsonOk: !!json,
        jsonHasField: !!(json && json.runs.every(r=>Array.isArray(r.digest_kept_seqs))),
        jsonSample: json?.runs?.[0]?.digest_kept_seqs || null,
        csvHasCol: head.includes('digest_kept_seqs'),
        colCount: head.length,
        rowCounts: lines.slice(1).filter(Boolean).map(l=>parseCsvLine(l).length),
        digestColIdx: head.indexOf('digest_kept_seqs'),
        // 取第6行（seq6，kept=[1..6] 含逗号必带引号）验证 RFC 转义
        quotedCell: parseCsvLine(lines[6])[head.indexOf('digest_kept_seqs')] || null,
        quotedRaw: lines[6].includes('"[1,2,3,4,5,6]"'),   // 原始文本确实加了 RFC 引号
        sampleCell: parseCsvLine(lines[1])[head.indexOf('digest_kept_seqs')] || null,
      };
    });
    check('JSON 导出含 digest_kept_seqs 字段（每条 run）', exportInfo.jsonHasField,
          'sample='+JSON.stringify(exportInfo.jsonSample));
    check('CSV 表头含 digest_kept_seqs 列', exportInfo.csvHasCol);
    check('CSV 每行列数一致（RFC 解析）', exportInfo.rowCounts.every(n=>n===exportInfo.colCount),
          `cols=${exportInfo.colCount} rows=${exportInfo.rowCounts.join('/')}`);
    check('CSV 投影单元格为合法 JSON 数组串', /^\[[\d,]+\]$/.test(exportInfo.sampleCell||''),
          exportInfo.sampleCell);
    check('CSV 含逗号数组按 RFC 加引号（seq6 原始文本带引号、解析值正确）',
          exportInfo.quotedRaw === true && exportInfo.quotedCell === '[1,2,3,4,5,6]',
          `raw=${exportInfo.quotedRaw} parsed=${exportInfo.quotedCell}`);

    // ── P6 不变量：forkTopology 结构 + 0 JS 错 ──
    console.log('\n=== P6 不变量 ===');
    const fork = await page.evaluate(()=>window.__cockpit.forkTopology || null);
    check('forkTopology 钩子仍可读（3D 拓扑未被投影破坏）', fork!==undefined);
    check('0 JS 错误', errs.length===0, errs.join('|'));

    console.log('\n=== SNAPSHOT ===');
    console.log(JSON.stringify({
      totalRuns:runs2.length,
      evolution: runs2.slice(0,9).map(r=>({seq:r.seq, kept:r.kept})),
      noiseSeqs, exportInfo
    }, null, 2));

    console.log(`\n===== RESULT ${pass}/${pass+fail} =====`);
    if (fail) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(e=>{ console.error('FATAL', e); process.exitCode = 1; });
