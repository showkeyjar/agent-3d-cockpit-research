# 审计补充：结果可用性（P0）—— 从「模型吐了字」到「用户拿到结果」

> 2026-11-19 · v0.9.30 · 承接 `AUDIT-CONTEXT-POLLUTION.md`（v0.9.29 任务类型门控）
>
> 触发：用户从「实际使用大模型拿到结果」的诉求提出——系统很多功能不够"实用"，
> 而"实用"应定义为**能真正指导用户拿到结果**。本审计给出证据、断点诊断、四层修复与验证。

## 1. 核心判断

项目此前回答的是「进展是否**真实**」（P1 真实性 / P2 可核对 / P3 可追溯 / P4 可感知，
认识论），尚未回答「结果是否**有用**」（效用论）。这与当初「从呈现层退回执行层」是同一类
校准：3D 轨道、路牌、账本再精致，若用户拿不到一份能用的成果，P1–P4 的全绿意义有限。

因此新增 **P0 结果可用性**，逻辑上前置到 P1–P4 之前：连结果都拿不到、带不走、深化不了，
谈"进展真实可核对"是本末倒置。

## 2. 断点诊断（都有代码铁证）

对"从提问到拿到结果"的链路逐段量，四个断点全部集中在"结果"这一环：

| 断点 | 铁证（改动前） | 后果 |
|------|--------------|------|
| ① 产出层 | `task_tracker.py` 执行 prompt 硬写「150字以内、不要标题」，`max_tokens=220`，compose/analysis 共用 | 用户要"涵盖三方面的可执行条款"，只拿到摘要——系统判 done，交付物对用户无效 |
| ② 判据层 | `done` 语义仅"模型生成了文本"；P1 账本四态无"结果可用"维度 | 没有"用户目标是否达成"的判断，done 与"拿到结果"被混为一谈 |
| ③ 交付层 | 结果卡操作仅 重试/回退/换路/重新推演；无复制、无交付导出；JSON/CSV 导出是**研究凭据**（来源/分支） | 用户拿到结果却带不走，不能复制、不能导出成文档 |
| ④ 迭代层 | 单次生成即终止，clarify 回答只是补数据 | 不能"基于这个结果再展开/改写/深入"，从摘要到成稿无路径 |

## 3. 修复（v0.9.30，四层）

设计总纪律：**新增独立 `refine` 通道 + 规则判据，完全不碰 execute 主链与 3D 不变量**。
3D 要点流（150字/220token）为播放节奏保留，完整成果走二次生成，不破坏已稳定的时序测试。

### 交付层 —— 结果可带走
- 结果卡新增「复制结果」「导出成品（.md）」按钮，仅当 `hasReal`（真实 LLM 产出）时出现。
- 导出内容是**给用户用的成品**：原始任务 + 采用路径 + 达成度 + 来源 + 耗时 + 正文。
  与时间线 JSON/CSV（研究数据，含来源与分支标记）明确分开。
- 剪贴板优先 `navigator.clipboard`，降级 `execCommand`。

### 产出层 —— 分层交付
- 3D 上仍是 150 字要点流（节奏不变）；结果卡新增「展开完整成果（400–800字）」。
- 点击走 WS `refine{mode:'expand'}`，后端 `AgentExecutor.refine()` **真实再次调用 LLM**
  （同一 `/chat/completions` 流式接口，`max_tokens=1200`），把要点扩成可直接用的成果。
- 绝不拼模板冒充生成；中断/忙/失败一律 `ok=False` 如实呈现。

### 迭代层 —— 结果可深化
- 结果卡新增输入框 +「继续深化」，发 `refine{mode:'followup'}`，把上一轮真实产出作为上下文
  继续改写/展开/换格式。
- `refine_done` 作为带 `parent_run_id` 的新一轮进 P1 账本（`chain:['refine:…']`），形成追问链。
- 深化是结果卡内的事：**不铺到达牌、不改机位**，符合「2D 不劫持 3D」纪律。
- `recordRun` 把 `run_id/seq` 写回 detail 对象，深化据此建立准确的父轮链。

### 判据层 —— 完成度自评
- 新增三档达成度 `achieved / partial / need_input`，**规则判据** `judge_completion()`
  只依据已确定字段（clarify/interrupted/ok/source/output），单测确定、P1 账本可复算。
- 模型自评（`[达成度: …]`，refine 时解析）作为**独立附加信号**记录，不覆盖规则判据。
- 结果卡显示达成度徽章；`_runs` 的 `exec` 增 `completion/self_rating`；
  导出 JSON/CSV 增 `exec_completion/exec_self_rating`，summary 增达成度分布与 `refine_runs`。
- 保存到后端 journeys 的 meta 同样带达成度，供 M 实验采集。

## 4. 验证

- **后端 WS 集成**（`test_p0_backend.py`，真实 LLM）：起草类 `completion=achieved` 直达成果；
  `refine(expand)` 回 `refine_done`，产出 770 字完整成果，`completion=achieved`、
  `self_rating` 回传；refine 期间无误发 `execute_done`（不干扰主链）。ALL PASS。
- **前端回归**（`test_p0_frontend.js`，钩子驱动）：15/15 —— 达成度三档渲染、
  有成果才显示深化工具、澄清卡不显示深化、复制/导出按钮、导出预览来自真实 output、
  深化写回卡+进账本（父轮链）、导出 summary 含达成度统计。0 JS 错误。
- **既有回归**：test_keyboard 22/22、test_timeline 42/42、test_clarify_guidance 全通过。
- **既有测试时序问题（非本次回退）**：`test_rail_camera` 偶发 13/14 或 12/14，失败项在
  「眼位 1.35m」「camOffRail≈0」间漂移。用改动前的 HEAD 版本连跑 3 次同样 FAIL（eyeY 在
  1.30–1.34 波动），证明是机位阻尼未收敛就断言的**测试时序敏感**，与本次改动无关。

## 5. 对研究结论的影响

- P1 账本从"四态"扩为"四态 × 达成度"二维：`status` 记执行链走到哪，`completion` 记对用户
  目标达成到哪。二者正交——一次 `done` 可能只是 `partial`（150 字摘要），一次 refine 后
  才 `achieved`（可用成果）。
- M2 对照实验的量表可新增一维：**"是否拿到可用结果"**（P0），与 P1–P4 的进展感知分开度量。
  这正是用户诉求与既有研究假说的交汇点。
- clarify 的定位不变（合法第四态、资产）：`need_input` 达成度如实标记"待补输入"，
  不把它伪造成"部分达成"。

## 6. 改动落点

- 后端：`backend/task_tracker.py`（`judge_completion`、三态常量、`AgentExecutor.refine`、
  三个 return 带 completion）、`backend/server.py`（import、`refine` 消息分发、`run_refine`、
  `run_execute` 回传 completion）。
- 前端：`index.html`（rcDeliver/rcCompletion/rcRefining/rcExpandBtn/rcFollowInput DOM、
  `showResultCard` 渲染与复位、复制/导出/展开/追问函数、WS 三分支、`recordRun` 写回 seq、
  导出扩字段、P0 测试钩子）。
- 测试：`test_p0_backend.py`、`test_p0_frontend.js`。

---

## 7. 二轮审查：从「拿到单轮成果」到「拿到可用终版」（v0.9.35）

> 2026-11-19 系统审查。方法：全链路走查「提问 → 推演方向 → 执行 → 拿结果 → 核对/带走/深化 → 多轮形成终版」，
> 逐个定位「声称 vs 实际」断点。三条均有代码铁证，且不在 §1–§6 已修清单内。
> 明确区分：前端 completion fallback（`index.html` 与后端 `judge_completion` 判据有差异）经核对
> **不是断点**——后端强制下发 completion、正常路径不触发兜底，两处等价，故不改。

### 断点 A（中高）：refine 完整成果成孤岛

- **铁证**：`onRefineDone` 只写 `_arrivalResults.set(-2, refineDetail)`；到达牌
  `sign.userData.arrivalDetail`（`addArrivalMarker`）与主轴节点 `journey[].arrivalDetail`
  仍指向旧 150 字摘要对象；结果卡联动按引用匹配 `arrivalDetail === d` 对新 detail 失败。
- **后果**：用户「展开完整成果」拿到 400–800 字终版后关掉卡，再从 3D 到达牌/里程碑点开，
  看到的还是旧摘要——完整成果带不走、回不到主线。
- **修复**：refine 成功后把到达牌/主轴节点的数据引用同步到 refineDetail 并重铺里程碑文字；
  ★ 只改数据引用，**不新铺到达牌、不改机位/轨道、不动账本历史**（账本已有 refine 独立轮）。
- **验证**：`test_refine_sync.js` 10/10（含 3D 重开仍是完整成果、牌数不变、账本 +1）。

### 断点 B（中，真 bug）：达成度与「有无产出」判据打架

- **铁证**：`showResultCard` 的 `looksLikeLog = /^已(检索|生成|整理|输出|校验)/.test(raw) || raw.length < 8`
  使 `hasReal=false`；但后端 `completion=achieved` 优先采纳 → 同一张卡既显示「目标达成」，
  正文又说「这次没有拿到模型生成的答案」，复制/导出工具被隐藏。
- **根因**：`looksLikeLog` 是路线 A 剧场的失效残留——路线 B 的 `HONEST_FALLBACK`
  早已无「已检索」文案；该正则会误伤真实 LLM 的短答案（如「用方案A」）
  与以「已生成…」开头的正文。
- **修复**：`hasReal` 与后端 `judge_completion`（`task_tracker.py:94`）统一判据：
  `ok && source==='llm' && output非空 && 非 '[' 开头`，删除失效正则。
- **验证**：`test_completion_consistency.js` 16/16（短答案/「已生成」答案一致，
  local 失败/clarify/`[`开头仍如实无产出）。

### 断点 C（中）：多轮成果只有拼接、没有可交付终版

- **铁证**：`exportAllDeliverables` 仅对真实轮逐条 `lines.push` 拼接，无综合/去重/终版标记；
  要点版 + 展开版 + 各次追问全文一并堆入，用户不知用哪一版。
- **修复**：新增 `synthesize` 模式——把全部真实轮次原文作素材，经独立 refine 通道
  （真调 LLM，`mode=synthesize`）综合去重成一份终版；明确 prompt 纪律「只用素材、不引入新事实、
  矛盾并列保留」，成果标 `synthesized:true` 入账本、可复制/导出；不碰执行主链/3D/机位。
  素材只取 `done && llm && !decorative && output非空`，去重；C 组 decorative 轮不混入。
- **验证**：前端 `test_synthesize.js` 17/17（素材过滤/去重、WS 契约、synthDetail 标记、
  不新铺牌）；后端 `test_synthesize_backend.py` 5/5（真实 LLM 产出 318 字、mode 保留、
  不碰主链）。

### 对研究结论的影响

- P0「结果可用性」从「单轮可带走」扩到「多轮可汇成一份终版」，四断点修复后的能力更完整；
- P1 账本新增 `synthesize` 与 `refine` 两类二次生成轮（chain 明确标记、synthesize 无单一父轮），
  研究分析须把它们与「首次执行轮」分开统计，不得混作 P1 真实执行证据；
- 二轮审查再次印证主线判断：真问题集中在「结果 → 可用终版」链路与判据一致性，
  而非呈现层加码（与 EVIDENCE.md 结论一致）。
