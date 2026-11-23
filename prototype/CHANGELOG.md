# 变更日志 · CHANGELOG

> 本文件是 `prototype/` 实证原型的**版本事实源**（按版本倒序）。
> 设计 / 架构见同级 `DESIGN.md`；研究背书见仓库根 `docs/`。
> 不变量红线贯穿所有版本：不新增完成信号、不伪造数据、不碰相机公式 / 路牌几何 / 中断态；
> `?mode=opaque` 实验操纵一致性保持。

---

## v0.9.50 · 2026-11-22 · FI-01 事件驱动执行行驶：「行驶」不再是完成后的过场动画

来源：[docs/FIELD-ISSUES.md](../docs/FIELD-ISSUES.md) FI-01（🔴 愿景级）。
**这是驾驶隐喻成立的关键一步**：旧时序 `execute_done → driveTo`，行驶时长由距离决定
（`dist*100`），与真实执行完全解耦——车是「工作完成后的庆祝动画」。本版把行驶改由
**真实执行事件**驱动，学科 2 检验问题 B1（路径位移 ↔ 真实工作）在实现层闭合。

### 新时序（`beginExecDrive` / `execDriveOnToken` / `execDriveFinish` / `execDriveAbort`）

- **出发即行驶**：`startExecution` 立刻 `beginExecDrive(分支落位点)`，不再等 execute_done；
- **execute_ack = 起步信号**：后端受理即 `started=true`（0 字也给微小正目标，「已受理」与「未受理」可区分）；
- **token 流 = 巡航**：目标进度 = 真实输出字数 / 220，封顶 **0.9**——执行期间车绝不越过 90%（活没干完不到站）；模型快车快、模型慢车慢；p 单调只进不退；
- **无 token 的忙等**：极慢巡航（0.008/s，上限 0.225）如实表达「在干活但没产出」，不是假节拍；
- **execute_done = 落位信号**：剩余路段 ~700ms 单调滑完并精确停靠（`ARRIVAL_CAM_DIST`、docked）；到达广播（结果卡/账本/续探）仍严格绑定落位完成，时序纪律不变；
- **中断 = 就地停车**：p 冻结，保留已走过的真实位移，绝不滑向终点（与中断第三态天然契合）；
- **失败/超时 = 就地停车**：不 docked、不宣告完成；**澄清 = 单调退回岔口**（没走过这一步）；
- **token reset（重试）**：进度回落 ≤0.05 重新由真实字数驱动，重走后仍可达终点；
- **并发纪律**：落位收尾期间 `startExecution/travelFuture/undoStep/forkFromRun` 一律提示稍候（防错锚）；新提问/传统 driveTo 接管时作废在途执行行驶（`_driveToken` 既有机制）。

### 不变量（全量几何回归锁死）

机位公式一字未动（`currentPos − forward(camAnchorYaw) × dist`，眼位 1.35m）；
`camOffRail≈0` 全程每一采样点；`camAnchorYawT` 出发写入、落位收敛（与 driveTo 同契约）；
停靠收近并入行驶进度单调完成、落位即静止无回弹；`manualCamDirty` 尊重手动视角；
驶过淡出/近场淡出/「现在」条隐藏恢复时序全部沿用。

### 验证

- **新回归 `test_exec_drive.js` 36/36**（桩 WS + 真实入口）：A 出发即行驶 / B token 单调驱动 + 0.9 封顶 / C 落位精确停靠 + anchor 收敛 + 2s 无回弹 / D 中断就地停 / E 澄清退回岔口 / F 失败不 dock / G reset 后仍达终点 / H 全程 rail≈0。
- **真实后端端到端**（Ollama gemma3:1b）：280 字起草任务，巡航采样 p 0.02→0.69 随字数 40→322 单调推进、封顶 0.9 遵守、maxRail=0；落位 docked/dist=5/anchor==anchorT/source=llm/228tok/0 JS 错误。真实中断：首 token 后 stop → 位移冻结 0.0000、status=interrupted、rail=0。
- **全量几何回归**：camera_diag、rail_camera 14/14、driving_view、ux_fixes5/6/7、nowsign_2、f32/f36/f37/f38、immersive、occlusion 全绿。
- **全量功能回归**：honesty 5/5、opaque 22/22、keyboard 22/22、compare 27/27、cancel 33/33、timeline 42/42、practical 16/16、scenery 21/21、future_travel、arrival_persist 13/13、decorative、transparent-nolink、no-fingerprint 8/8、fi02_fi07 13/13、sign_topics 17/17、context_pull 14/14、refine_sync、clarify_dock/quick、click_det、walkthrough_real 15/15；后端 cancel 16/16、ws_lifecycle 14/14、truncation 16/16、expert_state 25/25、forecaster 29/29、topic_binding 全过。

### 测试适配（如实记录，非产品回退）

- `test_nowsign_2.js` C 段：夹具直接 finishOnce 时到达广播同步执行，`.show` 在 MO 挂上前已加——改为先挂观察器再触发 + 已 shown 兜底（两种时序都覆盖）。
- `test_ux_fixes5.js` C 段：pickAt 扫描点可能落在底部输入栏（#intentRow）上被 DOM 吃掉——补 `elementFromPoint` 校验与用户真实可点语义一致。**基线对照确认此 flake 在改动前同样存在**（双向 stash 验证），非本版引入。
- `walkthrough_real.js` P0 取消段：小模型可能瞬间生成完，固定等 2.5s 再 stop 变成「迟到取消」（v0.9.16 cancel_late 契约，done 是事实非伪装）——改为等「真实在生成」再取消；已生成完则按迟到取消分支如实断言。
- **已知环境项（基线同样失败，stash 对照确认）**：`test_e2e` / `test_e2e_b` / `test_seq` 顺序链在本机小模型 + 无头环境 Page crashed / 拆分质量不足，不具判定力；与本版无关，如实记录不掩盖。

---

## v0.9.49.5 · 2026-11-22 · 实测修复批次三：长指令句碎片路牌质量门（FI-04）

来源：[docs/FIELD-ISSUES.md](../docs/FIELD-ISSUES.md) FI-04。纯 forecaster 层，
执行链 / 相机公式 / 路牌几何 / 中断态 / 实验操纵零触碰。

- **`_extract_business_phrases` 三道质量门**（实测「拆解字左右」「一个天气应用首页写一段」的根因修复）：
  - **嵌入动词切点**：CUT 正则补「写/包含/介绍/说明/显示/展示/回答/涵盖/覆盖/涉及/围绕/撰写/编写/起草/给出/列出/阐述/描述」——长指令句的动宾半句在动词处切开，不再粘成路牌；
  - **数量词/单位残片过滤**：`QTY_FRAG`（字/词/句/段/篇/条/个/份/左右/以内…开头）+ 指令壳词黑名单（一段/中文回答/模块/内容/各自…）——「150字左右」切剩的「字左右」不再上牌；
  - **计数头/尾剥离**：「一个天气应用首页」→「天气应用首页」（业务对象保留）；「生活指数三个模块」→「生活指数」。量词表刻意不含「数」——修复过程中实测发现「指数」的「数」会被计数尾误吃成「生活指」，已用整体量词短语匹配规避并加断言锁死。
- **回归**：`test_topic_binding.py` 新增 [I] 组 11 项断言（三条实测长句 × 短语/路牌双层碎片检查 + 业务对象保留 + 中长期/用户侧边界不回归），全套通过；forecaster pytest 29/29；后端 cancel 16/16、ws_lifecycle 14/14、truncation 16/16；前端 honesty 5/5（20 牌）、sign_topics 17/17、opaque 22/22、keyboard 22/22、compare 27/27、practical 16/16、timeline 42/42。
- **端到端实证**：真实 8770 fast=1 链路输入实测原句「写一段150字左右的产品说明：包含实时天气、逐小时预报、生活指数三个模块…」，路牌为「检索逐小时预报 / 对照实时天气 / 核算生活指数 / 落地逐小时预报 / 汇总产品」——碎片 0、JS 错误 0。

---

## v0.9.49.4 · 2026-11-22 · 实测修复批次二：截断如实标注（FI-02）+ 伪造钩子门控（FI-07）

来源：[docs/FIELD-ISSUES.md](../docs/FIELD-ISSUES.md)。执行链语义不变（仍单步真实流式），
相机公式 / 路牌几何 / 中断态 / 实验操纵零触碰。

- **FI-02 上限截断不再无声交付半截产物**：
  - `_llm_stream` 捕获 SSE `finish_reason=length` → `last_truncated`；
  - 执行上限按任务类型分档 `EXEC_MAX_TOKENS`：compose 1024 / analysis·general 320（旧值一律 220，起草常在句中掐停）；
  - `judge_completion` 新增 `truncated` 判据：截断 = 有真实产出但不完整 → **partial**，绝不判达成；
  - 任务条截断轮不打 ✓、注明「输出达上限被截断，未完整」；note 给「展开完整成果」补齐指引（复用既有 partial 行动出口）；
  - `server.py` 结果卡全文上限 400→6000 字符（与 refine 同口径）；仍超限则如实标 truncated + note 说明——旧 400 上限会把 compose 长成果**二次截断且不告知**；
  - `truncated` 全链透传：execute_done → 结果卡达成度文案 → 账本 exec.truncated → CSV 导出 `exec_truncated` 列。
- **FI-07 伪造到达钩子加门**：`simulateArrival` / `setupTestArrival` 仅 `?test=1` 页面可用，
  正常页调用直接拒绝（返回 false/0，账本零污染）；测试搭景轮**强制 `decorative=true`**
  （沿用 v0.9.32 C 组正交标记语义：呈现一致、账本/导出/collectRealOutputs 单列，绝不混入 P1 真实结论）。
  只读诊断钩子不受影响。19 个使用搭景钩子的回归脚本 URL 已补 `?test=1`。
- **新回归**：`backend/test_truncation.py` 16/16（fake-SSE：length/stop 两态 × 判据/流捕获/execute 全链/分档上限）；
  `verify_fi02_fi07.js` 13/13（真实后端+小模型端到端：compose 513 字完整交付 achieved；
  正常页双钩子拒绝且账本零污染；?test=1 可用且 decorative=true；0 JS 错误）。
- **既有回归**：后端 cancel 16/16、ws_lifecycle 14/14、expert_state 25/25、forecaster 29/29；
  前端 honesty 5/5、opaque 22/22、keyboard 22/22、compare 27/27、cancel 33/33、timeline 42/42、
  practical 16/16、scenery 21/21、arrival_persist 13/13、camera_diag、f32_link、future_travel、
  driving_view、immersive 全绿。

---

## v0.9.49.3 · 2026-11-22 · 实测修复批次一：前端相对路径化（FI-05）+ 健康探针 OpenAI 兼容（FI-06）

来源：[docs/FIELD-ISSUES.md](../docs/FIELD-ISSUES.md) 实测问题清单（博文制作过程端到端实跑发现）。
本批为零红线触碰项：执行链语义、3D 几何、中断态、实验操纵全部不动。

- **FI-05 前端相对路径化**：`index.html` 7 处硬编码 `localhost:8770` 清零——
  `WS_URL` 由 `location` 推导（`https:` 自动 `wss:`；`file://` 直开回退本机 8770 保持静态预览可用）；
  6 处 REST fetch 改相对路径 `/api/…`。后端换端口 / 反代 / 域名 / HTTPS / 局域网被试访问均零配置。
  验证：非默认端口 8890 起后端，页面零配置连上 WS + REST，真实模型完整走一轮
  （source=llm / 48 tokens / 0 JS 错误，API 请求 host 全部跟随页面 host）。
- **FI-06 健康探针补 OpenAI `/models`**：`server.py` `health()` 探针链追加 `{base}/models`
  （带 Bearer 鉴权头、只读列表不占推理槽），Ollama / vLLM / 云端端点不再误报 `llm_service: unknown`，
  如实报 `openai_compat`。回环直连绕代理逻辑同时修正为仅回环强制直连（远程端点尊重系统代理，
  与 `/api/config/llm/test` 口径一致）。验证：Ollama 后端下 `/api/health` 报 `openai_compat`。
- **回归**：后端 `test_cancel_backend` 16/16、`test_ws_lifecycle` 14/14、`test_expert_state` 25/25、
  forecaster pytest 29/29；前端 `test_honesty` 5/5（20 牌）、`verify_opaque` 22/22、
  `test_keyboard` 22/22、`test_compare` 27/27、`test_cancel` 33/33、`test_timeline` 42/42、
  `test_practical` 16/16、`test_scenery` 21/21、`test_camera_diag` ALL_PASS、
  `test_future_travel` 3 轮探索链无死路。
- **已知环境项（非本批引入，基线复测确认）**：`test_e2e` / `test_e2e_b` 的「到达/未来牌投影不稳定」
  软性观察项在本改动前的基线代码上同样失败（stash 对照验证）；`test_e2e` 顺序链依赖 35B 级模型
  的任务拆分质量，小模型（gemma3:1b）环境下不具判定力。两者均与相对路径化无关，如实记录不掩盖。

> **合并注（v0.9.50 双线）**：本版本历史上有两条并行开发线，均基于 v0.9.49.2 分叉，合入时按日期倒序并列保留——下方 11-22「FI-01 事件驱动执行行驶」来自远端主线，11-20「真实界面走查修复」为界面实证批次；二者改动文件不同、互不覆盖。

## v0.9.50 · 2026-11-20 · 真实界面走查修复批次：候选叠牌/面板吞牌/到达空屏/贴脸光斑/重铺漂移

用户要求「真正看系统的界面表现，而不是只看代码逻辑」。用真实 Chromium + playwright-core
驱动运行中的 8770 + 真实本地 LLM，做两轮端到端走查（事实问→终态、开放问→分叉→执行→到达→
第二轮），每步截图 + 屏幕包围盒量测（`ui-audit/walkthrough.js`、`report_*.json`、`shots_*/`）。
**所有根因均由截图/时间序列实证定位，非代码推演**；执行链语义、账本、中断态、实验操纵零改动。

- **★ 候选牌互相叠死（几何根因）**：旧布局「角间隔×半径」横向跨度 ≈1.45m < 牌宽 2.1m，
  与相机距离无关的必然重叠；同簇 jitter 被 intraSpread 压到 ~0.05rad、siblingR ±5.2m 深度排队
  在低机位下近大远小挤成一团。新布局：等角基线+语义微调（同簇间隔 ≥ 牌宽/半径 的构造下限、
  异簇分剩余预算 ±35% 语义加权），总展角 1.0–1.18rad、牌宽 2.0m、半径基 8.2m——
  实测五牌屏幕间距 > 牌宽、零互叠。语义仍进拓扑（共干/簇骨架/细枝）、半径、高度与文案。
- **★ 外侧牌被右面板整块吞掉/出屏**：扇形基准旧用 travelYaw（旅程主轴），拐弯后滞后机位
  方向可达 90°，候选带整体甩出屏幕（实测 sign0 x=1702/2505）。改与未来牌同源：
  `camAnchorYawT`（目标锚点，fast 中途回填也不取半程值）。配合审阅机位 8m（巡航 11m 下
  牌面 12 字仅 ~7px 不可读；6m 曾试外侧牌进面板），外侧牌中心+半宽收在面板左缘内。
- **★ LLM 重铺触发隐藏「上车」导致点击窗口漂移（时间序列实证 t=49 anchor 0.79→0）**：
  `applyForecastResult` 末尾旧版每次铺牌都 `driveTo(cur+3,+3)`——硬编码 45° 与扇形基准错开、
  重铺再前进 3m 把外侧牌横偏放大 ~3×。新规则：**上车只发生在新提问首次铺牌**（沿扇形基准
  前进 3m，机位/视线/候选带同源）；LLM 升级重铺**原地换牌零位移**（`_boardedThisQuestion`）。
- **★ 到达即空屏（结果牌/指纹环在相机身后 ndcZ>1）**：一帧直达与行驶落位只改机位锚点、
  视线靠慢阻尼数秒收敛。改为落位帧视线 yaw/focus 同帧 snap（仍无回弹）；注视阻尼 d*0.8→d*2.5
  （~0.5s 收敛）；clarify 无位移到达 `approachTheZ` 顺向当前路段（旧版 len≤0.5 直接 return，
  澄清态 3D 半屏空）。
- **★ 短轨道夹取把相机钉在起点节点球正上方**：轨道长 < 后挂距离时旧版夹到起点（眼位距球
  ~1m → 巨大光斑；实际后挂缩水 → 牌投影放大叠死）。`_railBack` 改沿起点切线延长取点，
  `_distToRailXZ` 判据共用同一段延长线（`_railExtension`）——机位恒在道路中心线自然延伸上，
  camOffRail≈0 不变量由构造保持。
- **★ 贴脸/身后凭据铺满全屏**：新增 `updateCameraFade`——里程碑精灵、旧到达牌、节点球
  （core 改 transparent）、已走亮管（按相机到管段最短距离）、到达环、nowMarker、指纹环、
  载具自身、沿途风景卡统一「身后/近场淡出」；`_applyFade` 基线=当前透明度/上次系数
  （首帧贴脸也能淡出）。**两处「每帧覆盖」根因（实测 opacity/visible 定位）**：
  ① animate 每帧无条件 `_fingerprintRing.visible = dist>2.0`，把淡出设的 visible=false
  下一帧覆盖回去 → 改为与淡出系数相乘；② F3.2 卡↔牌联动块在脉冲衰减之后把
  glow.opacity 无条件写回 0.2–0.7（实测停靠态 0.514 实心绿巨斑）→ 联动语义保留
  （B0 组仍整块禁用）但同乘近距衰减。指纹环铺路态 ×0.3 透明度 + 0.6 缩放、结果态
  ×0.32 + 0.55 缩放（位置/半径/挂高/数据不变，回归契约守住）；里程碑屏幕尺寸封顶
  240px（depthTest:false 近距放大 449px 压 HUD）、截断 15→22 字；候选牌屏幕尺寸封顶
  280px（到达态已选牌 5m 处投影 450–530px 压 HUD）。最新到达牌恒不接管（读/点契约）。
- **★ 左下/顶部面板互盖**：nowBar 固定 bottom:160px 压在 ~309px 高的图例上 → 动态坐在图例
  正上方（resize 同步重排，顺带修相机 aspect 不随窗口更新）；thinkBar top:52→98、
  toast top:56→136，让开 progressHud（top:54）。
- **双击出发可靠性**：dblclick 取消单击延时 focusBranch（旧版出发瞬间视线还被带偏）；
  focusBranch 注视偏移直接指向牌本身（旧硬编码 +2.6/+1.1 落在牌侧下方）。
- **✓ 徽章可读**：badgeFace 改 DoubleSide 并前移 0.35m 到球前——旧版单面且与球同中心，
  球前半球深度遮住面中心，任何视角都只看见纯色绿球（实测到达态截图）。
- **牌面长标题两行排布**：>10 字主标题折两行、字号下限 64（旧单行缩到 44 → 8m 机位
  ~8px/字不可读）；断行优先靠近中点的分隔符，不劈词/缩写；副标题按第二行底缘下移让位；
  到达牌/短标题保持原单行。实测两行完整业务短语可读、与副标题/底栏零重叠
  （sign_topics 17、copy_naturalness 12、honesty 5、tree_fork 17 全过）。
- **clarify 补答后候选带整带出屏（sign0 x=2286/1825，双击落空）**：`sendMessage`
  新提问节点硬编码 (+4,+4)=45°，主轴已转向（如 -90°）后两者错开可达 135°——
  候选带沿主轴铺、机位却朝 45°。改沿 `travelYaw` 前进 5.66m（与原步长等长）。
- **候选带受屏幕安全区约束**：新增 `_safeViewHalfTan()` 按**实际可见卡片**量测
  左右面板间真实可视窗口（容器恒 340px 但卡片常 ~280px，按容器算会误报），
  总展角 = min(安全区上限, 1.18, 等角预算)；同簇间隔取 min(不叠下限, 预算/2×0.6)
  保住「同簇近/异簇远」契约（安全区收窄时旧 MIN_GAP 会吃光预算致 intra>inter）。
- **拉近下限 3.4→4.8**：v0.9.49 的 3.4 只保证「视锥内」（NDC），量不到 DOM 面板——
  实测 3.4m 时结果牌底缘 y≈936 被输入栏(top 797)盖住下半；按 5m/3.4m 两组投影
  反解 dist≥4.8 底缘≈794 才让开。沉浸态输入栏抽屉化，仍用 3.4（字面量）。
- **nowMarker 竖光柱停靠态仍贯穿画面**：probe 用标记中心距离，低估了 +2.6m 柱体
  上段的贴近程度；改 5m 内全隐、8m 恢复。分叉骨架结点小球（bid -120-gi，实测
  2.08m 贴脸）并入近场淡出。
- **走查装置三处假阳性修正**（`walkthrough.js`）：① 右缘按实际最宽可见卡片而非
  容器；② `waitExecDone` 加 minRuns（防把上一轮 done 当本轮完成）；③ 到达量测前
  等 `done && !isDriving && (docked || clarify)`（结果卡在落位前就弹出；clarify
  合法不 dock，旧版等 camDocked 白等超时量到半程状态）；B clarify 同 A 约定补答。
- **keyboard F1 采样竞态**：测试 F 段先 `waitForFunction(!isDriving)`+settle 再断言贴轨
  （旧版在 E 段 driveTo 行驶中途采样 camOffRail，锚点插值中偶发非零；不变量本身未放宽）。
- **不变量**：执行链/账本/达成度/中断态/`?mode=opaque|decorative|no-fingerprint|transparent-nolink`
  零改动；牌高偏移 +2.7、拾取契约、管透明度 [0.14,0.5]、同簇角近异簇远、半径不等、高度非单调、
  眼位 1.35、camOffRail≈0、到达牌 -1.05/拉近下限 3.4 全守。
- **回归**：tree_fork 17/17、rail_camera 14/14、arrival_persist 13/13、fp_arrival_rebuild 7/7、
  nowsign_2 全过、keyboard 22/22、terminal 19/19、e2e 全过、model_settings 10/10（需
  COCKPIT_LIVE_DIR）、pytest forecaster+cancel+expert_state 29/29、ws_lifecycle 14/14；
  最终实走查 `ui-audit/report_final_cont4.json` 完成到时间线/决策链/拉近态，0 JS 错误，候选态 0 遮挡/0 出屏。
  clarify 补答后的真实 `pickAt`/双击事件已单独诊断为进入执行态；旧到达牌在拉近态仍可能位于视锥外，属于保留原轨迹的既有空间语义，最新结果牌不受影响。
- **走查装置（运行目录内，不入库）**：`ui-audit/walkthrough.js`（截图+包围盒量测+遮挡/出屏/互叠判定）、
  `diag_click_b/diag_b_state/diag_drift/diag_clarify.js`（事件级/时间序列根因诊断）——装置连同
  334 张截图/报告/日志共 ~81M 留在运行目录，按仓库策略不入库；结论以本节与
  `ui-audit/report_final_cont4.json` 摘要为准，复现需在 LIVE 目录执行。

---

## v0.9.49.2 · 2026-11-20 · 工程加固批次二：WS 生命周期 + 哨兵分离 + 投影确定性 + 同步工具

外部审查第二批 P1 修复。执行链语义、3D 几何契约、实验操纵零改动。

- **WS 断开收尾（后端）**：`WSConnection` 新增 `bg_tasks` 登记与 `shutdown()`——此前 `exec_task` 只存最后一轮（旧引用覆盖丢失）、refine/explain 连引用都不存，**断开后在飞 LLM 生成继续白烧单槽 55–70s**、异常成 "Task exception was never retrieved"。断开时先让在飞任务走协作式中断（`reason=user_cancelled`、部分文本、任务条 stop——与用户点停止完全同语义），短窗口未收口的才兜底 cancel。新测试 `backend/test_ws_lifecycle.py`（fake-LLM，不占模型槽）。
- **「停止生成」对 refine 生效**：refine 的 cancel_event 此前建完无人 set（只能等 70s 超时）。refine 登记 `conn.refine_cancel_event/executor`，cancel 消息与断开都作用它；并发 refine 如实回 `reason=busy`。
- **哨兵分离（`[` 误杀修复）**：`_llm` 改结构化返回 `(text, reason)`，错误一律进 reason；删除四处 `startswith("[")` 判定（execute 主链/重试链、refine、judge_completion、explain）与前端 `hasReal` 镜像。此前模型正文若以 `[` 开头（`[草案] 一、…`、JSON 数组形输出）会被丢弃并误判失败/need_input——refine 的缺数据诚实出口本就是尾部 `[达成度: 待补输入]` 自评（v0.9.36），裸前缀判定是哨兵时代残留。
- **投影确定性**：`force_directed_3d` 种子默认由候选向量内容派生（sha256）——同一组候选每次 forecast 的 `pos3d` 从「每次随机」变为「同输入同布局」，3D 几何结论研究可复算；显式 `seed` 参数可复现实验。所有前端测试用自注入 pos3d，零影响。
- **前端 WS 细节**：断线重连固定 3s → 指数退避（1s→…封顶 15s，连上清零）；`wsSend` 离线不再静默丢弃——`cancel` 类消息未发出时如实提示并复位停止按钮（不再卡「正在停止」）。主执行链 70s 兜底（已有，复核确认）。
- **新工具 `tools/sync_live.py`**：repo→LIVE 一键同步（默认干跑、sha256 校验、`--apply` 复制、`--restart` 杀 8770 等看门狗拉起）——把「改 repo 必须手动 cp 到 LIVE 否则不生效」的踩坑流程固化，替代手动 cp。自动探测 `WorkBuddy/*/agent-3d-cockpit` 或 `COCKPIT_LIVE_DIR` 指定。
- **回归**：`test_ws_lifecycle` 14/14（断开收尾/refine 停止/并发 busy/哨兵四场景）；`test_cancel_backend` 16/16；pytest forecaster+expert_state 29/29；投影确定性专项（同输入两次逐位相等、异输入不同布局）；页面冒烟 0 JS 错误。

---

## v0.9.49.1 · 2026-11-20 · 工程加固批次：修被掩盖的中断契约 bug + api_key 透传 + XSS 转义 + 默认回环绑定

外部审查发现四项已验证硬伤，全部修复并补回归。执行链语义、3D 几何、实验操纵零改动。

- **★ 修真 bug：用户中断被误报为 error（v0.9.41 引入，潜伏 8 个版本）**。`task_tracker.py` 的 `make_internal_state` 形参名是 `interrupted_val`，而中断收尾路径用关键字 `interrupted=True` 调用 → **每次点「停止生成」，interrupted_result() 100% 抛 TypeError**，被外层吞成 `reason=error`——v0.9.16 的中断契约（如实标 user_cancelled / 回传部分文本 / 任务条 stop）静默失效。形参名对齐后 `test_cancel_backend.py` 16/16 全绿。
- **★ 修测试坏死：`test_cancel_backend.py` 已因配置函数化重构失效**（monkeypatch 把 `server.LLM_BASE_URL` 覆盖成 str，`LLM_BASE_URL()` 调用即 TypeError，**一个断言都跑不到**——上述中断 bug 正是被它掩盖）。改用 `llm_config.update(..., persist=False)` 热更新接口；顺带新增 §4 断言锁死 api_key 透传。
- **api_key 透传（AgentExecutor 全链路鉴权）**：`_llm`/`_llm_stream` 此前不带 Authorization 头——界面配置云端模型（OpenAI 兼容）时 execute/refine/explain 一律 401 静默降级成「模型未返回有效内容」且不告知原因。`AgentExecutor(api_key=...)` + `_auth_headers()`（非空且非 "EMPTY" 才发 Bearer，本地 llama.cpp 无感），server 三处构造透传 `LLM_API_KEY()`。
- **前端注入点修复**：`renderContextTags()`（index.html）的 `t.text`/`t.src` 未走 `escHtml` 直插 innerHTML，而标签数据源含模型输出（`collectContextPhrases` 收 `d.output`）——恶意/异常模型输出即注入（`title="${t.src}"` 为属性注入位）。全文其余 41 处 innerHTML 均已转义，唯此漏网。专项验证：`<img onerror>`/`"><svg onload>` 两类注入均被转义、转义后删除按钮仍可用（dataset 读回原文本）、0 JS 错误。
- **默认绑定回环**：`server.py` 与 `backend-watchdog.py` 的 `0.0.0.0` → `127.0.0.1`（`HOST` 环境变量可显式开放）。全 API 无鉴权 + WS 无 Origin 校验 + base_url 可热改的组合下，绑 0.0.0.0 使「改 base_url → 触发 forecast/test → api_key 发往任意地址」成为同网段可达的密钥外带通道。
- **修测试边界笔误**：`forecaster/tests/test_core.py::TestRoadType` 断言 0.35 为 CURVE，与实现注释「D ≥ 0.35 → 分岔」矛盾（off-by-one）。改为 0.349 → CURVE + 0.35 → FORK 边界断言。
- **回归**：`test_cancel_backend` 16/16（新增 §4）；`pytest forecaster/tests/ backend/test_expert_state.py` 29/29；XSS 专项 PASS；`run_regression.sh` 六个新补测试（decorative/transparent-nolink/no-fingerprint/terminal/arrival-persist/fp-arrival-rebuild）全过。

---

## v0.9.49 · 2026-11-20 · 到达结果牌保留 + 拉近下限（滚动鼠标结果牌消失修复）

用户实测：大模型生成中滑动鼠标，第一站结果路牌"没了"。诊断出两条独立机制，均修复：

- **机制 A（主因，发新问题真删牌）**：发第二轮问题 `sendMessage` / 推演重建 `applyForecastResult` 都调 `clearBranches()` 无条件清空 `_arrivalResults` 和所有 -2 到达牌；`applyForecastResult` 之后还有三行数组无条件置空，把保留引用也丢掉。修复：`clearBranches(opts)` 支持 `keepArrival`，保留 -2 牌/到达环/`_arrivalResults`；两处新轮次调用传 `keepArrival:true`；`applyForecastResult` 重建数组时只归零节点球、保留 -2。显式 reset/回退仍走默认全清，语义不变。已完成的站是真进展的空间凭据（P3 可追溯），不再因开新一轮消失。
- **机制 B（次因，滚轮拉近掉出视锥）**：到达牌沉在路面下 1.05m，滚轮拉近到 dist=3 时 NDC y 掉到 -0.963 贴视锥下缘（牌还在、visible=true，但看着像没了）。修复：有 -2 到达牌时滚轮拉近下限抬到 `ARRIVAL_MIN_VIEW_DIST=3.4`（与沉浸模式同值，实测 NDC≈-0.85 完整可见）；无到达牌的纯探索态仍可拉近到 3.0。

**零改动**：账本/达成度/机位公式/牌高偏移/轨道/指纹环/真实执行/实验组操纵全不动，P1–P4 不变量守住。回归：新 `test_arrival_persist` 13/13；真实场景复测（发第二轮+生成中滚动、拉近/拉远）arrivalCount 全程=1、三态 `inFrustum=true`；其余 11 套（终态 19、键盘 22、树分叉 17、内部状态 14、指纹环系列、跨轮 21、语义投影 18、session 31、时间线 42）全绿。

---

## v0.9.48 · 2026-11-20 · 类型分流+终态：断掉"无效续探死循环"

用户用真实用例「目前有哪些常见的主流风机功率预测算法」实测，发现路牌/导航陷入**对推进解答无效的简单死循环**：事实列举类问题被铺成「检索/拆解/对照/核算/汇总」通用模板，选完一步又无条件铺下一批，两套模板机械交替、上下文尾部 5 轮不变——把"永远有下一步"当成"永远在进展"（与已删的预览车队假进度、中间剧场同病）。

- **根因**：后端已下发 `execution_mode=direct/sequential/choice`，但前端 `applyForecastResult` 只记录不行动；到达收尾 `if (p && !clarify) autoExploreNext()` 无条件续探。且 LLM 判定不稳定（同一用例两次分别判 direct/choice），不能只靠它。
- **终态判定 `isTerminalTask(context, mode, taskKind)`**（纯函数、可测）：① `mode==='direct'` 终态；② 确定性"事实列举/定义问句"识别（有哪些/什么是/定义…且非"写一段/生成一份"交付物）兜住 LLM 判 choice 的不稳定；③ `sequential` 永不终态。
- **续探门控 `shouldAutoExplore(p, detail, terminal)`**：与真实收尾共用同一处真相，终态/澄清/无位置均不自动铺路。`arrivalDetail.terminal` 随结果卡与账本如实标记。
- **结果卡终态 UI**：卡头「问题已解答」+ 绿色"一问一答、到此为止"说明条 + 显式「继续探索相关方向 →」按钮；**只有用户主动点**才走 `continueExploringFromCard()`（复用 `autoExploreNext`，不新增机制）。开放任务（choice/sequential）保持原自动续探。
- **不变量**：账本/达成度/机位/轨道/到达牌/指纹环/真实执行/实验组操纵零改动；澄清与中断仍不推进。
- 真实用例端到端复测：`terminal=true`、结果卡显示真实模型答案、`kbFutures=[]`/`futureSigns=0`（不再自动铺路）、`runCount=1`、0 JS 错。
- 回归：`test_terminal_task` 19/19；键盘 22、树分叉 17、内部状态 14、无指纹环 8、指纹环 18、到达重建 7、跨轮 21、语义投影 18、session 31、时间线 42 全过。
- 新增 `test_terminal_task.js`（19 断言）；补入上批遗漏的 `test_fp_arrival_rebuild.js`。

## v0.9.47 · 2026-11-20 · 分叉水平弧形扇开 + 指纹环时序/放大（用户实测修复）

用户实测两处问题：① v0.9.46 水平铺开后"分叉变成一长串，更不易区分"；② "模型权重映射到 3D 一点效果都看不出来"。

**分叉（水平弧形）**：根因是 v0.9.46 用 `siblingR=±3.4` 把同簇兄弟在**深度**上前后拉开，低机位下排成一长串。本版彻底删除该深度错落，改为**水平抛物弧**——中间近、两侧略远（arcDepth 按归一化角度平方，最多后退 1.2m），离中心越远越退后画出扇面；同簇兄弟靠**左右角度**分开（jitter 0.06→0.28、intraSpread 上限 0.22→0.30），配一个极小的深度错落（±1.3m，远小于旧 3.4）消除投影残余重叠；整体展开取中间值 0.62（太窄重叠、太宽被左右面板裁切），路牌宽 2.6→2.1。实测同簇兄弟屏幕间距 129px→177px（>160px 分离阈值），5 张牌沿弧线铺开、不再重叠。`test_tree_fork.js` 17/17，契约（同簇角度近异簇远、半径不等、高度非单调、牌高+2.7拾取、管透明度）全守。

**指纹环（时序 + 放大）**：数据源实测无问题——8083（`llama-server-stats.exe` 带 `--expert-stats`）直连 WS 真实执行返回 `status=available`、512 维 dist、8 个 top 专家。看不到是呈现层三处硬伤，逐一修：① **时序错位（最关键）**：旧版环只在铺路时按"上一轮"指纹建在起点，执行完机位开走后环被甩在身后、且显示的不是本轮信号。新增 `rebuildFingerprintAtArrival(p, st)`，在 `postDriveArrival` 落位后用**本轮** `internal_state` 在到达点重建（挂高 +1.4 避开沉下去的结果牌）。② **太小太暗**：环半径 0.9→1.7、条长上限 0.31→0.68、透明度 0.26+0.42f→0.42+0.5f、底环/core 同步放大。③ 近距隐藏阈值 1.2→2.0（否则结果态停靠时误隐藏）。B2 组门控（`_noFingerprint`）不变，只包呈现不碰账本。`test_fp_arrival_rebuild.js` 7/7（放大/本轮替换/挂到结果位置/诚实降级/0 错），`test_no_fingerprint` 8/8、`test_fingerprint_3d` 18/18、`test_internal_state` 14/14。执行链/账本/机位/轨道/到达牌/中断态零改动。

> 注：M2 B/B2 对照的 B 组视觉（指纹环大小/位置）随本版本改变，真人实验若已开始采集需记录协议版本切换点；装置一致性在 B 与 B2 之间仍成立（唯一差异仍是环有无）。

## v0.9.46 · 2026-11-20 · 分叉改为水平面平铺（不再向上长成树）

用户实测："不要把分叉路口垂直向放置，人类习惯水平向的平面"。v0.9.38 的共干→簇分叉点→细枝拓扑不动，仅调几何把候选铺到同一个水平带：候选高度起伏 0.9/0.42/2.7→0.22/0.14/0.7（siblingLift 从成树的 2.7 降到 0.7），分叉点抬升 0.22→0.08、主干/簇骨架/细枝 bend 抬升全面贴平（0.3/0.28/0.35→0.10）；同簇兄弟改靠**深度前后错落**（siblingR ±0→±3.4m）在水平面内分开，而非上下堆叠；整体左右展开 0.92→0.72 让外侧候选往屏幕中间聚；路牌宽 2.9→2.6。牌面仍 billboard 正对相机（文字可读所需），"水平面"指拓扑布局。牌高偏移 +2.7、拾取、机位贴轨、管透明度 [0.14,0.5]、半径不等、高度非单调、同簇角度近异簇远等契约全守住，`test_tree_fork.js` 17/17。执行链/账本/到达牌/中断态零改动。

## v0.9.45 · 2026-11-20 · 输入焦点让位 + 分叉几何收敛（可用性修复）

用户实测反馈两处可见问题，本版修复。均无执行层/账本/机位/轨道/到达牌/中断态改动，P1–P4 与实验操纵一致性不变。

- **"继续深化里打字冒出两个屏幕"= 全局快捷键误触发（真 bug）**：全局 keydown 监听旧版只排除 `msgInput`/`customDirInput`，漏掉结果卡 `rcFollowInput`（继续深化）与底部 `dockAnswerInput`（回答）。在这两个框里打字，字母 `v` 误触发立体分屏（水平两屏）、`t` 误开时间线、`d` 误开溯源链、`r/i/c/z` 类似。修复：keydown 入口加聚焦守卫——任何 `INPUT/TEXTAREA/contentEditable` 聚焦时单键快捷键一律让位，`Escape` 例外（仍可停止生成/收面板）。诊断 `diag_ui_issues.js` 实测 v/t/d 误触发 false→修复后全程 false。
- **"分叉像麻花交织"= 树状分叉几何收敛（保留 v0.9.38 拓扑）**：共干→簇分叉点→细枝的两级树结构不动，收敛几何参数——簇骨架 bend 横向甩动 ±0.22→±0.09、抬升减半；同簇角分散 intraSpread 0.30→0.13；细枝 side ±0.18→±0.06、lift 0.35→0.26；同簇兄弟高度分层 2.2→2.7（改靠上下错开区分）；路牌宽 3.4→2.9。牌高偏移 +2.7、拾取、管透明度 [0.14,0.5]、半径不等、高度非单调等不变量全守住。`test_tree_fork.js` 17/17、`test_keyboard.js` 22/22。

## v0.9.44 · 2026-11-19 · 跨轮语义衰减只读投影进账本（Q-d，P3 多轮扩展）

把 buildSessionDigest 的真实轮筛选 + tail 截断抽成共享纯函数 `digestRealRuns()/digestKeptSeqs()`（单一真相源，与 Q-a golden 校验同一套逻辑），避免投影与摘要逻辑漂移。每条 run 收尾时写只读字段 `digest_kept_seqs`——记下"本轮结束时语义视野内有哪些真实轮 seq"，让"某轮何时掉出模型上下文"可追溯。JSON 全字段导出自动带；CSV 增列 `digest_kept_seqs`。

**不新增完成信号**：该字段是 _runs 内容 + tail 算法的纯派生投影，不参与 status/completion/门控/主轴任何判定，性质等同 internal_state_dist。3D/机位/轨道/到达牌/中断态零改动。研究文档 CROSS-TURN-PROGRESS §4b/§7 Q-d 同步。

## v0.9.43 · 2026-11-19 · M2 指纹环单变量对照入口（B2 组 + 采集工具专项题）

把 v0.9.42 的 3D 指纹环纳入 M2 真人检验：新增 **B2 组**（与 B 唯一差异=隐藏指纹环），纯呈现层门控，不改执行/账本/机位/轨道/到达牌。配套 `tools/m-instrument.html` 增加指纹环专项量表与导出字段。

- **B2 门控（`?mode=no-fingerprint`）**：入口处 `window._noFingerprint=true`；指纹环生成点只 `if(!window._noFingerprint)` 包住**生成块**（不 return，后续铺路/直道逻辑照常执行）。`internal_state` 仍随 detail 进账本（B/B2 账本完全一致），仅 3D 环这一路呈现关闭。测试钩子 `noFingerprintMode`。
- **专项测量（用户选「主量表+专项题」）**：s1–s7 主量表一字不动；新增 f1（P4-内部：看到内部处理线索）/f2（P1-信任：更相信真计算）/f3（P3-追溯：理解上一步怎么走到这里）三题，仅 B/B2 作答；新增行为项 `fp_noticed`（是否注意到指纹环）。非 B/B2 写 null，CSV 列保留值留空=缺值，不与历史数据混算。
- **数据完整性**：`btnNext` 复位所有 radio + label.on，防同一浏览器连续记录时选中态残留污染 B2 对照（尤其 fp_noticed 这类「本次是否真看到」项）；`toCSV` 增列 f1/f2/f3/fp_noticed，汇总表与 M3 清单同步加行。
- **分组入口（用户选「手动覆盖组」）**：B2 不进随机池（随机仍 A/B 各半），实验员手动覆盖并写 `arm_override=true`；B2 非 deception（无隐瞒执行层，仅隐藏一路装饰性内部状态呈现），不触发 debrief 伦理流程。
- **验证**：`test_no_fingerprint.js` 8/8（B 有环 / B2 无环、forkTopology 完全一致、账本 internal_state 仍 available、0 JS 错误）；采集工具内嵌 JS 语法检查通过。TL_VERSION→v0.9.43。
- **诚实边界**：f1 题项只问「是否看到内部状态线索及感受」，不问「能否读懂某专家含义」（专家 ID 无名，避免诱导报告不存在的可解释性）；B2 保留 2D 账本 internal_state 凭据，单变量仅指 3D 环有无，实验解读不得外推为「去掉全部内部状态呈现」。

---

## v0.9.42 · 2026-11-19 · 3D 指纹环编码进语义分叉树（方向③收官）

承接 v0.9.41 的真指纹，用户选 C 把信号编码进 3D。纯呈现层，不改机位/轨道/到达牌/拾取契约。

- **★ 诚实偏离（相对设计 §2.2）**：原提议「按候选细枝分指纹强度」被推翻——候选还没执行、没有 per-candidate 指纹，把上一步的整轮指纹贴到新候选=冒充。改为**指纹环吸附「现在」节点**（已走过的到达点），语义=「你用什么内部状态走到这里」，是 P3 追溯凭据，与前方待选候选严格分离。
- **实现**：`buildFingerprintRing` 512 段径向条竖直盘（段长/颜色按 dist[i]/max）+ 底环 + 可点核心（`branchId=-6` 独立拾取，不进分支数组）；animate 每帧 billboard 正对相机（只转环自身，不碰相机/camAnchorYaw）；相机<1.2m 自动隐藏避免贴脸。`pickFingerprint`→`showFingerprintPanel` 展开 512 条直方图 + 来源标注。available 才生成，首次提问不伪造。
- **位置迭代**：水平环→俯视压成横带；钉 cur 正上方→相机贴脸出画（诊断 ndcZ>1、camDist 0.15m）；自由侧移→压路牌；最终吸附「现在」节点 + 近距离守卫，真实落位（camDist 6.76m）环在屏幕中央、半径 85px、读数清晰不压路牌。
- **验证**：`test_fingerprint_3d.js` 18/18；全量回归 tree_fork17/rail_camera14/internal_state14/e2e8/timeline42/keyboard22/scenery21/session31 全过，3D 不变量零回退。TL_VERSION→v0.9.42。
- **研究纪律**：专家 ID 无名（人读模式差异非语义）；方向③四步全部完成，后续属新主题需另立项。

---

## v0.9.41 · 2026-11-19 · 真实专家指纹采集管线接通（A 完成）

承接 v0.9.40 的 2D 凭据层，把后端真实采集管线接通——**真实 execute 的账本第一次拿到 available 的 MoE 专家指纹**（此前恒 unavailable）。纯数据层，不改 execute 语义、不碰 3D 不变量。

- **前置解除**：8083 主力（Qwen3-Coder-Next / 512 专家 / 48 层）经用户授权打上 `--expert-stats` 补丁，写入 `start-local-primary.bat` 持久化（看门狗重启仍带参数），`/experts` 返回 200。判决实验正面：同 prompt r=0.986、同语义簇 r=0.385、跨簇 r=0.058。
- **采集模块** `backend/expert_state.py`：纯函数 `aggregate_fingerprint`/`finalize` + 异步 `snapshot_total`；端点推导、来源元数据（`llm-expert-stats`/`/experts`/model/512/48/温度 0.6/captured_at/delta/hits）；6 类诚实降级（capture_disabled/source_not_llm/interrupted/no_new_expert_activity/并发守卫/长度不符）。
- **生成段采集（勿回退）**：`task_tracker._llm_stream` 新增两个只读回调，首个真实 token 到达（prefill 完成）取 before、生成完成取 after，差分只覆盖生成段。★ 根因诊断：裸问题 r=0.978，套执行长模板塌到 0.636（模板 prefill 淹没任务信号，delta ~90→~340）；钉在生成段后真实 execute 判别力 **r_same=0.990 / 异题 max=0.079**，比判决实验更干净。诊断脚本 `D:/tools/diag_temp_effect.py`/`diag_template_effect.py`。
- **透传修复**：`server.run_execute` 透传 `result.internal_state` → execute_done；前端 `onExecuteDone`/中断分支/`arrivalDetail` 三处补齐透传（漏传=三轮审查 completion 断点同款，会让真指纹恒降级）。`TL_VERSION`→v0.9.41。
- **验证**：`test_expert_state.py` 25/25、`e2e_expert_execute.py`、`verdict_via_execute.py`（P4 成立）、`ws_e2e_internal_state.py`（真实 WS）、`test_internal_state_e2e.js` 8/8；关键回归 internal_state14/timeline42/tree_fork17/rail_camera14/session_continuity31 全过。
- **诚实边界**：温度 0.6（execute 实际值）如实标注，非判决实验的 0；P4 模式宣称基于生成段判别力实验，专家 ID 仍是训练涌现的无名 ID（人读模式差异，不读「这个专家管医学」）。

---

## v0.9.40 · 2026-11-19 · 内部状态指纹凭据层（2D，诚实降级）

方向③（把真实激活编码进 v0.9.38 语义分叉拓扑）的第一步：**先落地 2D 凭据层**，纯数据层、不碰 3D。
配套研究：`docs/PROBE-ACTIVATION-VIZ.md`（隔离探针）+ `docs/ACTIVATION-IN-FORK-TOPOLOGY.md`（设计 + 判决反转）+ `tools/activation-topology-demo.html`（真实数据 demo）。

- **★ 判决反转**：探针原判「路由是噪声」被推翻——那个结论用了逐 token 尾部 16 条采样（噪声层）+ 256-token 滑窗污染。干净实验（重启清窗、温度 0）证明：同 prompt 重跑聚合分布 **r=1.000**，不同 prompt 两两 **r=0.017–0.157**。即「逐 token 是噪声，整段聚合专家分布是稳定的 prompt-specific 真实指纹」。
- **账本凭据字段**：`recordRun` 每条 exec 增加 `internal_state`，只认后端 execute_done 下发的 `detail.internal_state`，缺省 `{status:'unavailable',reason:'not_collected'}`；规范化函数 `normInternalState` 严格校验（空/非数值 dist 一律降级，不让垃圾数据冒充 available）。与 source 四态、decorative/synthesized 正交。
- **2D 详情可核对**：时间线详情增「内部状态指纹」行——available 显示专家数/层数/温度/Top + 「展开核对」按钮（60 维指纹条 + 来源/端点/模型/采集时间）；unavailable 明写「当前服务未开放 expert 路由统计，不伪造指纹」。
- **导出**：JSON summary 增 `internal_state_available` 计数；CSV 增 `internal_state_status/source/dist/top` 四列。
- **诚实边界**：当前 8083 主力无 `/experts`（未打 expert-stats 补丁），所以真实运行时该凭据恒为 unavailable——**绝不伪造**。采集管线（后端探测 + 主力打补丁）留待大模型复测有正面结果后再接，避免用真数据演新剧场。
- **测试**：新增 `test_internal_state.js` 14/14（缺省降级/available 渲染/残缺数据守卫/导出/3D 不变量）；`test_timeline.js` 42/42（版本号断言改为格式校验，future-proof）；tree_fork 17/17、rail_camera 14/14、copy_naturalness 12/12 无回退。repo↔LIVE 已同步。

---

## v0.9.39 · 2026-11-19 · 路牌文案去机械化（内容层 + 呈现层）

用户进一步澄清：v0.9.38 改的是分叉**几何**，但「机械」其实在**路牌文字表述**——四条路牌的
副标题/底栏是同一个模子。核实真实推演文案，根因两处：① 后端生成 prompt 的示例本身就是套话
（`查相关数据|结论要有依据|检索,整理|更准确`、`…|用户关注的外部环境|…|贴合主题`），小模型照抄，
且「为什么」与「理由」两列语义重叠导致 sub/rationale 同质；② 前端四处候选牌统一
`N 步可达 · 双击出发` / `从这一层深入` 兜底模板。

- **后端 prompt 重写**（`forecaster/llm_forecaster.py`）：示例换成自然口吻并明确「考虑 vs 换来什么」
  要错开、禁套话词、steps 要带业务对象；配套放宽解析截断（steps 8→14、sub 30→48、rationale 24→36、
  max_tokens 200→340），否则完整句被截成半句。
- **套话解析后兜底** `naturalize_copy()`（纯函数）：只替换命中套话的 sub/rationale 与裸动词 steps，
  素材只取真实 topic/anchor/用户短语/label（不编造），按索引轮换模板避免「修完又整齐划一」；
  好文案一字不动。真实验证：风电误差来源四条候选的考虑/动作/换来各不相同且带真实对象
  （模型版本/极端天气/SCADA/塔影），套话消失。
- **本地兜底模板** `DIRECTIONS` 六条 sub/rationale 改成各自口吻（不再套同一「围绕X兼顾Y」壳）。
- **前端文案去模板** `signCopy()`（纯函数，`index.html`）：候选牌 sub 优先自身内容、rationale 次之、
  全空才按索引取中性句；底栏六套操作措辞轮换 + 写入候选首步动作，保留「双击」可点契约。
  五处候选牌调用点（直道/顺序/choice 树状/未来牌/自定义继续）全部接入；牌高 +2.7、机位/轨道/
  到达牌零改动。真实截图确认四牌文字各异、无统一套话。
- **测试**：`test_copy_naturalness_backend.py`（18/18，纯函数确定性）+ `test_copy_naturalness.js`
  （12/12，真实推演 + 合成样本 + 不变量）。关键回归：前端 10 项、后端业务词绑定/会话连续性/
  三轮审查全过。
- 测试钩子：`signCopyForTest(c,i)` / `signCopiesOfCurrent()`；后端 `naturalize_copy` / `_is_cliche`。

## v0.9.38 · 2026-11-19 · 语义树状分叉（分叉形成自然化）

用户反馈「3D 空间演进路线中分叉的形成有点机械、不够自然」。定位到四个根因：① 所有岔路从当前点
一点放射（像扇骨）；② 终点等半径、角度均匀铺开（梳齿）；③ 每段弧度/粗细/亮度完全一致；
④ 后端已下发的 `clusters`（真实语义聚类）只用于凭据条/对照/时间线展示，**从未进入 3D 几何**。

- **用真实 clusters 改拓扑为两级树**：共干（所有候选共用）→ 簇分叉点（同簇共用）→ 候选细枝。
  同簇候选先一起走一段再散开，异簇在更早的总岔点分开；`clusters` 缺失/用户自定义候选各自成簇，
  走同一套拓扑（不伪造聚类）。
- **pos3d 决定非均匀几何**：语义距离决定细枝半径（不再等半径圆弧）、簇内角度（近的挤、远的散）、
  终点高度与弧度侧偏（每段控制点抬升/侧偏不同）；同簇内部再上下分层，避免兄弟牌互相遮挡；
  终点高度不再随 rank 单调爬升成一条斜线。
- **视觉语义分层**：共干/簇分叉段为中性蓝实线、非候选专属（负 branchId，不参与拾取、不被走过时熄灭）；
  只有候选细枝带候选色 + 待选虚线（正 branchId），保持「走过 → 虚线熄灭、实线补亮」契约。
- **不变量保持**：牌高偏移仍为 +2.7（点击/拾取测试不动）、机位/轨道/到达牌零改动、不新增完成信号、
  `source` 四态与 P1 账本口径不变；`?mode=opaque` / `?mode=decorative` 与 B 组共用同一套几何，
  逐像素一致性不受影响。
- **回归**：新增 `test_tree_fork.js`（17/17：共干/簇分叉/细枝数量、簇内近异簇远、非等半径、
  非单调高度、拾取命中、虚线熄灭、clusters 缺失回退、0 JS 错误）。

---

## v0.9.28 · 2026-11-16 · 去除假进度剧场 + 真·轨道相机 + 分叉信息深度绑定

回应用户现场反馈的三个体验问题，均为执行层/信息层改动，不新增完成信号、不伪造数据。

- **① 移除「预览车队」假进度剧场**：左上角「智能体状态·预览车队」百分比面板 + 每条岔路的
  半透明「代跑」小车（`p.t` 从 0→100 无限回环、到 100 不展示结果就重来）纯装饰、不对应任何真实工作，
  与 P1「不伪造进展」冲突。整体删除 DOM(`#agentPanel`)/CSS/构建与动画函数/每帧更新/清理调用/getter；
  真实进展凭据仍由常驻 HUD（第 N 步·结论+来源+耗时）承担。
- **② 真·轨道相机（把机位当轨道上的小车）**：旧版机位 = `currentPos − forward(camAnchorYaw) × cam.dist`
  是直线射线，轨道却是 journey 节点连成的折线——拐弯处切出弯道、末段短于 11m 时越过上一节点飘到空处。
  改为沿已走轨道折线回退 `cam.dist` 弧长取点（拐弯贴轨、短段夹到轨道起点），眼位仍钉 1.35m、
  视线仍由 `cam.yaw` 自由控制（机位与视线解耦不变）。无轨道时回退直线公式，`camOffRail` 判据改为
  「机位到轨道折线的最短水平距离」，更能抓到真脱轨。新增 `test_rail_camera.js`(14) 验证贴轨/
  不越界/拖拽机位零位移。
- **③ 分叉信息深度绑定实际任务**：本地兜底/快速通道的 `sub`/`steps`/`rationale` 旧为固定套话
  （「核对口径」「整理要点」「结论有依据」），每个候选只复用同一个 anchor。现织入用户原话里的
  **第二个真实业务短语**（companion），四个候选各锚定问题不同侧面、读起来是不同走法；只有一个业务
  短语时用方向专属诚实角度词（公开资料/实测数据…）兜底，不冒充模型、不编造业务事实。`label` 格式
  与全部契约不变。LLM 提示词同步要求 sub/steps/理由引用具体业务对象、禁用通用套话。

回归全绿：test_honesty 5 / sign_topics 17 / context_pull 14 / verify_opaque 22 / rail_camera 14 /
keyboard 22 / scenery / compare 27 / timeline 42 / cancel 33 / practical 16；Python topic_binding /
diversify / e2e_diversify 全过。3D 不变量（camOffRail≈0 / 眼位 1.35 / 结果牌 -1.05 / 轨道 0.7）零回退。

---

## v0.9.27 · 2026-11-16 · LLM 端点统一切 8083 + 测试基础设施真超时修复
- **本地 LLM 收敛为单一主力模型**：`8083 / local-primary`（llama.cpp，ctx 32768）。
  8082（35B）退役。全部默认值与文档同步：`server.py`（`LLM_BASE_URL`/`LLM_MODEL`）、
  `llm_forecaster.py`（默认 base_url/model）、`task_tracker.py`（自检块）、`test_cancel_e2e.py`
  （HEALTH 探针）、`memory.py`（演示旅程 meta）、README 环境变量表、DESIGN 架构图/启动命令、
  M-EXPERIMENT 复现清单、5 个测试脚本注释。
- **修复系统性测试 bug：`waitForFunction` 两参调用**（22 个文件 / 68 处）：
  Playwright 签名为 `waitForFunction(fn, arg, options)`，两参写法 `waitForFunction(fn, {timeout})`
  中 options 被当成 `arg`，**真实超时恒为默认 30s**。此前未暴露只因旧 35B 执行 ~13.7s 恰好在
  窗口内；新主力模型真实执行 25–55s，静默超时 → `runs[0]` 尚未出生 → 走查误报 FAIL。
  全部改为三参 `waitForFunction(fn, null, {timeout})`。
- **`walkthrough_real.js` 澄清重试**：新模型对模糊任务可能以「反问澄清」（clarify，合法四态）
  收尾；代理被试如实记录该轮后补具体化追问重新真实执行（最多 2 次），仍 clarify 则如实 FAIL。
- **验证**：真实 8083 端到端 `walkthrough_real.js` **15/15 全绿**（done / 161 字 / chain=["output"]
  / future=4 / P0 真中断）；REST 推演 `source=llm` 且候选绑定真实业务；直连 executor 流式 219 字；
  11 套回归全绿（opaque 22 / honesty 5 / sign_topics 17 / context_pull 14 / cancel 33 /
  timeline 42 / practical 16 / compare 27 / keyboard 22 / scenery 21）。
- **不变量零回退**：不新增完成信号、不碰相机/路牌/中断态、`?mode=opaque` 一致性保持、
  clarify 仍按四态如实记录（重试只是代理被试补答，不改产品判定逻辑）。

## v0.9.26 · 2026-11-16 · Embedding 决策落地 + 工程可复现性收口
- **Embedding 决策从「待定注释」变「可插拔」**（回应评审优化#4）：`forecaster/core.py` 定义
  `DIVERSIFY_EPS_HASH=0.60`（hashed-TF 词面近似）/ `DIVERSIFY_EPS_SEMANTIC=0.38`（真实 embedding 语义档）；
  `LLMForecaster` 与 `server._build_forecaster` 均按 `uses_semantic_embedding()` 自动选档；
  `/api/health` 如实上报 `embed_provider`（`semantic`/`hash`）与 `embedding_model`。
  默认诚实近似（eps 0.60），配 `LLM_EMBEDDING_MODEL` 即切语义档（eps 0.38），只改环境变量不动代码。
  默认档行为零变化（`test_diversify` / `test_e2e_diversify` ALL PASS）。
- **补 `package.json`**（评审必修#1 收口）：声明 `playwright-core` devDep + npm scripts
  （`test` / `test:opaque` / `test:honesty` / `regression`），补齐 Python 之外的 JS 依赖清单。
- **工程可复现性**：统一端口 8770、CORS 白名单、`/api/journeys` 字段校验、WS 透传 k/fast、
  净化规则单一来源、SQLite WAL、`verify_opaque.js`(22)/`test_honesty.js`(5) 常驻回归、
  `chrome_helper.js` 去硬编码浏览器路径、`start-watchdog.bat`/`DESIGN.md`/测试注释去绝对路径（便携）。
- **不变量零回退**：不新增完成信号、不碰相机/路牌/中断态、`?mode=opaque` 一致性保持。

## v0.9.25 · 2026-11-14 · 风景→上下文闭环（回应 GPT 评审）
- **产品缺口**（GPT 评审点名）：原型已能记录一轮轮探索，但「这轮的发现如何改变下一轮」偏薄——v0.9.20 风景可点后只能回看来源、不能把发现带进下一步。
- **风景可纳入**：`#scnPanel` 加「＋ 纳入本轮上下文」按钮 → `addContextTag(text, src)`（去重幂等），顶部「本轮纳入」标签条 `#contextTags` 可核对、可 × 移除。
- **纳入即改变下一轮**：`buildExploreContext` 以半角括号包裹注入推演上下文；后端 `pool=[topic]+sides` 锚点轮换使该短语成为下一批准牌动作对象，路牌随之改变。
- **用户主动塑造、系统不自动塞**：「近」≠ 正确方向，关联必须用户点按钮纳入；`runForecast`（新提问）清空 `_contextTags`。
- **诚实边界不变**：`source=local` 照旧、凭据条仍标「模型未参与」；纳入短语来自用户上下文，真实可核对。
- **回归**：`test_context_pull.js`（14 项全绿）；全套 practical/keyboard/scenery/compare/cancel/timeline 全绿。

## v0.9.24 · 2026-11-13 · 路牌业务词修复（P1 真实性回归点）
- **根因**：v0.9.22 把「下一方向」牌全切 `fast=1` 后 100% 走 `_local_forecast`，旧 `intent_map` 是硬编码万金油动作（写代码/查文档/对比分析…），主题词只在兜底分支用且正则抽不到裸主题 → 退化成「你关注的这件事」。
- **修复**（`forecaster/llm_forecaster.py`）：新增 `_extract_business_phrases()`；删除 `intent_map`，改「动作族 × 真实业务短语」（检索/拆解/对照/核算/落地/汇总）；彻底移除占位符；元数据边界修复。
- `buildExploreContext` 加厚：带上一轮真实 llm 产出 `[prev]`（仅 `source==='llm'`，P1 红线）。
- **回归**：`forecaster/tests/test_topic_binding.py`（8 组）、`test_sign_topics.js`（17 项）。

## v0.9.23 · 2026-11-13 · 实用化（透明度系统从「藏面板」变「常驻可见」）
- 常驻实质进展 HUD（`#progressHud`）、对话关键发现脊柱（轨道里程碑）、决策溯源链（`#decisionChain`，D 键/顶栏）。
- **回归**：`test_practical.js`（16 项）；轻量 keyboard/scenery/compare 全绿。

## v0.9.22 · 2026-11-13 · 未来牌 fast 通道
- `autoExploreNext` 改走 `&fast=1` 本地通道，未来牌 17ms 秒级铺出（原完整推演占 35B 单槽 21.6s）。`proofKind` 诚实标本地兜底，不冒充 llm。
- ⚠️ **已知回归**：此版使未来牌 100% 走本地兜底，埋下 v0.9.24 的「路牌空洞词」回退（已修）。

## v0.9.21 · 2026-11-13 · 实验使能钩子
- 原型加 `?mode=opaque` 使能 A 组「执行不透明」（仅隐藏 P2/P3/P4 呈现层 + `#progressHud #decisionChain`，真实执行保留）。M1 实验操纵。

## v0.9.20 · 2026-11-13 · 风景可点（P2 收口）
- 沿途语义风景从「纯背景」升级为可点击回看（`pickScenery`/`focusScenery`/`#scnPanel`），`src` 诚实标注来自哪段上下文；机位不动、行驶中门控。

## v0.9.16–v0.9.19 · 2026-11-13 · 中断态 / P1–P2 信息层
- v0.9.16 中断为第三态（cancel→cancel_ack→execute_done{interrupted}）；v0.9.17 P1 逐轮账本 + 时间线对照/分叉重走/导出；v0.9.18 P2 候选并排对比 + 自定义方向；v0.9.19 键盘等价视图。

## v0.9.12 · 2026-11-11 · 路线 B 诚实降级（核心修复）
- 删除剧场中间链，执行收敛为单步真实 LLM + token 流式；进度 = 真实输出字数。运行时复测：90–100ms 指纹消失、token 流覆盖 60–70%、P1–P4 全绿、9 测试全绿。

## v0.9.6–v0.9.9 · 2026-11-06～09 · 呈现层四轮迭代（拐点）
- 候选数透传 / 多智能体车队 / 沉浸立体 / 语义分桶。用户反馈「界面上没有实质性进展」→ 催生本研究项目（执行层真实性优先于呈现层）。

## v0.9.0 · 原型起点
- 3D 路径空间驾驶舱骨架：岔路、候选、行驶、到达牌。
