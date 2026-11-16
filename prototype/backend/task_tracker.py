"""
Agent 任务追踪器 — 真实执行任务并流式上报

取代 v0.5 的硬编码模拟 task_update。
AgentExecutor 根据前瞻推理的候选分支，真实调用 LLM 执行子任务，
每步通过回调实时上报进度，前端挂件同步更新。

架构：
    TaskTracker   — 任务状态管理 + 回调上报
    AgentExecutor — 执行任务（LLM 真实推理），流式推送 token

    候选分支 → AgentExecutor 单步真实流式执行 → TaskTracker 上报 → WebSocket 推送

★ v0.9.12 路线 B（2026-11-11）：诚实降级为单步真流式。
    研究审计（agent-3d-cockpit-research/docs/AUDIT.md + RUNTIME-AUDIT.md）证实：
    旧的中间步骤（rag/tool/generate/verify）不调 LLM、无检索/代码/校验后端，
    进度由 asyncio.sleep(0.09) 睡出（占整链 ~86% 时长），是「剧场」。
    路线 B 取消全部中间剧场步骤：一个真实 LLM 请求 + token 流式逐字流出，
    进度 = token 流本身（真实信号）。模型忙/失败时如实降级说明，不再伪造
    「已检索/已生成」文案。任务链只剩一步真实步骤（output），归因与事实一致。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import aiohttp


# ─── 任务类型 ───────────────────────────────────────────

TASK_TYPES = {
    "rag":       {"name": "检索知识库", "color": "#ffb13d", "anchor": 1},
    "tool":      {"name": "调用计算工具", "color": "#4fa8ff", "anchor": 2},
    "generate":  {"name": "生成中间结果", "color": "#34f5a0", "anchor": 3},
    "output":    {"name": "输出生成",     "color": "#5ee0ff", "anchor": 4},
    "verify":    {"name": "验证输出",     "color": "#ff5fe0", "anchor": 4},
}


@dataclass
class TaskState:
    name: str
    type: str
    color: str
    anchor: int
    sub: str = ""
    status: str = "run"       # run / wait / done / stop（stop=用户中断，不是完成）
    progress: float = 0.0     # 0.0 - 1.0


# ─── TaskTracker ─────────────────────────────────────────

class TaskTracker:
    """
    任务追踪器：管理活跃任务，通过回调上报状态变更。

    用法：
        tracker = TaskTracker(callback=ws_send_task_update)
        tracker.start_task("rag")
        tracker.update_progress("rag", 0.3, "RAG · 查询中…")
        tracker.mark_done("rag", "RAG · 12 篇命中 ✓")
    """

    def __init__(self, callback: Callable[[dict], Any]):
        self._callback = callback
        self._tasks: Dict[str, TaskState] = {}
        self._order: List[str] = []

    def start_task(self, task_type: str, sub: str = "") -> str:
        """启动一个新任务，返回 task_key"""
        info = TASK_TYPES.get(task_type, {"name": task_type, "color": "#888", "anchor": 0})
        key = task_type
        self._tasks[key] = TaskState(
            name=info["name"], type=task_type,
            color=info["color"], anchor=info["anchor"],
            sub=sub, status="run", progress=0.0,
        )
        self._order.append(key)
        self._notify(key)
        return key

    def update_progress(self, task_key: str, progress: float, sub: str = "") -> None:
        task = self._tasks.get(task_key)
        if task:
            task.progress = max(0.0, min(1.0, progress))
            if sub:
                task.sub = sub
            task.status = "run"
            self._notify(task_key)

    def mark_done(self, task_key: str, sub: str = "") -> None:
        task = self._tasks.get(task_key)
        if task:
            task.status = "done"
            task.progress = 1.0
            if sub:
                task.sub = sub
            self._notify(task_key)

    def mark_waiting(self, task_key: str, sub: str = "") -> None:
        task = self._tasks.get(task_key)
        if task:
            task.status = "wait"
            if sub:
                task.sub = sub
            self._notify(task_key)

    def mark_stopped(self, task_key: str, sub: str = "已由用户中断（未完成）") -> None:
        """v0.9.16：用户主动停止生成。status='stop'，进度保持中断时的真实值，
        绝不写成 done/100% —— 把中断伪装成完成就是 P1/P3 破损。"""
        task = self._tasks.get(task_key)
        if task:
            task.status = "stop"
            if sub:
                task.sub = sub
            self._notify(task_key)

    def get_all(self) -> List[Dict]:
        return [self._to_dict(k) for k in self._order]

    def _to_dict(self, key: str) -> Dict:
        t = self._tasks[key]
        return {
            "name": t.name, "status": t.status,
            "progress": t.progress, "sub": t.sub,
            "color": t.color, "anchor": t.anchor,
        }

    def _notify(self, key: str) -> None:
        if self._callback:
            self._callback(self._to_dict(key))


# ─── AgentExecutor ────────────────────────────────────────

class AgentExecutor:
    """
    执行任务链：根据候选分支拆出子任务，逐个真实执行，分步上报。

    每个子任务调用 LLM 真实推理（OpenAI 兼容接口），
    模拟 agent 的工具调用循环，通过 TaskTracker 实时上报进度。

    用法：
        executor = AgentExecutor(llm_base_url, llm_model, tracker)
        await executor.execute(context, candidate_label)
    """

    def __init__(self, llm_base_url: str, llm_model: str, tracker: TaskTracker,
                 use_llm: bool = False):
        self.llm_url = llm_base_url
        self.llm_model = llm_model
        self.tracker = tracker
        # 默认本地确定性执行：本机主力模型（8083）单次就要 11s，
        # 每步都等它只会把「超时」刷满任务条。模型够快时用 EXEC_USE_LLM=1 打开。
        self.use_llm = use_llm
        self._session: Optional[aiohttp.ClientSession] = None
        self._active_resp = None      # v0.9.16：正在读的流式响应，供 abort() 掐断

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def abort(self):
        """v0.9.16 停止生成：立即关闭与 llama-server 的流式连接。
        客户端断开后 llama.cpp 会中止这次生成、释放单槽推理位；
        不是「前端不再画进度」那种假停止。"""
        r = self._active_resp
        if r is not None and not r.closed:
            r.close()
        self._active_resp = None

    async def close(self):
        await self.abort()
        if self._session and not self._session.closed:
            await self._session.close()

    async def _llm(self, prompt: str, max_tokens: int = 220) -> str:
        """
        调用 LLM，返回文本。

        快速优先：关掉 thinking（推理型模型在 thinking 阶段常返回 content=null）、
        限制 token 与超时，避免单步把整条执行链拖到几十秒。
        """
        try:
            sess = await self._get_session()
            async with sess.post(
                f"{self.llm_url}/chat/completions",
                json={
                    "model": self.llm_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens,
                    "temperature": 0.6,
                    "chat_template_kwargs": {"enable_thinking": False},
                },
                timeout=aiohttp.ClientTimeout(total=25),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = data["choices"][0]["message"].get("content")
                    if isinstance(content, str) and content.strip():
                        return content.strip()
                    return "[模型未返回文本]"
        except asyncio.TimeoutError:
            return "[本地模型响应超时，已跳过]"
        except Exception as e:
            return f"[LLM 调用失败: {e}]"
        return "[LLM 不可用]"

    async def _llm_stream(self, prompt: str, max_tokens: int = 220,
                          on_chunk=None, cancel_event=None) -> "tuple[str, str]":
        """
        流式调用 LLM（OpenAI SSE 协议），返回 (全文, reason)。reason 为空即成功。

        delta 按「每 ~6 个 token 或每 120ms」合并成 chunk，经 on_chunk 异步回调
        推出——既避免逐 token 的 WS 消息风暴，又保持「进度=真实信号」：
        每个 chunk 到达的时刻就是模型真实产出的时刻。

        v0.9.16：cancel_event 被 set 时立即 resp.close() 断开连接（真正中止
        模型生成），把中断前已生成的真实文本作为部分结果返回，reason='interrupted'。
        """
        parts: List[str] = []
        try:
            sess = await self._get_session()
            async with sess.post(
                f"{self.llm_url}/chat/completions",
                json={
                    "model": self.llm_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens,
                    "temperature": 0.6,
                    "stream": True,
                    "chat_template_kwargs": {"enable_thinking": False},
                },
                timeout=aiohttp.ClientTimeout(total=55),
            ) as resp:
                self._active_resp = resp
                if resp.status != 200:
                    return "", f"http_{resp.status}"
                buf: List[str] = []
                n_tokens = 0
                last_flush = time.monotonic()

                async def flush():
                    nonlocal last_flush
                    if not buf:
                        return
                    chunk = "".join(buf)
                    buf.clear()
                    last_flush = time.monotonic()
                    if on_chunk:
                        try:
                            r = on_chunk(chunk)
                            if asyncio.iscoroutine(r):
                                await r
                        except Exception:
                            pass

                async def handle_line(line: str):
                    nonlocal n_tokens
                    if not line or line.startswith(":"):
                        return
                    if not line.startswith("data:"):
                        return
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        return False
                    try:
                        obj = json.loads(payload)
                    except Exception:
                        return True
                    choices = obj.get("choices") or []
                    if not choices:
                        return True
                    delta = (choices[0].get("delta") or {}).get("content")
                    if isinstance(delta, str) and delta:
                        parts.append(delta)
                        buf.append(delta)
                        n_tokens += 1
                        if n_tokens % 6 == 0 or (time.monotonic() - last_flush) >= 0.12:
                            await flush()
                    return True

                leftover = ""
                async for raw in resp.content:
                    # 用户按下「停止生成」：先把已产出的 chunk 如实推出，
                    # 再断开连接让 llama-server 停止生成；绝不把部分文本伪装成完整答案。
                    if cancel_event is not None and cancel_event.is_set():
                        resp.close()
                        await flush()
                        return "".join(parts).strip(), "interrupted"
                    leftover += raw.decode("utf-8", "ignore")
                    while "\n" in leftover:
                        line, leftover = leftover.split("\n", 1)
                        if not await handle_line(line.strip()):
                            leftover = ""
                            break
                if leftover and leftover.strip():
                    await handle_line(leftover.strip())
                await flush()

                text = "".join(parts).strip()
                if text:
                    return text, ""
                return "", "empty"
        except asyncio.TimeoutError:
            # 掐断连接可能表现为超时/连接错误；只要用户已请求停止，就按中断如实回报，
            # 不能误报成「模型响应超时/调用出错」。
            if cancel_event is not None and cancel_event.is_set():
                return "".join(parts).strip(), "interrupted"
            return "", "timeout"
        except Exception as e:
            if cancel_event is not None and cancel_event.is_set():
                return "".join(parts).strip(), "interrupted"
            return "", f"error:{type(e).__name__}"
        finally:
            self._active_resp = None

    async def _strata_free(self) -> bool:
        """
        Strata 只有 1 个 slot（parallel=1）。被别的客户端长请求占住时，
        新请求会一路排队到超时。忙时直接返回 False，走本地确定性执行。
        非 Strata 服务没有 /status，探测失败则照常请求。
        """
        try:
            from urllib.parse import urlsplit
            u = urlsplit(self.llm_url)
            sess = await self._get_session()
            async with sess.get(f"{u.scheme}://{u.netloc}/status",
                                timeout=aiohttp.ClientTimeout(total=2)) as r:
                st = await r.json()
            return not (st.get("busy") or (st.get("queued") or 0) > 0)
        except Exception:
            return True

    async def _wait_strata(self, timeout: float = 12.0, cancel_event=None) -> bool:
        """
        Strata 只有 1 个 slot。忙时不要立刻放弃，而是等它空出来：
        最常见的占用者是我们自己的后台前瞻推演（3-8s 就结束），
        等一下就能让「用户点路牌要答案」拿到真实模型结果，
        而不是被挤成本地流程、结果卡被误判成「流程演示」。

        v0.9.16：等槽期间也能被「停止生成」立刻打断（不必死等 0.35s 轮询）。
        """
        deadline = time.monotonic() + timeout
        while True:
            if cancel_event is not None and cancel_event.is_set():
                return False
            if await self._strata_free():
                return True
            if time.monotonic() >= deadline:
                return False
            if cancel_event is not None:
                try:
                    await asyncio.wait_for(cancel_event.wait(), timeout=0.35)
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(0.35)

    # ─── 路线 B：诚实单步执行（v0.9.12）─────────────────
    #
    # 历史（v0.9.9–v0.9.11）：_run_task / TASK_CHAINS / _generate_chain /
    # _task_prompt / _sub_steps_for 构成「中间剧场」——rag/tool/generate/verify
    # 四步不调 LLM、不检索、不执行代码，进度 sleep(0.09) 睡出，完成文案是
    # _local_result() 模板句。已全部移除（研究审计：P1 破损、P3 破损）。
    #
    # 现在：单步真实流式。任务链只剩一步「输出生成」，每一步（也就是唯一的
    # 这一步）都对应一次真实 LLM 生成；token 流本身就是进度信号。

    # 诚实降级文案：模型忙/失败时如实说明「这一步没有产生成果」，
    # 绝不伪造「已检索/已生成/已校验」这类没发生过的完成语句。
    HONEST_FALLBACK = {
        "model_busy":  "推理槽被占用，这一步没有产生成果",
        "llm_disabled": "未启用模型推理，这一步没有产生成果",
        "llm_failed":  "模型未返回有效内容，这一步没有产生成果",
        "timeout":     "模型响应超时，这一步没有产生成果",
        "empty":       "模型返回空内容，这一步没有产生成果",
        "error":       "模型调用出错，这一步没有产生成果",
    }

    async def execute(self, context: str, candidate_label: str,
                      planned_steps: Optional[List[str]] = None,
                      stream_sink=None, cancel_event=None) -> Dict:
        """
        执行选定候选：单步真实 LLM 流式生成（路线 B）。

        planned_steps 来自前瞻推演，拼进 prompt 让模型沿规划作答（归因线索）。
        stream_sink 收到 dict：{"type":"token","text":<增量>} 或
        {"type":"token","reset":True}（重试前清空前端流面板）。
        cancel_event（v0.9.16）被 set = 用户点了「停止生成」：中断流式请求，
        返回 interrupted=True 的部分结果，绝不返回 completed=True 的假完成。
        返回 {"completed", "output", "tasks", "chain", "source", "reason",
              "tokens", "elapsed_ms", "note", "interrupted?": ...}
        """
        plan_line = ""
        if planned_steps:
            plan_line = "已规划的做事顺序：" + " → ".join(planned_steps[:4]) + "\n"
        final_prompt = (
            f"用户的问题：{context}\n"
            f"用户选择的做法：{candidate_label}\n"
            f"{plan_line}"
            "你现在是智能体，这一步由你亲自完成，把成果直接交付给用户，而不是告诉用户去做什么事。\n"
            "硬性要求：\n"
            "1. 直接给出这一步的实际成果（整理好的结论、要点、方案），就像你已经真的做完了一样。\n"
            "2. 禁止出现网址、链接、URL、域名。\n"
            "3. 禁止对用户说「建议您访问」「您可以查看」「请搜索」「去某某网站」这类把任务推回给用户的话。\n"
            "4. 不要复述问题、不要写标题、不要客套。150字以内。\n"
            "5. 如果任务需要具体数据或信息而用户没有提供，你无法诚实完成——严禁编造数字或事实。"
            "此时输出一个问题向用户索要缺失信息，以 [需要输入: 开头，后跟具体要什么。"
            "这是你作为智能体主动发起的交互，不是把任务推回去。"
        )

        async def _send_token(payload: dict):
            if stream_sink:
                try:
                    r = stream_sink(payload)
                    if asyncio.iscoroutine(r):
                        await r
                except Exception:
                    pass

        # 唯一的任务步：真实生成。进度 = 已流出的真实字数（信号本身）。
        # token 事件逐块下发（流面板的生长）；task_update 进度上报节流到
        # 200ms 一次，避免与 token 事件同刻重复刷屏。
        self.tracker.start_task("output", sub="模型生成中…")
        sent_chars = 0
        tokens_est = 0
        last_progress_ts = 0.0
        parts_out: List[str] = []      # v0.9.16：中断前已真实生成的全部文本

        async def on_chunk(chunk: str):
            nonlocal sent_chars, tokens_est, last_progress_ts
            parts_out.append(chunk)
            sent_chars += len(chunk)
            tokens_est += max(1, round(len(chunk) / 1.6))
            now = time.monotonic()
            if now - last_progress_ts >= 0.2:
                last_progress_ts = now
                self.tracker.update_progress(
                    "output", min(0.95, sent_chars / 400),
                    f"已生成 {sent_chars} 字（模型真实输出）")
            await _send_token({"type": "token", "text": chunk})

        t0 = time.monotonic()
        text, reason = "", ""
        note = ""

        def interrupted_result() -> Dict:
            """用户中断：如实回传部分文本 + 未完成的任务条，completed=False。
            绝不能走下面的诚实降级模板（那会说「模型未返回有效内容」，
            把用户的主动停止误报成模型失败）。"""
            self.tracker.mark_stopped("output")
            partial = "".join(parts_out).strip()
            return {
                "completed": False,
                "interrupted": True,
                "output": partial,
                "tasks": self.tracker.get_all(),
                "chain": ["output"],
                "source": "llm" if partial else "local",
                "reason": "user_cancelled",
                "tokens": tokens_est,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "note": "已由用户中断",
            }

        if self.use_llm:
            # 单槽推理服务：开始前等槽（通常是我们自己的后台推演占着），
            # 等不到就如实降级，不伪造进度。等槽期间也能被停止生成打断。
            free = await self._wait_strata(12, cancel_event)
            if cancel_event is not None and cancel_event.is_set():
                return interrupted_result()
            if free:
                text, reason = await self._llm_stream(
                    final_prompt, max_tokens=220, on_chunk=on_chunk,
                    cancel_event=cancel_event)
                if reason == "interrupted":
                    return interrupted_result()
                # 校验：模型有时仍把任务推回给用户（"建议您访问某某网站"）。
                # 违背「智能体亲自交付成果」原则——带更严格约束重试一次，
                # 重试前清空前端流面板（第一次的流式文本作废）。
                if cancel_event is not None and cancel_event.is_set():
                    return interrupted_result()
                if text and self._pushes_back_to_user(text):
                    note = "首次回答把任务推回给了用户，已自动重试"
                    harder = (
                        final_prompt
                        + "\n\n注意：你上一次把任务推给了用户（让用户自己去访问/查看）。"
                          "这是不允许的。你必须亲自完成这一步，直接给出成果本身，"
                          "不要任何网址，不要让用户做任何事。"
                    )
                    await _send_token({"type": "token", "reset": True})
                    parts_out.clear()      # 第一次的流式文本作废，部分结果也跟着作废
                    text2, reason2 = await self._llm_stream(
                        harder, max_tokens=220, on_chunk=on_chunk,
                        cancel_event=cancel_event)
                    if reason2 == "interrupted":
                        return interrupted_result()
                    if text2 and not text2.startswith("[") \
                       and not self._pushes_back_to_user(text2):
                        text, reason = text2, ""
                    else:
                        text, reason = "", "llm_failed"
            else:
                reason = "model_busy"
        else:
            reason = "llm_disabled"

        elapsed_ms = int((time.monotonic() - t0) * 1000)

        # 澄清轮次：模型发现缺输入，主动发起交互。
        # 这是真实智能体行为——不是剧场，是 P4 可感知的"它需要你"。
        CLARIFY_MARK = "[需要输入:"
        if text and text.startswith(CLARIFY_MARK):
            question = text[len(CLARIFY_MARK):].strip().rstrip("。.！!？?~～").rstrip("]】)）").strip()
            if question:
                self.tracker.mark_done(
                    "output", f"需要用户补充信息：{question[:40]}")
                return {
                    "completed": True,
                    "output": "",
                    "tasks": self.tracker.get_all(),
                    "chain": ["clarify"],
                    "source": "llm",
                    "reason": "",
                    "tokens": tokens_est,
                    "elapsed_ms": elapsed_ms,
                    "note": "",
                    "clarify": True,
                    "question": question,
                }

        if text and not text.startswith("["):
            summary = text[:80].replace("\n", " ").strip()
            self.tracker.mark_done("output", f"{summary} ✓")
            source = "llm"
            output = text
        else:
            # 诚实降级：任务条如实写「没有产生成果」，不进任何假完成文案。
            self.tracker.mark_done(
                "output", self.HONEST_FALLBACK.get(reason or "", "这一步没有产生成果"))
            source = "local"
            output = ""
            if not note:
                note = self.HONEST_FALLBACK.get(reason or "", "这一步没有产生成果")

        return {
            "completed": True,
            "output": output,
            "tasks": self.tracker.get_all(),
            "chain": ["output"],
            "source": source,
            "reason": "" if source == "llm" else (reason or "llm_failed"),
            "tokens": tokens_est,
            "elapsed_ms": elapsed_ms,
            "note": note,
        }

    @staticmethod
    def _pushes_back_to_user(text: str) -> bool:
        """
        判断模型输出是否把任务推回给了用户 —— 即让用户自己去访问网站/查数据。
        这是「查资料」类候选最常见的失败模式：模型没有真实检索能力，
        于是建议用户「访问某某网站」「查看某数据集」，对用户毫无价值。

        规则唯一来源：forecaster/core.py 的 pushes_back_to_user() 与其公开常量
        URL_RE / PUSHBACK_RE。本方法只做「导入」，绝不抄写正则——任何改动
        都发生在 core.py 一处，避免前瞻推演路牌净化与执行结果校验两处规则漂移。
        """
        try:
            try:
                from core import pushes_back_to_user as _pbu
            except Exception:
                from forecaster.core import pushes_back_to_user as _pbu
            return _pbu(text)
        except Exception:
            # 极端独立单测场景：core 完全不可导入时，从同一公开常量回退，
            # 仍不重新抄写正则。若常量也取不到，保守返回 False（不误伤正常输出）。
            try:
                try:
                    from core import URL_RE, PUSHBACK_RE
                except Exception:
                    from forecaster.core import URL_RE, PUSHBACK_RE
                t = text or ""
                return bool(URL_RE.search(t) or PUSHBACK_RE.search(t))
            except Exception:
                return False


# ─── 自测 ─────────────────────────────────────────────────

if __name__ == "__main__":
    import asyncio

    updates = []
    def cb(d):
        updates.append(d)
        print(f"  [上报] {d['name']} {d['status']} {d['progress']:.0%} {d['sub']}")

    async def test():
        tracker = TaskTracker(callback=cb)
        executor = AgentExecutor(
            "http://localhost:8083/v1", "local-primary", tracker,
        )
        # 路线 B：单步真实流式。token 增量打到 stdout 验证流式链路。
        async def sink(payload):
            if payload.get("reset"):
                print("  [token] （重试，清空）")
            else:
                print(f"  [token] {payload.get('text', '')}", end="", flush=True)

        result = await executor.execute(
            "帮我写一个 Python 爬虫", "检索资料", stream_sink=sink)
        print(f"\n输出: {result['output'][:120]}...")
        print(f"任务数: {len(result['tasks'])}（路线 B 恒为 1）"
              f" · source={result['source']} reason={result['reason']}"
              f" tokens≈{result['tokens']} 耗时={result['elapsed_ms']}ms")
        await executor.close()

    # 检查推理服务（与 server.py 默认一致：8083 llama.cpp 唯一主力模型）
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sock.connect_ex(("localhost", 8083)) == 0:
        sock.close()
        asyncio.run(test())
    else:
        sock.close()
        print("⚠️  8083 端口未运行，跳过 LLM 测试（仅验证任务链结构）")
        # 纯结构测试（不调 LLM）：单步任务的 start/progress/done 上报
        tracker = TaskTracker(callback=cb)
        executor = AgentExecutor("http://localhost:8083/v1", "test", tracker,
                                 use_llm=False)
        result = asyncio.run(executor.execute("测试上下文", "直接回答"))
        assert len(result["tasks"]) == 1, "路线 B 任务链必须恒为 1 步"
        assert result["chain"] == ["output"]
        assert result["source"] == "local" and result["reason"] == "llm_disabled"
        print("结构断言通过：单步链 / 诚实降级 / 无剧场步骤")
