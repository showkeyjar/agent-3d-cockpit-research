# 方向③设计：把真实激活指纹编码进 v0.9.38 语义分叉拓扑

> 状态：**信号层已验证 + 2D 凭据层 v0.9.40 + 真实采集管线 v0.9.41 + 3D 指纹环 v0.9.42（2026-11-19）**。
> 已完成：判决实验（信号层）✅、可交互 demo ✅、**2D 凭据层进账本/详情/导出** ✅、
> **8083 主力打 expert-stats 补丁 + 真实采集管线接通（execute 生成段抓取），端到端 available** ✅、
> **3D 指纹环编码进语义分叉树（吸附「现在」节点，可点核对，3D 不变量零回退）** ✅。
> 方向③全部完成。
> 触发：用户提议「把信号编码进 v0.9.38 的语义分叉拓扑，而不是自由粒子云」。
> 方法：隔离探针（独立二进制 / 8090 端口，全程未碰 8083）+ 判决实验 + 自包含可视化 demo。
> 纪律：严格区分【已验证】/【初步证据】/【理论动机】/【未验证】。配套报告 `PROBE-ACTIVATION-VIZ.md`。

---

## 0. 一句话结论

**方向③成立，而且比探针最初的悲观裁决更有希望**——但成立的前提是：只用**整段聚合专家分布**，绝不用逐 token 路由。
聚合分布在温度 0 下是 `r=1.000` 可复现、`r=0.017–0.157` 可区分的**真实 prompt 指纹**，够格当 P1/P2 执行凭据；
把它贴到 v0.9.38 已有的语义树状分叉上（而非自由粒子云），让"结构承载语义、指纹承载真实内部状态"，
是本项目「空间结构直接编码真实信号」主线的下一格（与 v0.9.38 clusters 进几何同源）。

---

## 1. 判决实验：推翻上一轮的悲观结论【已验证】

### 1.1 为什么要重做

`PROBE-ACTIVATION-VIZ.md §5` 曾判定"路由主要是 token 级随机，无稳定任务语义"（自相关 r=0.293 vs 互相关 r=0.203）。
本轮发现那个结论有两个方法学缺陷：

1. **看了错误的层**：用的是 `tokens` 尾部 16 条采样——那是逐 token 抖动层（噪声层）。
2. **窗口污染**：`recent[]` 是 **256-token 滑动窗口**内的累积命中（非永久累积）。连续多 prompt 时后一个的分布混入前一个的残留，
   导致"潮汐 vs 代码 r=0.951"这种假相似（实为窗口相邻重叠）。

### 1.2 正确实验设计

关键洞察：`/experts` 的 `recent[60]` 是窗口内累积直方图（验证：il=0 在 n_tokens=86 时求和 = 344 = 86×4）。
所以每个 case **必须重启服务清空窗口**，再取窗口未满时的纯净分布。

| Case | 内容 | 温度 | 重启 |
|---|---|---|---|
| A1 | 中文·潮汐科普 | 0 | 独立启动 |
| A2 | 同 A1，重复 | 0 | 独立启动 |
| B | 英文·代码任务 | 0 | 独立启动 |
| C | 中文·医学问答 | 0 | 独立启动 |

脚本：`D:\tools\probe_clean_verdict.py` → 数据 `probe_clean_verdict.json` / `probe_dist60.json`。

### 1.3 结果（60 维聚合分布 Pearson r）

| 对比 | r | 解读 |
|---|---|---|
| **A1 vs A2（同 prompt 重跑）** | **1.000** | 逐位完全一致——确定性 |
| A1 vs B（中文 vs 代码） | 0.017 | 几乎不相关 |
| A1 vs C（中文 vs 医学） | 0.157 | 弱相关 |
| B vs C（代码 vs 医学） | 0.083 | 几乎不相关 |

**结论**：整段聚合专家分布 = 稳定的、prompt-specific 的真实指纹。
逐 token 是噪声，聚合是信号——这是方向③全部价值的基础。

---

## 2. 编码设计：信号贴到哪、怎么贴

### 2.1 现状：v0.9.38 拓扑的真实结构【已验证，读码】

`index.html:3550–3676` 的三级骨架：

```
主干 trunk (branchId=-11, 共用, 不参与拾取)
  └─ 簇分叉点 J[g] + junction  (branchId=-100-gi / -120-gi, 同簇共用)
       └─ 候选细枝 twig + dash + orb  (branchId=i, 候选专属, 待选虚线)
```

- **语义骨架来源真实**：`clusters` 来自 `core.py:174 cluster_candidates()`，对候选 embedding 向量做余弦距离贪心聚类；
  进 3D 后按语义 X 排序、语义间距大的簇分叉更开（index.html:3563–3581）。这不是装饰性均匀扇形。
- **视觉契约必须保留**：`markBranchTravelled()`（6375）收起待选虚线、点亮 orb、隐藏岔口牌；拾取靠 branchId。

### 2.2 编码映射（本方案提议，进主线前需评审）

| 拓扑元素 | 现状 | 提议编码 | 数据来源 |
|---|---|---|---|
| 簇分叉点 J[g] 亮度/半径 | 固定 0.55 透明 / 0.16 半径 | 该簇候选的聚合指纹强度 | 真实 60 维分布 |
| 候选细枝 twig 粗细 | `0.05 + semanticDiv*0.012` | 叠加该候选专家激活占比 | 真实分布第 i 维 |
| 候选 orb 发光 | 待选 0.22 / 走过 0.6 | 待选态叠加指纹强度底噪 | 真实分布 |
| 新增"指纹环"(可点) | 无 | 到达点旁一圈 60 段环形条，点击展开专家直方图 + 来源标注 | 真实分布 |

**关键纪律**：
1. **只编码聚合，不编码逐 token**。逐 token 抖动上屏 = 新剧场，违反 P1。
2. **指纹环必须有来源标注**（真 hook / 端口 / 温度 / 模型），与 source 四态、decorative 正交标记同源。
3. **不改机位/轨道/到达牌/拾取契约**。所有编码是"贴上去的着色/环"，不新铺影响驾驶的几何；需回归 `test_tree_fork.js`(17)、`test_rail_camera.js`(14)。
4. **注意力放语义骨架**：结构仍由 clusters 决定（可读），指纹只是给结构"上色 + 挂凭据"，人读的是已知语义结构上的真实活动，不是从噪声里找语义。

### 2.3 可视化 demo【交付】

`tools/activation-topology-demo.html`（自包含，真实数据内联）：
- 左：v0.9.38 式三级分叉（骨架示意），分叉点亮度 / 细枝粗细 = 真实指纹强度；
- 右：60 维真实专家指纹环形图，可切潮汐/代码/医学三任务，实时显示两两相关 r；
- 已用无头 Chrome 验证：画布渲染正常、无 JS 错误、切换任务后 r 值联动正确（自身 1.000 / 异任务 0.017）。

---

## 3. P1–P4 定位（为什么这次不是剧场）

| 支柱 | 本方案贡献 | 判据 |
|---|---|---|
| **P1 真实性** | 指纹来自真 LLM 推理的 MoE 路由张量，非哈希、非模拟 | 温度 0 重跑逐位一致（r=1.000）可复算 |
| **P2 可核对** | 指纹环点击展开 60 维直方图 + 来源；r 矩阵可复算 | 用户能核对"这条决策用到的内部状态指纹" |
| **P3 可追溯** | 每轮执行绑定一个指纹，进 2D 账本 / 导出（与 llm/fast/local/offline 正交） | 能追到是哪轮哪次执行的内部状态 |
| **P4 可感知** | 同 prompt 指纹稳定、异 prompt 分离 → 结构上呈现可辨识的"模式" | r 矩阵支撑（1.000 vs 0.017） |

**反面防线**：若日后发现聚合指纹在大模型上不稳定（r 不收敛），则立即降级为"仅 P1/P2 凭据"，
**不得**宣称 P4 模式——避免重蹈"四轮呈现层迭代无效"的覆辙。

---

## 4. 代价与前置条件【初步证据 / 未验证】

- **吞吐**：开 expert-stats 33.9 tok/s vs 关 45.6 tok/s，小模型 Vulkan 上 **-26%**（详见探针报告 §4，有噪声、不可外推到 8083 的 48 层 / top-10 / 36GB）。
- **前置条件（v0.9.41 已解除）**：8083 主力曾无 `/experts`；用户授权后已打 expert-stats 补丁并持久化到启动脚本，`/experts` 现返回 200，采集管线已接通（见 §4.5）。本节吞吐/稳定性数字仍是当时的离线评估，真实主力代价未单独复测。
- **未验证清单**：
  1. 512 专家大模型上聚合指纹是否同样稳定（本测仅 60 专家小模型）——**决定是否值得上主力的关键实验**；
  2. 正式进 3D 后是否遮挡/干扰拾取与到达牌（需完整回归）；
  3. 主力开启统计的真实吞吐代价；
  4. 指纹环的"专家 ID 无命名"可解释性上限——专家仍是训练涌现的无名 ID，人读出的是"模式差异"而非"这个专家管医学"。

---

## 4.5 真实采集管线接通（v0.9.41）【已验证，2026-11-19】

A 的前提已满足：用户授权后给 8083 主力打了 `--expert-stats` 补丁（`D:/tools/llama.cpp/start-local-primary.bat` 已持久化，看门狗重启仍带参数），`/experts` 返回 200，512 专家 48 层真实路由。判决实验通过（同 prompt r=0.986、同语义簇 r=0.385、跨簇 r=0.058）。

### 采集实现（`prototype/backend/expert_state.py` + `task_tracker.py` + `server.py`）
- **纯数据层**：不改 execute 主链语义、不新增完成信号、不碰 3D 不变量。`AgentExecutor._llm_stream` 新增两个只读回调。
- **采集点 = 生成段**（关键）：首个内容 token 到达（prefill 已完成）取 before，生成完成取 after，差分只覆盖生成段。
- 差分聚合：`diff=max(0,after-before)` → 跨 48 层累加到 512 维 → 归一化 dist + top_experts。
- 来源元数据：`source=llm-expert-stats` / `endpoint=/experts` / `model` / `n_expert=512` / `n_layers=48` / `temperature=0.6`（如实，与 `_llm_stream` 一致）/ `captured_at` / `n_tokens_delta` / `expert_hits`。
- **诚实降级**：`capture_disabled` / `source_not_llm` / `interrupted` / `no_new_expert_activity` / 并发守卫（delta>3000 判污染），一律 unavailable，绝不伪造。
- `server.run_execute` 只透传 `result.internal_state` 到 execute_done；前端 `onExecuteDone→finishExecution→arrivalDetail→recordRun` 三处补齐透传（此前漏传，与三轮审查 completion 断点同款，已修）。

### ★ 根因诊断：采集点必须钉在生成段（勿回退）
初版采集点放在「LLM 调用前后」，走真实 execute 判别力**塌掉**：同 prompt r=0.672、异题 max=0.793。隔离实验定位根因：

| 实验 | same r | 异题 max | 结论 |
|---|---|---|---|
| 裸问题 + temp 0.6（`diag_temp_effect.py`） | 0.978 | 0.327 | temperature 不是主因 |
| **执行长模板 + temp 0.6**（`diag_template_effect.py`） | 0.636 | 0.776 | **模板 prefill 淹没任务信号**（delta 从 ~90 膨胀到 ~340） |
| 生成段采集 + 真实 execute（`verdict_via_execute.py`） | **0.990** | **0.079** | 排除 prefill 后判别力比判决实验更干净 |

**结论**：模板 prefill 的 token 路由会稀释任务自身信号。采集点必须在首 token→生成完成之间，不可挪回调用前后。

### 端到端验证
- `test_expert_state.py` 纯函数 25/25（端点推导/差分聚合/归一化/6 类降级守卫）。
- `e2e_expert_execute.py`：真实 LLM + available 指纹（512 维、和为 1、来源齐全）。
- `verdict_via_execute.py`：真实 execute 路径判别力 r_same=0.990 / 异题 max=0.079 → **P4 模式宣称成立**。
- `ws_e2e_internal_state.py`：真实 WS → execute_done 带 available 指纹。
- `test_internal_state_e2e.js` 8/8：前端透传链路 + 缺省不伪造。
- 关键回归无回退：test_internal_state 14/14、timeline 42/42、tree_fork 17/17、rail_camera 14/14、session_continuity 31/31。
- 8083 全程 health=200；改后端同步 LIVE 后 kill 监听 PID 让看门狗重拉（12.4s 恢复）。

---

## 4.6 3D 指纹环编码落地（v0.9.42）【已验证，用户选 C】

### ★ 相对 §2.2 提议的诚实偏离（勿回退）
§2.2 曾提议「簇分叉点亮度/细枝粗细按**该候选**的指纹强度」——实现时推翻：
**候选还没执行，根本没有 per-candidate 指纹**。手头只有「上一步真实执行」的一个 512 维整轮指纹。
若把它贴到前方候选细枝上，等于暗示「这条路会激活这些专家」，是把旧指纹冒充新候选的 P1 违规。
故采用更诚实的编码：**指纹环吸附在「现在」节点**（已走过的到达点），语义 =
「你用什么内部状态走到了这里」，是 P3 追溯凭据，与前方待选候选严格分离。

### 实现（`index.html`，纯呈现层，不改机位/轨道/到达牌/拾取契约）
- `buildFingerprintRing(pos, st, yaw)`：512 段径向条组成竖直盘，段长/颜色（青→琥珀）按 dist[i]/max，
  billboard 每帧正对相机（只改环自身 quaternion，**不碰相机/camAnchorYaw**）；
  底环 + 可点核心（`userData.fingerprint`），专用 `branchId=-6` 不进分支拾取数组。
- 只在 `lastInternalState.status==='available'` 时生成；首次提问 `_runs` 空 → 不生成（绝不伪造）。
- `pickFingerprint`（独立拾取，行驶中禁用）→ `showFingerprintPanel`：512 条直方图 +
  来源标注（source/endpoint/model/n_expert/n_layers/温度/n_tokens_delta/captured_at）。
- 位置诊断（fingerprintProbe）：贴脸（相机距<1.2m，回退/起点）自动隐藏，避免近裁剪面裁切；
  真实落位（相机后退 6.76m）环在屏幕中央、半径 85px、ndcZ=0.97，读数清晰不遮路牌。
- 迭代踩坑：水平环→从略俯视机位压成横带；竖直但钉 cur 正上方→相机贴脸出画；
  竖直盘自由侧移→压住路牌。最终=吸附「现在」节点 + billboard + 近距离守卫，稳定在下方空区。

### 验证
- `test_fingerprint_3d.js` 18/18（无指纹不生成、512 段、来源标注、专用 branchId=-6、
  forkTopology 三级不变、camOffRail≈0、面板 512 行+来源、0 JS 错误）。
- 真实落位截图（相机后退 6.76m）确认放射状可读、直径约 170px、不压路牌。
- 全量回归零回退：tree_fork 17/17、rail_camera 14/14、internal_state 14/14、
  internal_state_e2e 8/8、timeline 42/42、keyboard 22/22、scenery 21/21、session 31/31。
- TL_VERSION→v0.9.42；repo↔LIVE 已同步。

---

## 5. 推进状态与下一步

**B 已完成（v0.9.40）**：2D 凭据层已落地——`exec.internal_state` 进账本/详情/导出，
缺省诚实标 unavailable。`normInternalState` 严格守卫残缺数据；`test_internal_state.js` 14/14 + 关键回归全过。
这一步是 C 的数据前置：后端一旦下发真指纹，前端自动接住，无需再改展示层。

**A 已完成（v0.9.41）**：8083 主力打补丁 + 真实采集管线接通，端到端 available，
判别力 r_same=0.990 / 异题 max=0.079（生成段采集）。前置全部满足。

**C 已完成（v0.9.42）**：3D 指纹环落地——吸附「现在」节点、billboard 正对相机、可点核对 512 维 +
来源；相对 §2.2 有诚实偏离（不贴未执行候选，见 §4.6）；3D 不变量全量回归零回退。

**方向③四步（探针 → 2D 凭据 → 真采集 → 3D 编码）全部完成，无剩余选项。**
后续若要继续，属新主题：① 把指纹环纳入 M2 真人实验的操作性检验（能否真的提升 P1–P4 主观分）；
② attention 图信号探针（另一类内部状态）；③ 专家 ID 的可解释性研究（聚类命名）。均需另行立项。

**研究纪律（保留）**：专家 ID 仍是训练涌现的无名 ID，人读的是「模式差异」而非「这个专家管医学」；
指纹环是 P3 追溯凭据，不是"这条候选会激活什么"的预测。

---

## 6. 资产与复现

| 项 | 路径 |
|---|---|
| 判决实验脚本 / 数据 | `D:\tools\probe_clean_verdict.py` → `probe_clean_verdict.json` / `probe_dist60.json` |
| 确定性实验脚本 / 数据 | `D:\tools\probe_determinism.py` → `probe_determinism.json` |
| 可视化 demo | `tools/activation-topology-demo.html` |
| 隔离二进制 / 模型 / 补丁 | 见 `PROBE-ACTIVATION-VIZ.md §7` |
| 真实采集管线 | `prototype/backend/expert_state.py`（纯函数/降级）+ `task_tracker.py`（生成段回调）+ `server.py`（透传） |
| 采集管线测试 | `test_expert_state.py` / `e2e_expert_execute.py` / `verdict_via_execute.py` / `ws_e2e_internal_state.py` / `test_internal_state_e2e.js`（均在 prototype/backend，除 js 在 prototype） |
| 根因诊断脚本 | `D:/tools/diag_temp_effect.py` / `diag_template_effect.py` |
| 3D 指纹环编码 | `prototype/index.html`（buildFingerprintRing/pickFingerprint/showFingerprintPanel/animate billboard） |
| 3D 编码测试 | `prototype/test_fingerprint_3d.js` 18/18 |

**8083 主力 health=200、`/experts`=200（已打补丁）；已开启 expert-stats 并持久化启动脚本；所有隔离探针服务已停止。**
