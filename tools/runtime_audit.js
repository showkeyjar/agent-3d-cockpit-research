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
//   前置：原型后端 uvicorn 监听 8770（backend 目录启动），静态页 8899 可选
//   依赖：playwright-core（装在原型目录 node_modules）、Chrome 路径见下
//   命令：cd C:\Users\smith\WorkBuddy\2026-11-03-19-18-08\agent-3d-cockpit
//         NODE_PATH=.\node_modules node D:\code\ai\agent-3d-cockpit-research\tools\runtime_audit.js
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/smith/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

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

// 逐用例判定（GPT 评审：成功流式与预期降级分别断言终态、来源、有效输出）
function verdict(events, total, timedOut) {
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

  if (srcOk) {
    const outLen = (done.output || '').length;
    const outOk = tokens.length > 0 && tokenLen > 0 && outLen > 0;
    checks.push({ name: '有效输出', ok: outOk, detail: `token=${tokens.length}条/${tokenLen}字 · output=${outLen}字` });
    checks.push({ name: 'chain 归因', ok: Array.isArray(done.chain) && done.chain.length === 1 && done.chain[0] === 'output', detail: `chain=${JSON.stringify(done.chain)}` });
    const allOk = checks.every(c => c.ok);
    return { verdict: allOk ? 'PASS' : 'FAIL', checks, tokens, tokenLen, done };
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

  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:8770/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const cases = [
    { name: '3步规划链（路线B：单步真流式）', context: '帮我分析这个季度的销售数据，找出异常月份', label: '检索销售资料并分析', steps: ['检索销售相关资料', '整理分析结果', '给出异常月份结论'] },
    { name: '1步链', context: '现在需要汇总各通道数据做日报', label: '汇总各通道数据', steps: ['整理各通道数据'] },
  ];

  let pass = 0, degraded = 0, fail = 0;
  for (const c of cases) {
    console.log(`\n═══ ${c.name} ═══`);
    const { events, total, timedOut } = await runOnce(page, c);
    const v = verdict(events, total, timedOut);
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
