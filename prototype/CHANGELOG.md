# 变更日志 · CHANGELOG

> 本文件是 `prototype/` 实证原型的**版本事实源**（按版本倒序）。
> 设计 / 架构见同级 `DESIGN.md`；研究背书见仓库根 `docs/`。
> 不变量红线贯穿所有版本：不新增完成信号、不伪造数据、不碰相机公式 / 路牌几何 / 中断态；
> `?mode=opaque` 实验操纵一致性保持。

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
