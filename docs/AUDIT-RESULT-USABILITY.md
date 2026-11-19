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
