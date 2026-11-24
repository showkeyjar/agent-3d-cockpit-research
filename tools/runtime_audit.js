// 运行时实证：路线 B 验收审计（v2，2026-11-11 GPT 评审修订版）
//
// 静态审计（AUDIT.md）读出 sleep 模拟 + prompt 死参数；本脚本给它运行时证据：
//   - 浏览器内建独立 WebSocket 直连后端
//   - 发送 type=execute（正常用户点击「走向这条路」同格式）
//   - 用 performance.now() 给每条事件打高精度时间戳
//
// ★ v2 修订（2026-11-11，回应 GPT 评审 Finding 2）：
//   旧版缺陷：① 失败用例（超时/断线/意外降级）也打印 DONE 并 exit 0；
//             ② 间隔严格度 (max-min)/min 在 min=0 时输出 Infinity%；
//             ③ 只有全间隔统计，未按事件类型分桶。
//   修订：
//   ① 每个用例独立判定 verdict：
//        PASS     = 收到 execute_done 且 source=llm 且 token 事件>0 且 output 非空
//        DEGRADED = 收到 execute_done 且 source=local 且 reason ∈ {model_busy, llm_disabled, llm_failed}
//                   （预期降级：诚实但未产出，不计入验收通过）
//        FAIL     = 无 execute_done（超时/断线）、source=local 且 reason 意外、
//                   source=llm 但 output 为空、ok=false
//   ② 退出码：0=全部 PASS；2=有 DEGRADED 无 FAIL；1=有 FAIL
//   ③ 间隔统计按事件类型分桶（token / task_update），严格度改用
//      (p90-p10)/中位，min=0 不再产生 Infinity%
//   ④ 启动前健康检查 8770/api/health，失败则快速报错退出
//
// 复跑说明（GPT 评审要求写明）：
//   前置：原型后端 uvicorn 监听 8770（backend 目录启动），静态页由 8770 同源提供
//   依赖：playwright-core（装在 prototype/node_modules）；Chrome 路径经 prototype/chrome_helper.js 解析
//   命令：cd <仓库根>
//         NODE_PATH=prototype/node_modules node tools/runtime_audit.js
const { chromium } = require('playwright-core');
const { resolveChromePath } = require('../prototype/chrome_helper');

const EXPECTED_DEGRADE_REASONS = new Set(['model_busy', 'llm_disabled', 'llm_failed']);

async function healthCheck() {
  try {
    const r = await fetch('http://127.0.0.1:8770/api/health');
    const j = await r.json();
    if (j.status !== 'ok') throw new Error('health.status=' + j.status);
    console.log(`[健康检查] 8770 ok · llm=${j.llm_url} · exec_use_llm=${j.exec_use_llm}`);
    return true;
  } catch (e) {
    console.error(`[健康检查] 8770 不可用: ${e.message}`);
    console.error('  前置：uvicorn server:app --port 8770（backend 目录）');
    return false;
  }
}

async function runOnce(page, args) {
  const res = await page.evaluate(async (args) => {
    const events = [];
    const t0 = performance.now();
    const ws = new WebSocket('ws://localhost:8770/ws');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (ws.readyState < 2) ws.close(); }, 45000);
    await new Promise((resolve) => {
      const finish = () => resolve();
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'execute',
          context: args.context,
          label: args.label,
          candidate: 0,
          mode: 'auto',
          steps: args.steps,
        }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        events.push({
          t: Math.round(performance.now() - t0),
          type: msg.type,
          tag: msg.title || msg.msg || msg.phase || msg.label || msg.note || '',
          text: msg.text || '',
          steps: msg.steps || [],
          chain: msg.chain,
          source: msg.source,
          reason: msg.reason,
          ok: msg.ok,
          output: msg.output || '',
          // GPT 评审 #4：缺数据澄清终态需要这些字段才能正确判定
          clarify: msg.clarify,
          question: msg.question || '',
        });
        if (msg.type === 'execute_done') finish();
      };
      ws.onerror = () => finish();
      ws.onclose = () => finish();
    });
    clearTimeout(timer);
    try { ws.close(); } catch (e) {}
    return { events, total: Math.round(performance.now() - t0), timedOut };
  }, args);
  return res;
}

// 间隔分布：按事件类型分桶，严格度 = (p90-p10)/中位（min=0 安全）
function gapStats(times, name) {
  if (times.length < 2) { console.log(`  [${name}] 间隔不足（n=${times.length}）`); return; }
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const spread = median > 0 ? ((p90 - p10) / median * 100).toFixed(0) : 'n/a';
  console.log(`  [${name}] 间隔(ms): n=${gaps.length} min=${sorted[0]} 中位=${median} 均值=${Math.round(mean)} max=${sorted[sorted.length - 1]} 散布(p90-p10)/中位=${spread}%`);
}

// 逐用例判定（GPT 评审 #4：按 task_kind 与数据齐备度分三类预期终态，避免正确行为触发误报）
//   expect='output'   —— 起草成功 / 给定数据分析：应有有效输出、chain=['output']
//   expect='clarify'  —— 缺数据：应索要输入、chain=['clarify']、clarify=true（这是正确行为，非失败）
//   expect='auto'     —— 让终态自行决定（兼容旧行为）：output 或 clarify 任一成立即可
function verdict(events, total, timedOut, expect) {
  expect = expect || 'auto';
  const done = events.find(e => e.type === 'execute_done');
  const tokens = events.filter(e => e.type === 'token');
  const tokenLen = tokens.reduce((a, e) => a + (e.text || '').length, 0);
  const checks = [];

  if (timedOut || !done) {
    checks.push({ name: 'execute_done', ok: false, detail: timedOut ? '45s 超时无终态' : '未收到终态事件' });
    return { verdict: 'FAIL', checks, tokens, tokenLen, done: null };
  }
  checks.push({ name: 'execute_done', ok: true, detail: `+${done.t}ms ok=${done.ok}` });

  const srcOk = done.source === 'llm';
  checks.push({ name: 'source=llm', ok: srcOk, detail: `source=${done.source} reason=${done.reason || '(空)'}` });

  // 缺数据澄清（GPT 评审 #4）：正确行为有两种呈现——
  //   ① 结构化标志：chain=['clarify'] + clarify=true；
  //   ② 文本语义：模型把"需要输入/请提供…"写进 output，但 chain 仍是 ['output']（小模型常见）。
  //   两者都是"诚实索要输入"，都不该因"没有成果正文"误判 FAIL。
  const flagClarify = Array.isArray(done.chain) && done.chain[0] === 'clarify' && done.clarify === true;
  const textClarify = /(需要输入|请提供|请补充|缺少|需要提供|无法.{0,6}(分析|判断)|请给出)/.test(done.output || '') ||
                      /(需要输入|请提供|请补充|缺少|请给出)/.test(done.question || '');
  const isClarify = flagClarify || textClarify;
  if (expect === 'clarify' || (expect === 'auto' && isClarify && !srcOk)) {
    const qText = done.question || done.output || '';
    checks.push({ name: '缺数据澄清（预期终态）', ok: isClarify,
      detail: `chain=${JSON.stringify(done.chain)} clarify=${done.clarify} 文本判定=${textClarify}` });
    checks.push({ name: '索要输入文本', ok: qText.length > 0, detail: `question/output=${qText.length}字: ${qText.slice(0,40)}` });
    const allOk = checks.filter(c => c.name !== 'source=llm').every(c => c.ok);  // clarify 不强求 llm
    return { verdict: allOk ? 'PASS' : 'FAIL', checks, tokens, tokenLen, done, kind: 'clarify' };
  }

  if (srcOk) {
    const outLen = (done.output || '').length;
    const outOk = tokens.length > 0 && tokenLen > 0 && outLen > 0;
    checks.push({ name: '有效输出', ok: outOk, detail: `token=${tokens.length}条/${tokenLen}字 · output=${outLen}字` });
    checks.push({ name: 'chain 归因', ok: Array.isArray(done.chain) && done.chain.length === 1 && done.chain[0] === 'output', detail: `chain=${JSON.stringify(done.chain)}` });
    if (expect === 'clarify'){   // 预期澄清却给了输出：算失败（判定预期设错或行为异常）
      checks.push({ name: '预期澄清却产出结果', ok: false, detail: 'expect=clarify 但 chain=output' });
    }
    const allOk = checks.every(c => c.ok);
    return { verdict: allOk ? 'PASS' : 'FAIL', checks, tokens, tokenLen, done, kind: 'output' };
  }

  // source=local：预期降级（诚实）vs 意外降级（失败）
  const degradeOk = EXPECTED_DEGRADE_REASONS.has(done.reason);
  checks.push({ name: '预期降级原因', ok: degradeOk, detail: `reason=${done.reason || '(空)'} note=${(done.note || '').slice(0, 30)}` });
  return { verdict: degradeOk ? 'DEGRADED' : 'FAIL', checks, tokens, tokenLen, done };
}

function reportRouteB(events, total, v) {
  const taskUpdates = events.filter(e => e.type === 'task_update');
  const tokenTimes = v.tokens.map(e => e.t);
  console.log(`  [路线B] task_update=${taskUpdates.length} 条 · token=${v.tokens.length} 条（${v.tokenLen} 字）· 总耗时 ${total}ms`);
  if (v.tokens.length) {
    const cover = ((v.tokens[v.tokens.length - 1].t - v.tokens[0].t) / total * 100).toFixed(0);
    console.log(`  [路线B] token 流覆盖 ${cover}% 执行时长（首 token +${v.tokens[0].t}ms）`);
  }
  gapStats(tokenTimes, 'token 间隔');
  gapStats(taskUpdates.map(e => e.t), 'task_update 间隔');
  console.log(`  [判定] ${v.verdict}`);
  for (const c of v.checks) {
    console.log(`    ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }
}

async function main() {
  if (!(await healthCheck())) process.exit(1);

  const browser = await chromium.launch({ headless: true, executablePath: resolveChromePath() });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:8770/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  // GPT 评审 #4：三类预期终态分开断言——缺数据=clarify，给定数据=output。
  const cases = [
    // 缺业务数据 → 正确行为是索要输入（clarify），不再因"没有成果正文"误判 FAIL。
    { name: '缺数据分析（预期：澄清索输入）', expect: 'clarify',
      context: '帮我分析这个季度的销售数据，找出异常月份', label: '检索销售资料并分析', steps: ['检索销售相关资料', '整理分析结果', '给出异常月份结论'] },
    // 内嵌真实数据 → 预期产出结果（output）。覆盖"给定数据分析"终态。
    { name: '给定数据汇总（预期：产出结果）', expect: 'output',
      context: '以下是各通道本日数据：A通道 120/115/130万，B通道 88/91/79万，C通道 45/47/50万。请汇总成日报并指出异常。',
      label: '汇总各通道数据', steps: ['整理各通道数据', '生成日报'] },
  ];

  let pass = 0, degraded = 0, fail = 0;
  for (const c of cases) {
    console.log(`\n═══ ${c.name}（预期终态 ${c.expect}）═══`);
    const { events, total, timedOut } = await runOnce(page, c);
    const v = verdict(events, total, timedOut, c.expect);
    console.log(`事件序列（共 ${events.length} 条，总耗时 ${total}ms）:`);
    for (const ev of events) {
      const meta = ev.steps ? ` steps=${JSON.stringify(ev.steps)}` : '';
      const txt = ev.text ? ` text="${ev.text.slice(0, 18)}…"` : '';
      const done = ev.type === 'execute_done' ? ` source=${ev.source} reason=${ev.reason || '-'} chain=${JSON.stringify(ev.chain)}` : '';
      console.log(`  +${String(ev.t).padStart(6)}ms  ${ev.type.padEnd(13)} ${String(ev.tag).slice(0, 24)}${txt}${meta}${done}`);
    }
    reportRouteB(events, total, v);
    if (v.verdict === 'PASS') pass++;
    else if (v.verdict === 'DEGRADED') degraded++;
    else fail++;
  }

  await browser.close();
  console.log(`\n═══ 汇总 ═══ PASS=${pass} DEGRADED=${degraded} FAIL=${fail}`);
  if (fail > 0) {
    console.log('RESULT: FAIL（存在失败用例：超时/断线/意外降级）');
    process.exit(1);
  }
  if (degraded > 0) {
    console.log('RESULT: DEGRADED（预期降级用例未产出，验收证据不完整，不计通过）');
    process.exit(2);
  }
  console.log('RESULT: PASS（全部用例通过路线 B 验收）');
  process.exit(0);
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
