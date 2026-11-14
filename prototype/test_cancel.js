const { resolveChromePath } = require('./chrome_helper');
/* test_cancel.js — v0.9.16 停止生成（P0 剩余项）
 *
 * 验证目标（P1 真实性 / P3 可追溯 / P4 可感知）：
 *   A. 执行期出现「停止生成」入口（推演等待期不出现），Esc 等价
 *   B. 点击真的发 WS cancel；连点不重复发；pending 态有反馈
 *   C. 中断回包 = 第三态：不发完成、不铺到达牌、不推进主轴、不写轨迹
 *   D. 中断卡如实交代：部分文本、耗时/字数/执行链、stop 任务条、可重新执行
 *   E. cancel_ack(active=false) / 后端未连接 / 后端无回包 三条边界都不静默挂起
 *   F. 正常完成与澄清态不受污染；3D 空间不变量不动；0 JS 错误
 *
 * 纯前端 + WS 桩，不依赖 35B 单槽，秒级完成（仅兜底一例等 6s）。
 */
const { chromium } = require('playwright-core');
const EXE = resolveChromePath();
const URL = 'http://127.0.0.1:8770/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const CANDS = [
  { label: '先查资料', sub: '避免瞎编', steps: ['检索', '整理'], rationale: '有依据', color: '#34f5a0', pos3d: [3, 0, 2] },
  { label: '梳理政策', sub: '外部环境', steps: ['检索', '对比'], rationale: '贴合主题', color: '#ffb13d', pos3d: [-2, 0, -3] },
  { label: '对比数据', sub: '横向参照', steps: ['取数', '对比'], rationale: '可核对', color: '#5ee0ff', pos3d: [2, 0, -4] },
];
const BASE = {
  type: 'forecast_result', divergence: 0.4721, road_type: 'fork', execution_mode: 'choice',
  clusters: [[0, 1], [2]], candidates: CANDS, cost_ms: 14520.4, fork_count: 2, source: 'local',
};
const PARTIAL = '国内电力交易市场目前以省级现货市场与中长期交易并行，';
const DONE_INTERRUPTED = {
  type: 'execute_done', ok: false, interrupted: true,
  reason: 'user_cancelled', note: '已由用户中断', output: PARTIAL,
  tasks: [{ name: '输出生成', status: 'stop', progress: 0.42,
           sub: '已由用户中断（未完成）', color: '#5ee0ff', anchor: 4 }],
  chain: ['output'], source: 'llm', tokens: 18, elapsed_ms: 1840,
  label: '先查资料', planned_steps: ['检索', '整理'],
};

async function newPage(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit.stopBtnState !== undefined, { timeout: 20000 });
  await sleep(350);
  await page.evaluate(m => {
    window.__cockpit._stubWs(true);
    window.__cockpit._applyForecast(m);
  }, BASE);
  await sleep(250);
  return page;
}

const snap = page => page.evaluate(() => {
  const c = document.getElementById('resultCard');
  const ib = document.getElementById('rcInterruptBar');
  return {
    stopVisible: window.__cockpit.stopBtnVisible,
    stopState: window.__cockpit.stopBtnState,
    stopDisabled: document.getElementById('stopGenBtn').disabled,
    stopText: document.getElementById('stopGenBtn').textContent,
    exec: window.__cockpit.execState,
    wsLog: window.__cockpit.wsLog.map(x => x.type),
    cardShown: c.classList.contains('show'),
    cardInterrupted: c.classList.contains('interrupted'),
    cardFail: c.classList.contains('fail'),
    cardClarify: c.classList.contains('clarify'),
    title: document.getElementById('rcTitle').textContent,
    badge: document.getElementById('rcBadge').textContent,
    subtitle: document.getElementById('rcSubtitle').textContent,
    output: document.getElementById('rcOutput').textContent,
    source: document.getElementById('rcSource').textContent,
    proof: document.getElementById('rcProof').textContent,
    proofVisible: window.__cockpit.resultProofVisible,
    interruptBar: ib.textContent,
    interruptBarVisible: ib.style.display === 'block',
    interactVisible: document.getElementById('rcInteract').style.display !== 'none',
    note: document.getElementById('rcNote').textContent,
    actions: [...document.querySelectorAll('#rcActions button')].map(b => b.textContent),
    steps: [...document.querySelectorAll('#rcSteps li')].map(li => li.textContent),
    summary: window.__cockpit.taskBarSummary,
    toast: document.getElementById('toast').textContent,
    signIds: window.__cockpit._signIds(),
    camOffRail: window.__cockpit.camOffRail,
    inputDisabled: document.getElementById('msgInput').disabled,
  };
});

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  const errors = [];

  // ───────── A/B/C/D：完整中断链路 ─────────
  console.log('\n=== A. 执行期才出现停止入口 ===');
  let page = await newPage(browser, errors);
  let posts = 0;
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().includes('/api/journeys')) posts++;
  });
  let s = await snap(page);
  check('A1 空闲/推演期按钮隐藏', s.stopVisible === false, `state=${s.stopState}`);

  await page.evaluate(() => window.__cockpit._beginExec(0));
  s = await snap(page);
  check('A2 执行期按钮出现且为 ready', s.stopVisible && s.stopState === 'ready' && !s.stopDisabled,
    `visible=${s.stopVisible} state=${s.stopState}`);
  check('A3 执行态 done=false', s.exec.done === false && s.exec.idx === 0, JSON.stringify(s.exec));

  console.log('\n=== B. 点击真的发 cancel ===');
  await page.evaluate(() => {
    window.__cockpit._injectWs({type:'token', text:'国内电力交易市场目前以省级现货市场与'});
    document.getElementById('stopGenBtn').click();
  });
  s = await snap(page);
  check('B1 出站消息含 type=cancel', s.wsLog[s.wsLog.length - 1] === 'cancel', s.wsLog.join(','));
  check('B2 pending 态：禁用 + 文案「正在停止…」',
    s.stopState === 'pending' && s.stopDisabled && s.stopText.includes('正在停止'),
    `state=${s.stopState} disabled=${s.stopDisabled} text=${s.stopText}`);
  const n1 = s.wsLog.length;
  await page.evaluate(() => window.__cockpit._stopGen());
  const n2 = (await page.evaluate(() => window.__cockpit.wsLog.length));
  check('B3 连点不重复发 cancel', n2 === n1, `before=${n1} after=${n2}`);

  console.log('\n=== C. 中断回包：不发完成、不铺牌、不写轨迹 ===');
  await page.evaluate(d => window.__cockpit._injectWs(d), DONE_INTERRUPTED);
  await sleep(120);
  s = await snap(page);
  check('C1 执行态解锁', s.exec.done === true && s.exec.idx === -1, JSON.stringify(s.exec));
  check('C2 停止按钮复位隐藏', !s.stopVisible && s.stopState === 'hidden', `state=${s.stopState}`);
  check('C3 结果卡是 interrupted 第三态（非 fail、非 clarify）',
    s.cardShown && s.cardInterrupted && !s.cardFail && !s.cardClarify,
    `shown=${s.cardShown} interrupted=${s.cardInterrupted} fail=${s.cardFail}`);
  check('C4 标题/徽章如实写「已由用户中断」',
    s.title === '已由用户中断' && s.badge === '‖', `title=${s.title} badge=${s.badge}`);
  check('C5 无「已完成」路牌', !s.signIds.includes(-2), JSON.stringify(s.signIds));
  check('C6 未推进下一方向（无未来牌）',
    !s.signIds.some(id => typeof id === 'number' && id <= -3), JSON.stringify(s.signIds));
  check('C7 未写完成轨迹（POST /api/journeys = 0）', posts === 0, `posts=${posts}`);
  check('C8 输入区恢复可用', s.inputDisabled === false);
  check('C9 toast 明确「未记入完成轨迹」', s.toast.includes('未记入完成轨迹'), s.toast);

  console.log('\n=== D. 中断卡：部分文本 + 凭据 + 可继续操作 ===');
  check('D1 保留中断前真实部分文本并标注未完成',
    s.output.includes(PARTIAL) && s.output.includes('未完成') && s.source.includes('部分输出'),
    `source=${s.source}`);
  check('D2 中断凭据含来源原因/耗时/字数/执行链',
    s.proofVisible && s.proof.includes('中断凭据') && s.proof.includes('未执行完成')
      && s.proof.includes('user_cancelled') && s.proof.includes('1.8s')
      && s.proof.includes('18 tokens') && s.proof.includes('output'),
    s.proof.slice(0, 160));
  check('D3 中断说明条可见且写明三件不做的事',
    s.interruptBarVisible && s.interruptBar.includes('不生成') && s.interruptBar.includes('不推进')
      && s.interruptBar.includes('不会记入完成轨迹'), s.interruptBar.slice(0, 80));
  check('D4 无到达牌联动提示（结果面板互动区隐藏）', s.interactVisible === false);
  check('D5 任务条如实标 stop，不打勾',
    s.steps.length > 0 && s.steps[0].includes('‖') && s.steps[0].includes('未完成'),
    JSON.stringify(s.steps));
  check('D6 折叠摘要写「已由用户中断，未完成」', s.summary.includes('已由用户中断，未完成'), s.summary);
  check('D7 动作区有「重新执行这一步」，无完成态「回退一步」',
    s.actions.includes('重新执行这一步') && !s.actions.includes('回退一步'), JSON.stringify(s.actions));
  check('D8 机位未被中断动作移动（camOffRail≈0）', s.camOffRail < 0.001, `camOffRail=${s.camOffRail}`);
  check('D9 note 不冒充模型失败', !s.note.includes('模型未返回') && !s.note.includes('没有产生成果'), s.note);

  // 点「重新执行这一步」→ 应重新进入执行态，且真的发出 execute
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#rcActions button')].find(x => x.textContent.includes('重新执行'));
    if (b) b.click();
  });
  await sleep(150);
  s = await snap(page);
  check('D10 中断后可重新执行（卡片收起、按钮回来、发出 execute）',
    !s.cardShown && s.stopVisible && s.stopState === 'ready' && s.exec.done === false
      && s.wsLog[s.wsLog.length - 1] === 'execute',
    `shown=${s.cardShown} state=${s.stopState} last=${s.wsLog[s.wsLog.length-1]}`);
  await page.evaluate(() => window.__cockpit._injectWs({type:'execute_done', ok:false, interrupted:true,
    reason:'user_cancelled', note:'已由用户中断', output:'', tasks:[], chain:['output'],
    source:'local', tokens:0, elapsed_ms:200, label:'先查资料'}));
  await page.close();

  // ───────── E：三条边界 ─────────
  console.log('\n=== E. cancel_ack / 后端未连接 / 无回包 ===');
  page = await newPage(browser, errors);
  await page.evaluate(() => window.__cockpit._beginExec(0));
  await page.evaluate(() => window.__cockpit._stopGen());
  await page.evaluate(() => window.__cockpit._injectWs({type:'cancel_ack', active:false}));
  s = await snap(page);
  check('E1 cancel_ack(active=false) 从 pending 回 ready，不卡「正在停止…」',
    s.stopState === 'ready' && !s.stopDisabled, `state=${s.stopState}`);
  await page.evaluate(() => window.__cockpit._injectWs({type:'execute_done', ok:false, interrupted:true,
    reason:'user_cancelled', note:'已由用户中断', output:'', tasks:[], chain:['output'],
    source:'local', tokens:0, elapsed_ms:200, label:'先查资料'}));

  await page.evaluate(() => {
    window.__cockpit._dropWs();
    window.__cockpit._beginExec(0);
    window.__cockpit._stopGen();
  });
  await sleep(120);
  s = await snap(page);
  check('E2 后端未连接：立即如实收尾，不等回包',
    s.exec.done === true && s.cardInterrupted && s.proof.includes('cancel_no_backend')
      && s.note.includes('后端未连接'), `proof=${s.proof.slice(0,90)} note=${s.note}`);

  await page.evaluate(() => {
    window.__cockpit._stubWs(true);
    window.__cockpit._beginExec(0);
    window.__cockpit._stopGen();
  });
  await sleep(6300);   // 6s 本地兜底：不注入任何回包
  s = await snap(page);
  check('E3 6s 未收到后端确认：本地如实收尾，不静默挂起',
    s.exec.done === true && s.cardInterrupted && s.proof.includes('cancel_unconfirmed')
      && !s.stopVisible, `state=${s.stopState} proof=${s.proof.slice(0,90)}`);
  await page.close();

  // ───────── F：其它结果态不受污染 + Esc + 不变量 ─────────
  console.log('\n=== F. 回归：Esc、澄清态、3D 不变量 ===');
  page = await newPage(browser, errors);
  await page.evaluate(() => window.__cockpit._beginExec(0));
  await page.keyboard.press('Escape');
  s = await snap(page);
  check('F1 Esc 与按钮等价（发出 cancel）', s.wsLog[s.wsLog.length - 1] === 'cancel', s.wsLog.join(','));

  await page.evaluate(() => window.__cockpit._injectWs({
    type:'execute_done', ok:true, clarify:true, question:'请补充省份',
    output:'', tasks:[], chain:['clarify'], source:'llm', tokens:6,
    elapsed_ms:900, label:'先查资料', interrupted:false,
  }));
  await page.waitForFunction(() => window.__cockpit.resultCardOpen, { timeout: 15000 }).catch(() => {});
  await sleep(900);   // 等 driveTo 行驶插值彻底收敛，再量机位偏离
  s = await snap(page);
  check('F2 澄清卡不带 interrupted/fail 样式，中断说明条复位',
    !s.cardInterrupted && !s.cardFail && !s.interruptBarVisible && !s.interruptBar,
    `interrupted=${s.cardInterrupted} fail=${s.cardFail} ib=${s.interruptBarVisible}`);
  check('F3 停止按钮在任何收尾后都隐藏', !s.stopVisible && s.stopState === 'hidden');
  // 行驶插值收敛后机位恒在路面中心线上方；0.02m 远小于历史 bug 的 0.162m 漂移
  check('F4 camOffRail 仍≈0（3D 空间不变量未回退）', s.camOffRail < 0.02, `camOffRail=${s.camOffRail}`);
  check('F5 0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();

  await browser.close();
  console.log(`\n=== test_cancel.js: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
