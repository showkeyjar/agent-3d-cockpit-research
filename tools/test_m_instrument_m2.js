/* test_m_instrument_m2.js — v0.9.43 采集工具 M2 指纹环专项验证
 * 用无头浏览器直接 file:// 打开 tools/m-instrument.html，验证：
 *   1. B / B2 组进入量表页显示 fscaleCard + fpNoticedQ
 *   2. A / C 组隐藏 fscaleCard + fpNoticedQ
 *   3. B/B2 提交必须填 s1–s7 + f1–f3 + fp_noticed（缺 f 被拦截）
 *   4. 补齐后提交成功，localStorage 记录 f1..f3/fp_noticed/arm_override 正确
 *   5. A 组提交后 f 字段为 null（缺值），不误收集
 *   6. toCSV 导出包含 f1,f2,f3,fp_noticed 四列且值对齐
 *   7. 下一位被试复位所有 radio（防残留污染 B2 对照）
 *   8. 0 JS 错误
 */
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const path = require('path');

const EXE = resolveChromePath();
const HTML = 'file:///' + path.resolve('D:/code/ai/agent-3d-cockpit-research/tools/m-instrument.html').replace(/\\/g, '/');

let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log(`  ${ok?'✅':'❌'} ${name}${extra?'  '+extra:''}`);
  ok?pass++:fail++;
};

async function newPage(browser){
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(HTML, {waitUntil:'load'});
  return {page, errs};
}

// 走到量表页：同意 → 开始 →（可选手动覆盖 arm）→ 进入量表
async function toSurvey(page, arm){
  await page.check('#consentChk');
  await page.click('#btnStart');
  if(arm) await page.click(`[data-arm="${arm}"]`);
  await page.click('#btnToSurvey');
}

async function fillRadio(page, name, value){
  // radio input 被自定义样式隐藏，点其包裹的 label（:has 选中对应 input 的那个）
  await page.click(`label:has(input[name="${name}"][value="${value}"])`);
}

(async()=>{
  const browser = await chromium.launch({ executablePath: EXE, headless:true });
  try {
    // ---- 1/2. 分组显示 ----
    for (const arm of ['B','B2','A','C']) {
      const {page, errs} = await newPage(browser);
      await page.evaluate(()=>localStorage.clear());
      await toSurvey(page, arm);
      const fCardVisible = await page.isVisible('#fscaleCard');
      const noticedVisible = await page.isVisible('#fpNoticedQ');
      const expect = (arm==='B'||arm==='B2');
      check(`${arm} 组 fscaleCard ${expect?'显示':'隐藏'}`, fCardVisible===expect);
      check(`${arm} 组 fpNoticedQ ${expect?'显示':'隐藏'}`, noticedVisible===expect);
      check(`${arm} 组 0 JS 错误`, errs.length===0, errs.join('|'));
      await page.close();
    }

    // ---- 3. B2 提交校验：缺 f 被拦截 ----
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>localStorage.clear());
      await toSurvey(page, 'B2');
      for(let i=1;i<=7;i++) await fillRadio(page, 's'+i, 5);
      // 不填 f1-f3 / fp_noticed，直接提交
      await page.click('#btnSubmit');
      const stillSurvey = await page.isVisible('#scrSurvey');
      check('B2 缺 f 题时提交被拦截（停留量表页）', stillSurvey===true);
      const stored = await page.evaluate(()=>JSON.parse(localStorage.getItem('m-exp-records')||'[]').length);
      check('B2 缺 f 题时不写入记录', stored===0);
      await page.close();
    }

    // ---- 4. B2 补齐后提交成功 + 字段正确 ----
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>localStorage.clear());
      await toSurvey(page, 'B2');
      for(let i=1;i<=7;i++) await fillRadio(page, 's'+i, 5);
      for(let i=1;i<=3;i++) await fillRadio(page, 'f'+i, 4);
      await fillRadio(page, 'fp_noticed', 0);   // B2 无环 → 没注意到
      await fillRadio(page, 'found_product', 1);
      await fillRadio(page, 'named_step', 1);
      await fillRadio(page, 'recited_evidence', 1);
      await fillRadio(page, 'took_result', 1);
      await page.click('#btnSubmit');
      const rec = await page.evaluate(()=>JSON.parse(localStorage.getItem('m-exp-records')||'[]').slice(-1)[0]);
      check('B2 提交成功（进入完成页）', await page.isVisible('#scrDone'));
      check('B2 arm_override=true', rec && rec.arm_override===true, 'arm_override='+(rec&&rec.arm_override));
      check('B2 f1/f2/f3 已存', rec && rec.f1===4 && rec.f2===4 && rec.f3===4, `f=${rec&&rec.f1}/${rec&&rec.f2}/${rec&&rec.f3}`);
      check('B2 fp_noticed=0（没注意到环）', rec && rec.fp_noticed===0, 'fp_noticed='+(rec&&rec.fp_noticed));
      check('B2 prototype_ver=v0.9.43', rec && rec.prototype_ver==='v0.9.43', 'ver='+(rec&&rec.prototype_ver));

      // ---- 7. 下一位复位 radio + 屏幕切换 ----
      await page.click('#btnNext');
      const anyChecked = await page.evaluate(()=>Array.from(document.querySelectorAll('input[type=radio]:checked')).length);
      check('下一位被试所有 radio 已复位', anyChecked===0, 'checked='+anyChecked);
      const backToConsent = await page.evaluate(()=>!document.getElementById('scrConsent').classList.contains('hidden'));
      check('下一位返回知情同意页（reset 无 TypeError）', backToConsent, 'consentVisible='+backToConsent);
      await page.close();
    }

    // ---- 5. A 组提交 f 为 null ----
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>localStorage.clear());
      await toSurvey(page, 'A');
      for(let i=1;i<=7;i++) await fillRadio(page, 's'+i, 6);
      await fillRadio(page, 'found_product', 0);
      await fillRadio(page, 'named_step', 0);
      await fillRadio(page, 'recited_evidence', 0);
      await fillRadio(page, 'took_result', 0);
      await page.click('#btnSubmit');
      const rec = await page.evaluate(()=>JSON.parse(localStorage.getItem('m-exp-records')||'[]').slice(-1)[0]);
      check('A 组提交成功', await page.isVisible('#scrDone'));
      check('A 组 f1/f2/f3/fp_noticed 均为 null', rec && rec.f1===null && rec.f2===null && rec.f3===null && rec.fp_noticed===null,
        `f=${rec&&rec.f1}/${rec&&rec.f2}/${rec&&rec.f3} fp=${rec&&rec.fp_noticed}`);
      await page.close();
    }

    // ---- 6. CSV 含新列且对齐 ----
    {
      const {page} = await newPage(browser);
      await page.evaluate(()=>localStorage.clear());
      // 直接注入两条记录（B 有 f 值、A f 为 null），CSV 导出逻辑独立于表单流程
      await page.evaluate(()=>{
        const base = {task_type:'draft', s1:5,s2:5,s3:5,s4:5,s5:5,s6:5,s7:5,
          found_product:1,named_step:1,recited_evidence:1,took_result:1,
          think_aloud:'',interview_note:'',notes:'',prototype_ver:'v0.9.43',ts:new Date().toISOString()};
        localStorage.setItem('m-exp-records', JSON.stringify([
          {...base, pid:'PB1', arm:'B', arm_override:true, f1:6,f2:6,f3:6, fp_noticed:1},
          {...base, pid:'PA1', arm:'A', arm_override:false, f1:null,f2:null,f3:null, fp_noticed:null}
        ]));
      });
      // 调用页面内 toCSV（顶层 function 声明挂 window）
      const csv = await page.evaluate(()=>{
        return window.toCSV ? window.toCSV(JSON.parse(localStorage.getItem('m-exp-records')||'[]')) : null;
      });
      if(csv===null){
        // 兜底：从按钮触发的 Blob 读取
        check('toCSV 可从全局访问', false, '顶层 function 未挂 window，改用下载拦截');
      } else {
        const header = csv.replace(/^\uFEFF/,'').split('\n')[0].split(',');
        check('CSV 头含 f1', header.includes('f1'));
        check('CSV 头含 f2', header.includes('f2'));
        check('CSV 头含 f3', header.includes('f3'));
        check('CSV 头含 fp_noticed', header.includes('fp_noticed'));
        const lines = csv.trim().split('\n');
        check('CSV 行数=3（表头+2条）', lines.length===3, 'lines='+lines.length);
        const bLine = lines[1].split(','), aLine = lines[2].split(',');
        const iF1 = header.indexOf('f1'), iFp = header.indexOf('fp_noticed');
        check('CSV B 条 f1=6 对齐', bLine[iF1]==='6', 'f1='+bLine[iF1]);
        check('CSV A 条 f1 留空（缺值）', aLine[iF1]==='', 'f1=['+aLine[iF1]+']');
        check('CSV B 条 fp_noticed=1 对齐', bLine[iFp]==='1', 'fp='+bLine[iFp]);
      }
      await page.close();
    }

  } catch(e){
    check('脚本执行无异常', false, String(e));
  } finally {
    await browser.close();
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail?1:0);
})();
