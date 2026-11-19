# 变更日志 · CHANGELOG

> 本文件是 `prototype/` 实证原型的**版本事实源**（按版本倒序）。
> 设计 / 架构见同级 `DESIGN.md`；研究背书见仓库根 `docs/`。
> 不变量红线贯穿所有版本：不新增完成信号、不伪造数据、不碰相机公式 / 路牌几何 / 中断态；
> `?mode=opaque` 实验操纵一致性保持。

---

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
