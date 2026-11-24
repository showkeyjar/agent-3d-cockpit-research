/* test_mindmap_export.js — v0.9.56 · 思考地图导出回归
 *
 * 研究定位落点（docs/RESEARCH-STATEMENT.zh.md「定位补记 2026-11-24」）：
 *   可视化 = 思考辅助 / 想象力激发 / 思维导图生成。
 *   本测试只验证「已有语义树 + 账本能导出为可编辑结构」这一装置事实。
 *   ★ 不验证「用户思考因此更好」——那属 [真人] 待验，不得由本测试转正。
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
    await page.waitForFunction(()=>window.__cockpit && window.__cockpit.exportMindmapForTest, null, {timeout:20000});

    console.log('\n=== A. 空状态：诚实不导出 ===');
    const empty = await page.evaluate(()=>window.__cockpit.exportMindmapForTest());
    check('无候选/账本/事件时返回空', empty==='', 'len='+empty.length);
    check('导出按钮在面板里', await page.evaluate(()=>window.__cockpit.mindmapButtonPresent));

    console.log('\n=== B. 注入语义树 + 真实账本 ===');
    await page.evaluate(()=>{
      window.__cockpit._applyForecast({
        type:'forecast_result', source:'llm', road_type:'fork', divergence:0.62,
        execution_mode:'choice', fork_count:2, cost_ms:120,
        clusters:[[0,1],[2],[3,4]],
        candidates:['检索资料','拆解误差','对照方案','核算载量','落地建议'].map((label,i)=>({
          label, sub:'围绕风电预测的深入方向', steps:['先取数','再比对'],
          rationale:'方向'+i+'的研究理由', color:'#5ee0ff', modality:'text',
          pos3d:[(i-2)*2.2,(i%2)*1.5,(i-2)*0.8],
        })),
      });
    });
    for (let i=1;i<=8;i++){
      await page.evaluate(k=>window.__cockpit._injectExecuteDoneForTest({
        ok:true, source:'llm', output:`第${k}轮真实结论：导出回归-${k}`, completion:'achieved',
        tasks:[], chain:[] }), i);
    }
    const before = await page.evaluate(()=>window.__cockpit.runs);
    const md = await page.evaluate(()=>window.__cockpit.exportMindmapForTest());
    const after = await page.evaluate(()=>window.__cockpit.runs);

    check('导出文本非空', md.length>300, 'len='+md.length);
    check('有标题与版本', md.includes('# 思考地图') && md.includes('v0.9.56'));
    check('有 Mermaid 脑图块', md.includes('```mermaid') && md.includes('mindmap') && md.includes('root(('));
    check('代码围栏成对', (md.match(/```/g)||[]).length===2, 'fences='+(md.match(/```/g)||[]).length);
    check('有可编辑大纲与轮次轨迹', md.includes('## 大纲（可编辑）') && md.includes('## 轮次轨迹（账本投影）'));

    const fence = md.slice(md.indexOf('```mermaid'), md.indexOf('```', md.indexOf('```mermaid')+3));
    check('脑图块含 3 个簇', (fence.match(/簇 /g)||[]).length===3, 'clusters='+(fence.match(/簇 /g)||[]).length);
    check('脑图块含 5 个候选', ['检索资料','拆解误差','对照方案','核算载量','落地建议']
      .every(l=>fence.includes(l)));
    check('脑图标签已净化（无未转义方括号）', !/\[|\]/.test(fence));
    check('大纲含候选理由与做法', md.includes('研究理由') && md.includes('先取数 / 再比对'));

    console.log('\n=== C. 视野投影进导出，纯只读 ===');
    check('导出含视野内/已掉出投影', md.includes('视野内') && md.includes('已掉出'));
    check('导出含 Q-d 视野边界说明', md.includes('digest_kept_seqs'));
    check('诚实边界文字在文件里', md.includes('不新增完成信号') && md.includes('【真人】待验'));
    check('导出不改账本轮数', before.length===after.length && after.length===8, 'n='+after.length);
    check('导出不改账本字段', JSON.stringify(before)===JSON.stringify(after));

    console.log('\n=== D. 特殊字符候选不破坏脑图 ===');
    await page.evaluate(()=>{
      window.__cockpit._applyForecast({
        type:'forecast_result', source:'local', road_type:'fork', divergence:0.3,
        execution_mode:'choice', fork_count:1, candidates:[
          { label:'含[括号]与"引号"的方向', steps:[], rationale:'', color:'#5ee0ff' },
        ],
      });
    });
    const md2 = await page.evaluate(()=>window.__cockpit.exportMindmapForTest());
    const fence2 = md2.slice(md2.indexOf('```mermaid'), md2.indexOf('```', md2.indexOf('```mermaid')+3));
    check('特殊字符已被净化', !/\[|\]|"|'/.test(fence2), fence2.split('\n').slice(-3).join(' | '));
    check('净化后仍有候选节点', fence2.includes('含括号与引号的方向'));

    check('全程 0 JS 错误', errs.length===0, errs.join('|'));
  } catch(e){
    check('脚本执行无异常', false, String(e));
  } finally {
    await browser.close();
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail?1:0);
})();
