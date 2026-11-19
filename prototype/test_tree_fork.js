/* v0.9.38 · 语义树状分叉回归
   ① 后端 clusters 真正进入 3D 几何：共干 → 簇分叉 → 候选细枝（不是一点放射扇形）
   ② pos3d 语义距离决定终点半径/弧度/高度：非等半径、非单调斜线、同簇近异簇远
   ③ 不破坏既有契约：牌高偏移 +2.7、拾取、虚线熄灭、轨道机位、路管亮度下限
   ④ clusters 缺失时逐候选成簇，拓扑仍成立
*/
const { resolveChromePath } = require('./chrome_helper');
const { chromium } = require('playwright-core');
const CHROME = resolveChromePath();

const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const ang = p => Math.atan2(p[2], p[0]);
const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__cockpit && window.__cockpit._applyForecast,
                             null, { timeout: 20000 });

  const inject = (clusters, divergence) => page.evaluate(({ clusters, divergence }) => {
    const palette = ['#5ee0ff', '#ff5fe0', '#ffd23f', '#34f5a0', '#ff8a4c'];
    const labels = ['检索资料', '拆解误差', '对照方案', '核算载量', '落地建议'];
    const candidates = labels.map((label, i) => ({
      label, sub: '围绕风电预测的深入方向', steps: ['a','b','c'], rationale: 'r',
      color: palette[i], modality: 'text',
      pos3d: [(i-2)*2.2, (i % 2) * 1.5, (i-2)*0.8],
    }));
    window.__cockpit._applyForecast({
      type:'forecast_result', source:'llm', road_type:'fork', divergence,
      execution_mode:'choice', fork_count:2, cost_ms:120,
      clusters, candidates,
    });
  }, { clusters, divergence });

  await inject([[0,1],[2],[3,4]], 0.62);
  await page.waitForTimeout(3500);

  const s = await page.evaluate(() => {
    const c = window.__cockpit;
    return {
      topo: c.forkTopology,
      pos: c.positions.map(p => p.slice()),
      tubes: c.roadTubes,
      offRail: c.camOffRail,
      signs: c.signs.filter(x => x.userData.branchId >= 0)
              .map(x => ({ id:x.userData.branchId, x:x.position.x, y:x.position.y, z:x.position.z })),
    };
  });
  const byKind = k => s.topo.filter(x => x.kind === k);
  const trunk = byKind('trunk'), groups = byKind('group'), junctions = byKind('junction');
  const twigs = byKind('twig'), dashes = byKind('dash');
  const trunkEnd = trunk[0]?.points.at(-1);

  check('共干只有一段', trunk.length === 1, { got: trunk.length });
  check('每个语义簇各有一段分叉骨架', groups.length === 3, { got: groups.length });
  check('每个语义簇各有一个分叉结点', junctions.length === 3, { got: junctions.length });
  check('候选细枝数 = 候选数', twigs.length === 5, { got: twigs.length });
  check('每段细枝都有待选虚线', dashes.length === 5, { got: dashes.length });
  check('簇分叉骨架都从同一个共干末端出发',
    !!trunkEnd && groups.every(g => dist(g.points[0], trunkEnd) < 0.01),
    { trunkEnd, starts: groups.map(g => g.points[0]) });
  check('候选细枝从所属簇的分叉点出发（真树形，不是从当前点放射）',
    twigs.every(t => {
      const j = junctions.find(jj => jj.group === t.group);
      return !!j && dist(t.points[0], j.points[0]) < 0.01;
    }),
    twigs.map(t => ({ id:t.branchId, group:t.group, from:t.points[0] })));

  const radii = s.pos.map(p => Math.hypot(p[0], p[2]));
  check('终点半径不再全部相等', Math.max(...radii) - Math.min(...radii) > 0.4,
    radii.map(r => +r.toFixed(2)));
  const ys = s.pos.map(p => p[1]);
  check('路牌高度不再随 rank 单调爬升成斜线',
    ys.some((y, i) => i > 0 && y < ys[i-1]), ys.map(y => +y.toFixed(2)));

  const angles = s.pos.map(ang);
  const intra = [angles[1]-angles[0], angles[4]-angles[3]];
  const inter = [angles[2]-angles[1], angles[3]-angles[2]];
  check('同簇候选角度更近、异簇更远（语义簇进了几何）',
    intra.every(a => inter.every(b => a < b)),
    { intra, inter });

  check('路管透明度仍守住 [0.14,0.5] 不变量',
    s.tubes.length > 0 && s.tubes.every(t => t.opacity >= 0.14 && t.opacity <= 0.5),
    s.tubes.map(t => t.opacity));
  check('机位仍贴轨', Math.abs(s.offRail) < 0.05, s.offRail);

  // 拾取：牌面仍可点（牌高偏移未改）
  let pickOk = false;
  for (const sign of s.signs){
    const hit = await page.evaluate(p => {
      const scr = window.__cockpit.projectToScreen(p.x, p.y, p.z);
      return scr ? window.__cockpit.pickAt(scr.x, scr.y) : -99;
    }, sign);
    if (hit === sign.id) { pickOk = true; break; }
  }
  check('树状布局下路牌仍可被射线命中', pickOk, s.signs);

  // 走完一条候选：该候选虚线熄灭，其余待选虚线保留
  const dashBefore = await page.evaluate(() => window.__cockpit.forkDashVisibility);
  await page.evaluate(() => window.__cockpit._markBranchForTest(0));
  const dashAfter = await page.evaluate(() => window.__cockpit.forkDashVisibility);
  const d0 = dashAfter.find(d => d.id === 0);
  check('走过候选后其待选虚线熄灭', dashBefore.find(d => d.id === 0)?.visible === true && d0?.visible === false,
    { before: dashBefore, after: dashAfter });
  check('其余候选虚线不受影响', dashAfter.filter(d => d.id > 0).every(d => d.visible),
    dashAfter);

  // clusters 缺失：逐候选成簇，仍能铺出树形
  await inject([], 0.62);
  await page.waitForTimeout(2500);
  const fb = await page.evaluate(() => window.__cockpit.forkTopology.map(x => x.kind));
  check('clusters 缺失时逐候选成簇，共干/分叉/细枝仍齐全',
    fb.filter(k => k === 'trunk').length === 1 && fb.filter(k => k === 'group').length === 5 &&
    fb.filter(k => k === 'twig').length === 5, fb);

  check('0 JS 错误', errors.length === 0, errors);

  const pass = results.filter(r => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
  console.log(`\n${pass}/${results.length} PASS`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})();
