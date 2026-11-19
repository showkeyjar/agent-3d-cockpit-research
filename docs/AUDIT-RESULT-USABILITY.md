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

---

## 8. 三轮审查：全链路 10 断点（v0.9.36）

> 2026-11-19 系统审查。方法：两路只读走查（后端执行/推演协议链 + 前端结果/数据链），
> 逐个定位「声称 vs 实际」断点；对每条亲自下钻核实代码后才动手。10 条全部有代码铁证，
> 且不在 §1–§7 已修清单内。修后另派只读 agent 复核修复本身，又补修 4 处不完整/过宽之处。
> 纪律不变：所有修复不碰 3D 机位/轨道/到达牌不变量，refine/synthesize 不劫持 execute 主链。

### A. 后端（5 断点）

- **断点1（高）refine 自评「待补输入」被硬判 achieved**。`hard_rules` 让模型在正文后写
  `[达成度: 待补输入]`，但 NEED_INPUT 识别只认「整段以 `[` 开头」，正文末尾标记落到
  `task_tracker.refine()` 成功分支被硬编码 `COMPLETION_ACHIEVED`——模型自认无解、系统记成功。
  修复：规则判据 `judge_completion` 独立算，`self_rating` 只作「就低不就高」降级信号；
  `_rating_means_need_input` 经复核收窄为精确标签（避免「仍缺细节」误降级）。
  验证：`test_audit_round3_backend.py` 判据 6 项。
- **断点6（高）共享 forecaster 单例来源串线**。`_forecaster` 单例的 `last_source`/`last_question_type`
  写在 sampler 上，并发 forecast（REST+WS / 两批路牌）时 A 的来源被 B 覆盖，local 冒充 llm。
  修复：`SpeculativeForecaster` 加实例锁把「采样→快照」串行化，来源/qtype 快照进
  `ForecastResult.source`，server 逐请求从 result 读（两处均改），不再事后读共享属性。
  验证：`test_audit_round3_source.py` 7 项（含双线程竞态快照）。
- **断点7（中）排队 execute 的 cancel 归属错乱**。连续两次 execute 时第二次排队，共享
  `cancel_event` 被覆盖 → cancel 只 set 排队轮，真正持锁在跑那轮 abort 后查旧 event 未 set，
  被误记 error/achieved。修复：每轮独立 event + `cancel_epoch`/`submitted_epoch`，cancel 只作用
  持锁活跃轮（`active_cancel_event`+`active_executor`），排队轮获锁后 epoch 落后则跳过并发诚实
  interrupted 收尾；活跃信号在 try 内登记、finally 清理（复核补修异常路径残留 + cancel_ack 语义）。
  验证：`test_audit_round3_cancel.py` 7 项（真 LLM，两轮均 interrupted/user_cancelled）。
- **断点8（中）refine 空素材无守卫**。synthesize/expand 空素材照常调 LLM → 模型凭 context 编造
  却判 achieved。修复：入口守卫 `prior.strip()` 为空直接回 `no_material`/`ok=False`/`partial`，
  不调模型。验证：`test_audit_round3_backend.py` 4 项。
- **断点9（中）超长素材静默截断**。真正的截断在前端 `startSynthesize` 的 `.slice(0,8000)`，
  旧版后端标注分支恒不触发、前端 note 也不读标注，仍谎称「综合全部轮次」。修复（复核后）：
  前端上报 `prior_truncated`，后端合并标注 `material_truncated` + 降 partial，前端 note 消费标注。
  验证：后端截断 3 项 + 前端 note 2 项。

### B. 前端（5 断点）

- **断点2（高）后端 completion 被丢弃**。后端 `execute_done` 明确下发 completion（749/766），
  但 `onExecuteDone` 透传字段无 completion → 结果卡/账本全走前端 fallback，need_input 永不出现，
  且 fallback 二要素判据与后端规则判据不一致。**此条推翻二轮审查「如实透传、两处等价」的结论**。
  修复：透传 `completion`。验证：`test_audit_round3.js` 3 项。
- **断点3（高）refine 通道交互死锁**。`_refineBusy`/`_synthPending` 唯一复位在 onRefineDone；
  error 分支、WS 断线、后端卡死均不复位 → 深化永久被拒、刷新才恢复（丢整段会话）。
  修复：统一 `resetRefineBusy()`，接 error/onclose/前端 90s 超时。
  验证：`test_audit_round3.js` 3 项。
- **断点4（中高）synthesized 标记未进账本 + 二次综合污染**。标记只写进导出时剔除的 `detail`；
  `collectRealOutputs` 不过滤综合轮 → 连续综合把上次终版当原始素材。修复：标记提升进
  `exec.synthesized` + CSV 列 + summary + 汇总 .md 标注；collectRealOutputs 排除综合轮。
  验证：`test_audit_round3.js` 5 项。
- **断点5（中）refine 后追问链断**。`refine_pending:true` 写入后全文件无清除，`rcDeliver`
  （含追问按钮）永久隐藏。修复：删除该写入（进行中态由 rcRefining 面板承担）。
  验证：`test_audit_round3.js` 3 项。
- **断点10（中）clarify 无条件推进 3D 主轴**。`finishExecution` 中 `markBranchTravelled` 无条件
  执行，与「澄清不算走过一步」注释冲突 → 补答后同 idx 再 push 一次、零长度 tube、undo 多退。
  修复（复核补修）：`markBranchTravelled` 与 `markCardsTravelled` 均加 `!detail.clarify`。
  验证：`test_audit_round3.js` 2 项（clarify 不增长 / 非 clarify +1 对照）。

### C. 复核补修（只读 agent 二轮发现）

- 断点9 截断源在前端而非后端（见上）；断点10 `markCardsTravelled` 漏改（见上）；
  断点1 匹配过宽（见上）；断点7 异常路径活跃信号残留 + cancel_ack.active 语义（见上）。

### D. 验证与影响

- 新增 5 个测试：后端 `test_audit_round3_backend.py` / `_cancel.py` / `_source.py`，
  前端 `test_audit_round3.js`；共 6+7+7+19 = 39 项全通过。
- 全量既有回归无回退：cancel 33、timeline 42、keyboard 22、decorative、rail_camera 14、
  refine_sync、completion_consistency、synthesize、clarify×3、p0、task_kind×2、p0_backend、
  synthesize_backend 全过。
- 研究结论影响：① 二轮「completion 已透传」结论作废，本轮才真正打通后端判据到账本；
  ② P1 账本现可区分首执/refine/synthesize/decorative 四类轮 + 三态完成度 + 来源四态，
    达成度以后端规则判据为准、自评仅降级不强抬；③ 再次印证真问题集中在判据一致性与
    结果链路，非呈现层加码。

---

## 9. 会话脉络连续性 + 主动补充通道（v0.9.37）

> 2026-11-19 用户反馈驱动：「界面信息丰富了，但上下文断了、没有连续性，缺少信息时
> 让用户补充的机制没有」。诊断后确认三个感受同根：旧版每个新问题都
> `sendMessage → runForecast` 直接 `_lastContext = text` 整段覆盖，历史轮次/用户补充/
> 纳入关联在**语义层全部清零**——3D 轨迹与 2D 账本还在，但喂给模型的上下文断了，
> 正是「视觉连续 vs 语义断裂」的错位；而补充只有模型被动 clarify 一条路，
> 用户主动补充只能发新问题 = 把会话冲掉。属研究主线（P3 可追溯 + P0 结果可用性），
> 非呈现层加码。四项修复后另派只读 agent 复核修复本身，补修 7 处（含 1 个同根因连锁 4 条）。

### A. 四项修复

- **①会话摘要（`buildSessionDigest`）**：新问题把本会话真实轮次压缩成 `[会话摘要]` 随问题
  下发，让模型看到连续上下文。★ 三道红线：只取 `done && llm && !decorative && !synthesized`
  的真实轮（P1 纪律）；只带一句话结论、不带推演 label/steps（防任务类型污染）；
  摘要用专用标记包裹，`classify_task_kind` 扫描前 `strip_session_digest` 只认本轮原话，
  防历史数据词把起草任务误判成 analysis。
- **②主动补充通道**：输入栏加「新提问 / 补充当前会话」意图切换。补充与提问的根本区别：
  不清 journey/候选/用户纳入的关联，把纯用户补充拼进当前上下文后重新推演。补充后意图
  自动复位为「新提问」，避免下一话题被误路由成补充。
- **③need_input 补充出口**：`renderCompletionAction` 对「模型返回文本但判 need_input」的
  普通卡给「补充信息到当前会话 →」动作，点选切补充模式并聚焦输入框。clarify 卡走自己的
  dock 回答入口（提前 return），不重复。根治「看着待补输入却无处可补」。
- **④2D 会话脉络视图**：时间线面板加「会话脉络」视图，按时间交织显示
  问题 → 补充 → 执行轮（含来源/达成度/分叉）。只读投影，不改 3D/账本真相源。

### B. 复核补修（只读 agent 发现，7 条）

- **根因连锁 4 条**：补充路径曾用 `buildExploreContext()` 整体结果覆盖 `_lastContext`，
  导致多次补充时 `[prev]`+旅程链+推演尾句逐层叠加、摘要把这些系统样板误提取成
  「用户曾补充」、tags 被清（与「补充不重置」承诺矛盾）、意图不复位反向误路由。
  修复：新增纯用户文本 `_supplementLog` 作摘要/上下文重建唯一来源；补充只追加纯文本，
  系统样板按需拼、用完即弃；`runForecast(opts.preserveTags)` 保留已纳入关联；补充后复位意图。
- **标记误删（中低）**：`strip_session_digest` 未闭合时曾整段丢弃 BEGIN 之后内容，可能误删
  本轮真实诉求（如标记出现在任务中间）。修复：只剥完整闭合标记段，未闭合保守当普通文本。
- **内部标记进 prompt（低）**：execute prompt 原样透传 `<<<会话摘要…>>>`。修复：
  `split_session_digest_for_prompt` 拆成自然语言「本会话此前的真实进展（供延续参考）」，
  模型仍见历史但不受内部 token 干扰。
- **UI 细节**：补 `.tl-head button.on` 高亮样式；更正 renderCompletionAction 过时注释；
  输入栏新增意图行后 clarifyDock 从 bottom:78→108px（修布局重叠）。

### C. 验证与影响

- 新增 2 个测试：前端 `test_session_continuity.js` 31 项、后端 `test_session_continuity_backend.py`
  20 项，全通过（含多次补充不叠加、标记中间闭合门控、prompt 拆分等复核断言）。
- 全量既有回归无回退：clarify_dock/quick、completion、p0、timeline 42、cancel 33、
  keyboard 22、decorative、rail_camera 14、refine_sync、task_kind 门控全过。
- 研究结论影响：会话连续性从「视觉有、语义无」升级为「语义真实延续」，且补充不再
  以重置会话为代价。门控只认本轮原话的纪律扩展到会话摘要路径，P1 账本仍以真实执行轮
  为唯一历史依据。3D 机位/轨道/到达牌不变量、execute 主链均未触碰。
