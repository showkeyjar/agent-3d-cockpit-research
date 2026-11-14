# 执行链审计 AUDIT（M0-a）

> 目的：拿 [PROBLEM.md](PROBLEM.md) §4 的 P1–P4 四判据，逐条对照 v0.9.9 原型**实际行为**打分，产出「原型 × P1–P4 现状矩阵」。
> 方法：读原型真实代码（`backend/task_tracker.py` 执行链 + `backend/server.py` 任务上报 + `index.html` 结果卡），不靠印象。
> 审计日期：2026-11-09。

## 0. 一句话结论

**执行链本身在大多数步骤上是「剧场」：进度条在动，但中间步骤几乎没有真实工作。**
这直接证伪了 PROBLEM.md §4 的乐观命题——问题不只是 P4（界面没呈现），而是 P1（真实性）与 P3（归因）在执行层就已经不成立。

## 1. 证据一：中间步骤从不调用 LLM，`prompt` 是死参数

`AgentExecutor._run_task`（`backend/task_tracker.py:220-239`）：

```python
async def _run_task(self, task_key, prompt, sub_steps, result=None, context="", label=""):
    self.tracker.start_task(task_key, sub=sub_steps[0])
    n = len(sub_steps)
    for i, step_desc in enumerate(sub_steps):
        self.tracker.update_progress(task_key, (i + 0.3) / n, step_desc)
        await asyncio.sleep(0.09)          # ← 进度是"睡出来的"，不是干出来的
    self.tracker.update_progress(task_key, 0.8, "收尾整理…")
    if result is None:
        result = self._local_result(task_key, context, label)   # ← 模板句，不是真结果
    ...
```

- **函数体内 `self._llm` 调用次数 = 0**（实测 grep）。传入的 `prompt` 参数在 `_run_task` 内部**从未被使用**（除签名外使用次数 = 0）。
- 也就是说：`_task_prompt()` 为每个任务类型（rag/tool/generate/verify/output）生成的 prompt，**全是死代码**——从不发给模型。

## 2. 证据二：整条链只有"最后一步"发了真实 LLM 请求

`AgentExecutor.execute`（`backend/task_tracker.py:358-442`）：

```python
llm_task = asyncio.create_task(_answer()) if self.use_llm else None   # 整条路径只发这一次
...
for i, task_type in enumerate(chain):
    result = None
    if llm_task is not None and i == last:      # ← 只有最后一步(output)才等真实结果
        result, reason = await asyncio.wait_for(llm_task, timeout=30)
    outputs[task_type] = await self._run_task(task_type, ..., result=result, ...)
```

- 中间步骤（rag/tool/generate/verify）拿到的 `result=None` → 走 `_local_result()` **模板句**。
- 只有 `chain[-1]`（output）这一步，`outputs.get(chain[-1])` 装的才是**真实 LLM 输出**（`execute` 返回 `"output": str(outputs.get(chain[-1], ""))`）。

## 3. 证据三：`_local_result` 与子步骤是"演出服"

`_local_result`（`backend/task_tracker.py:241-251`）返回的是**按任务类型拼的模板句**：

```python
"rag":      f"已检索「{brief}」相关资料",        # 但其实没有检索任何东西
"tool":     f"已生成「{brief}」的执行方案",      # 但其实没有执行任何代码
"verify":   f"已校验「{brief}」的边界条件",      # 但其实没有校验
```

`_sub_steps_for`（`backend/task_tracker.py:456-463`）给出的子步骤是**演出动画**：

```python
"rag":   ["RAG · 查询中…", "RAG · 召回 Top-K…", "RAG · 重排序…"],   # 没有任何向量库
"tool":  ["execute_code · 解析需求…", "execute_code · 构建方案…"],  # 没有真实执行
```

全文件**不存在**任何向量库（chromadb/faiss）、真实检索、`subprocess`/代码执行后端。RAG 的脚步名称是纯展示。

## 4. 证据四：前端结果卡的"真实度"判定

`index.html:2050-2058`：

```js
const raw = escText(d.output).trim();
const looksLikeLog = /^已(检索|生成|整理|输出|校验)/.test(raw) || raw.length < 8;
const hasReal = !!d.ok && d.source === 'llm' && !!raw && !looksLikeLog;
// hasReal → 显示真实模型正文；否则 → 显示"执行记录" + 模板说明
```

- 只有 `source === 'llm'`（即最后一步拿到真实模型答案）时，结果卡才显示**真实内容**。
- 否则显示"执行记录" + `REASON_TEXT[d.reason]` 模板说明（model_busy/llm_failed/timeout/...）。而这些"执行记录"里列的步骤，正是 §3 的剧场步。

## 5. 现状矩阵（原型 × P1–P4）

| 判据 | 当前状态 | 证据 |
|------|----------|------|
| **P1 真实性** | ❌ 破损（中间链是剧场） | `_run_task` 不调 LLM、`sleep(0.09)` 驱动进度、`_local_result` 模板句；无真实检索/执行后端 |
| **P2 可核对** | △ 部分（仅最后一步是真的） | 仅 output 步 `source==='llm'` 时显示真实正文；其余是模板"执行记录" |
| **P3 归因** | ❌ 破损（归因与事实不符） | 展示链 rag→generate→output 暗示每步都做了事，实际只有最后一步调了模型 |
| **P4 可感知** | ✓ 满足，但感知到的是剧场 | 进度条会动、结果卡会出现，但"被感知的进展"是演出链，不是真实进展 |

**读法**：用户看到一条"检索知识库 → 生成中间结果 → 输出"的进度链在推进，但除了最后一格，前面每一格**什么都没干**。这与用户"界面上没有实质性进展"的直觉**完全吻合**——而且更严重：不是"真干了但没呈现"，而是"呈现的进度大部分是假的"。

## 6. 对 PROBLEM.md 核心命题的证伪

PROBLEM.md §4 曾断言：

> v0.9.9 的失败不在任何一个执行层功能缺失，而在 **P4 缺失**——执行层的进展（如果有）没有在界面上被认出。

**审计证伪了这个乐观命题**：执行层不是"有进展但没呈现"，而是**中间步骤本就没有真实进展**（P1 破损）。所以修法不能只是"补呈现"（那是把剧场做得更清楚），必须先让执行链**真实**（P1），再让归因**准确**（P3），呈现才有意义。

→ 这意味着研究问题要升级：**"如何让执行链真实且归因准确"取代了原先"如何让进展可感知"成为第一性问题。** 已回写 PROBLEM.md。

## 7. 审计的边界（诚实标注）

- 本审计是**开发侧静态代码审计**，非用户侧数据。"用户看到剧场进度条时的具体感受"仍需一次最小用户验证（RESEARCH-PLAN.md M0-b）确认。
- 但代码证据是硬的：`_run_task` 不调 LLM、中间步骤 `result=None`、`_local_result` 模板句——这些是**事实**，不依赖用户感受。
- 注意区分：**最后一步（output）确实是真实 LLM 调用**（`_answer()`），这部分不是剧场。问题是前面的链是剧场。

## 8. 下一步

- M0-b：一次最小用户验证，确认"剧场进度条"是否确实是用户"没有实质进展"感的来源（需用户侧数据）。
- 据此**重排研究问题**：P1（真实执行链）取代 P4（呈现）成为第一优先级。
