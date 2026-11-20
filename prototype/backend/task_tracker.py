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

# v0.9.41：真实 MoE 聚合专家指纹采集（纯数据层，紧贴真实 LLM 调用前后取快照）。
# 同目录导入；单测从别的 cwd 导入时用相对导入兜底，绝不让采集失败拖垮执行链。
try:
    import expert_state
except ImportError:  # pragma: no cover - 仅在非常规导入路径触发
    try:
        from . import expert_state  # type: ignore
    except ImportError:
        expert_state = None  # type: ignore


# ─── 任务类型 ───────────────────────────────────────────

TASK_TYPES = {
    "rag":       {"name": "检索知识库", "color": "#ffb13d", "anchor": 1},
    "tool":      {"name": "调用计算工具", "color": "#4fa8ff", "anchor": 2},
    "generate":  {"name": "生成中间结果", "color": "#34f5a0", "anchor": 3},
    "output":    {"name": "输出生成",     "color": "#5ee0ff", "anchor": 4},
    "verify":    {"name": "验证输出",     "color": "#ff5fe0", "anchor": 4},
}


# ─── 任务类型门控（v0.9.29）────────────────────────────────────────────
# 审计补充 AUDIT-CONTEXT-POLLUTION.md：推演层给出的 label（"先查资料/检索口径"）
# 与 steps（"检索→整理→核对"）描述的是「推演器猜的做法」，不是用户原话里的数据
# 依赖。原样注入执行 prompt 后，起草类任务（产物就是文字）被包装成数据分析任务，
# 触发第 5 条的诚实索要输入 → clarify，起草类在正常点路流程 3/3 拿不到成果。
# 门控在后端做（prompt 在此组装），保证 Web/键盘/直连所有入口行为一致。
_COMPOSE_VERBS = re.compile(
    r"起草|撰写|草拟|拟一份|拟一个|写一份|写一个|写一封|帮我写|给我写|"
    r"生成一份|编一份|编制|输出一份|整理成|写成|出一份|拟写|拟稿|润色|扩写|缩写"
)
_COMPOSE_PRODUCT = re.compile(
    r"指南|方案|文档|报告|条款|邮件|文案|说明|总结|摘要|大纲|提纲|计划|清单|"
    r"规范|制度|手册|准则|细则|话术|回复|通知|公告|声明|倡议书|演讲稿|脚本|"
    r"诗歌|故事|文章|段落|内容|草稿|稿件"
)
_COMPOSE_STRONG = re.compile(
    r"起草|撰写|草拟|拟一份|写一份|帮我写|给我写|写一封|润色|扩写"
)
_DATA_DEPENDENT = re.compile(
    r"根据.{0,14}(数据|资料|文件|表格|观测|样本|记录)|"
    r"基于.{0,14}(数据|资料|文件|观测|样本)|"
    r"(附上|附件|上传的|提供的)?.{0,4}(数据|资料|文件|表格).{0,6}(分析|统计|预测|对比|评估)|"
    r"(分析|统计|整理|核对|对比|找出|预测|回归|拟合).{0,10}(数据|表格|样本|记录|观测|指标)|"
    r"(数据|表格|样本|观测).{0,10}(分析|统计|找出|异常|趋势|预测)|"
    r"ERA5|Sentinel|S2影像|遥感影像|\.csv|\.xlsx|数据库|观测站|时间序"
)
_RETRIEVAL_TERMS = re.compile(
    r"查资料|检索口径|检索|搜索|查阅|查找|核对来源|先查|调研|收集资料|查证"
)


# ─── 结果可用性判据（P0 / v0.9.30）────────────────────────────────────
# 把「模型吐了字」和「用户目标达成」分开。三档达成度是规则判据（不依赖模型
# 自评，单测确定），模型自评作为 refine 展开时的附加信号，两者独立记录。
#   achieved  = 真拿到模型产出且足以作为成果
#   partial   = 有产出但被截断/中断/非真实来源
#   need_input= 澄清轮（模型主动索要输入，任务未完成）
COMPLETION_ACHIEVED = "achieved"
COMPLETION_PARTIAL = "partial"
COMPLETION_NEED_INPUT = "need_input"
COMPLETION_LABELS = {
    COMPLETION_ACHIEVED: "目标达成",
    COMPLETION_PARTIAL: "部分达成",
    COMPLETION_NEED_INPUT: "待补输入",
}


def _rating_means_need_input(self_rating: str) -> bool:
    """模型自评是否明确表达「待补输入」。只用于把规则判据就低拉回，
    绝不用它把 partial 抬高成 achieved（自评始终只是附加信号）。

    刻意用精确标签匹配，不用单字「缺/补充」子串——后者会把
    「部分达成（仍缺细节）」「已补齐数据」这类正常自评误降级，
    反而制造新的达成度误判。hard_rules 指示模型写的就是 [达成度: 待补输入]。
    """
    s = (self_rating or "").strip()
    if not s:
        return False
    return bool(re.search(r"待补输入|need[ _]?input", s, re.IGNORECASE))


def judge_completion(*, clarify: bool = False, interrupted: bool = False,
                     ok: bool = False, source: str = "", output: str = "") -> str:
    """规则判据：这一步对用户目标而言达成到什么程度。
    只依据已确定字段判断，不调用模型、不猜测——P1 账本可复算。"""
    if clarify:
        return COMPLETION_NEED_INPUT
    if interrupted:
        return COMPLETION_PARTIAL
    text = (output or "").strip()
    if ok and source == "llm" and text:
        return COMPLETION_ACHIEVED
    return COMPLETION_PARTIAL


# 会话脉络连续性（v0.9.37）：前端把历史真实轮次压缩成一段「会话摘要」随新问题
# 一起下发，让模型看到连续上下文。但门控绝不能被摘要里历史的数据词污染——
# 否则「上一轮分析过 ERA5 数据，这一轮起草一份报告」会被误判成 analysis → clarify。
# 摘要用专用标记包裹，门控扫描前先剥离。标记前后端共用（index.html 同名常量）。
SESSION_DIGEST_BEGIN = "<<<会话摘要:历史背景·非本轮任务>>>"
SESSION_DIGEST_END = "<<<END会话摘要>>>"


def strip_session_digest(context: str) -> str:
    """剥掉会话摘要标记段，只留本轮真实任务语句（门控唯一依据）。

    只剥「完整闭合」的标记段：真实摘要由前端配对生成，永远有 BEGIN+END。
    未闭合标记一律当作普通文本保留——避免用户手输/粘贴半个标记时把本轮真实诉求
    一起删掉（复核发现：未闭合时曾把 BEGIN 之后整段丢弃，可能误伤分析类任务）。
    """
    s = context or ""
    i = s.find(SESSION_DIGEST_BEGIN)
    if i < 0:
        return s.strip()
    j = s.find(SESSION_DIGEST_END, i)
    if j < 0:
        return s.strip()          # 未闭合：保守不剥，当普通文本
    head = s[:i]
    tail = s[j + len(SESSION_DIGEST_END):]
    # 摘要通常附在末尾；若其后仍有本轮补充语句，一并保留供门控判断。
    return (head + "\n" + tail).strip()


def split_session_digest_for_prompt(context: str):
    """把 context 拆成 (本轮问题, 摘要正文)。供 execute prompt 用自然语言呈现历史，
    避免内部标记 <<<会话摘要…>>> 直接透传给模型（复核问题6）。未闭合标记不拆。"""
    s = context or ""
    i = s.find(SESSION_DIGEST_BEGIN)
    if i < 0:
        return s.strip(), ""
    j = s.find(SESSION_DIGEST_END, i)
    if j < 0:
        return s.strip(), ""
    head = s[:i].strip()
    tail = s[j + len(SESSION_DIGEST_END):].strip()
    body = s[i + len(SESSION_DIGEST_BEGIN):j].strip()
    clean = (head + ("\n" + tail if tail else "")).strip()
    return clean, body


def classify_task_kind(context: str) -> str:
    """识别任务类型：compose（起草/生成，产物就是文字）/ analysis（需外部数据）/ general。

    保守策略：只有明确起草信号才归 compose；明确的外部数据依赖优先归 analysis，
    保留模型诚实索要输入的能力。宁可漏判（走原行为）也不错判（该索要时不索要）。
    ★ 只扫描本轮原话：会话摘要（历史背景）必须先剥离，防止跨轮数据词污染门控。
    """
    text = strip_session_digest(context)
    if not text:
        return "general"
    if _DATA_DEPENDENT.search(text):
        return "analysis"
    if _COMPOSE_STRONG.search(text):
        return "compose"
    if _COMPOSE_VERBS.search(text) and _COMPOSE_PRODUCT.search(text):
        return "compose"
    return "general"


def compose_action_word(label: str) -> str:
    """起草类：把推演器的检索式动作词换成中性动作词（用户建议的做法）。
    若候选本身不含检索语义（如"覆盖代码评审与文档更新"）则原样保留，
    让用户点选的侧重仍能进入执行语境；命中检索词则降级为固定中性词。"""
    s = (label or "").strip()
    if not s or _RETRIEVAL_TERMS.search(s):
        return "按用户要求直接产出成果"
    return s


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
                 use_llm: bool = False, api_key: str = ""):
        self.llm_url = llm_base_url
        self.llm_model = llm_model
        self.tracker = tracker
        # 默认本地确定性执行：本机主力模型（8083）单次就要 11s，
        # 每步都等它只会把「超时」刷满任务条。模型够快时用 EXEC_USE_LLM=1 打开。
        self.use_llm = use_llm
        # 鉴权：界面配置的云端模型（OpenAI 兼容）需要 Bearer；
        # 本地 llama.cpp 无鉴权，默认值 "EMPTY"/空时不发头。
        self.api_key = (api_key or "").strip()
        self._session: Optional[aiohttp.ClientSession] = None
        self._active_resp = None      # v0.9.16：正在读的流式响应，供 abort() 掐断

    def _auth_headers(self) -> dict:
        """此前 execute/refine/explain 全链路不带 Authorization：任何需鉴权的
        OpenAI 兼容端点一律 401，静默降级成「模型未返回有效内容」且不告诉
        用户是鉴权失败。forecaster 侧一直带（llm_forecaster._ask_llm），此处补齐。"""
        if self.api_key and self.api_key != "EMPTY":
            return {"Authorization": f"Bearer {self.api_key}"}
        return {}

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

    async def _llm(self, prompt: str, max_tokens: int = 220) -> "tuple[str, str]":
        """
        调用 LLM，返回 (文本, reason)。reason 为空即成功——与 _llm_stream 对齐。

        快速优先：关掉 thinking（推理型模型在 thinking 阶段常返回 content=null）、
        限制 token 与超时，避免单步把整条执行链拖到几十秒。

        v0.9.49.2：错误不再编码成 "[模型未返回文本]" 之类的哨兵字符串混进正文——
        那会让下游用 startswith("[") 反查错误，进而误杀任何以 "[" 开头的合法模型
        正文（如 "[草案] 一、…" 或 JSON 数组形输出）。错误一律走 reason 字段。
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
                headers=self._auth_headers(),
                timeout=aiohttp.ClientTimeout(total=25),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content = data["choices"][0]["message"].get("content")
                    if isinstance(content, str) and content.strip():
                        return content.strip(), ""
                    return "", "llm_no_content"
                return "", f"http_{resp.status}"
        except asyncio.TimeoutError:
            return "", "llm_timeout"
        except Exception as e:
            return "", f"llm_error: {e}"
        return "", "llm_unavailable"

    async def _llm_stream(self, prompt: str, max_tokens: int = 220,
                          on_chunk=None, cancel_event=None,
                          on_first_token=None, on_generation_done=None) -> "tuple[str, str]":
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
                headers=self._auth_headers(),
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

                first_token_hit = False

                async def handle_line(line: str):
                    nonlocal n_tokens, first_token_hit
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
                        # v0.9.41：首个真实内容 token 到达 = prefill 已完成、生成段开始。
                        # 此刻取快照作为指纹 before，差分只覆盖生成段，排除模板
                        # prefill 的路由稀释（长模板会把判别力从 r=0.98 拉到 0.63）。
                        if not first_token_hit and on_first_token:
                            first_token_hit = True
                            try:
                                r = on_first_token()
                                if asyncio.iscoroutine(r):
                                    await r
                            except Exception:
                                pass
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
                        if on_generation_done:
                            try:
                                r = on_generation_done()
                                if asyncio.iscoroutine(r):
                                    await r
                            except Exception:
                                pass
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
                if on_generation_done:
                    try:
                        r = on_generation_done()
                        if asyncio.iscoroutine(r):
                            await r
                    except Exception:
                        pass

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
                      stream_sink=None, cancel_event=None,
                      task_kind: Optional[str] = None) -> Dict:
        """
        执行选定候选：单步真实 LLM 流式生成（路线 B）。

        planned_steps 来自前瞻推演，拼进 prompt 让模型沿规划作答（归因线索）。
        ★ v0.9.29 门控：起草类任务（产物就是文字）不得注入推演器的检索式
          label/steps，否则会被包装成数据分析任务，触发第 5 条索要输入 → clarify。
          task_kind="compose" 强制起草中性化；None 时按用户原话自动识别；
          "analysis"/"general" 保留原语义（真的缺数据时仍诚实 clarify）。
        stream_sink 收到 dict：{"type":"token","text":<增量>} 或
        {"type":"token","reset":True}（重试前清空前端流面板）。
        cancel_event（v0.9.16）被 set = 用户点了「停止生成」：中断流式请求，
        返回 interrupted=True 的部分结果，绝不返回 completed=True 的假完成。
        返回 {"completed", "output", "tasks", "chain", "source", "reason",
              "tokens", "elapsed_ms", "note", "task_kind", "interrupted?": ...}
        """
        kind = task_kind if task_kind in ("compose", "analysis", "general") \
               else classify_task_kind(context)
        if kind == "compose":
            # 起草中性化：动作词降级、规划步骤不注入、第 5 条改为「产物即文字，
            # 除非明确要求基于某份提供的数据，否则不得索要输入」。
            # 注意：这一步只改「语境判断」，不碰「是否真实调 LLM」——仍是真实生成。
            plan_line = ""
            label_line = f"你要做的事：{compose_action_word(candidate_label)}\n"
        else:
            plan_line = ""
            if planned_steps:
                plan_line = "已规划的做事顺序：" + " → ".join(planned_steps[:4]) + "\n"
            label_line = f"用户选择的做法：{candidate_label}\n"
        if kind == "compose":
            rule5 = (
                "5. 这是起草/写作类任务，产物就是文字本身。除非用户明确要求基于某份"
                "你拿不到的数据或文件，否则不得索要输入——直接写出成果。"
                "只有确实缺少用户指定的外部数据时，才以 [需要输入: 开头索要。"
            )
        else:
            rule5 = (
                "5. 如果任务需要具体数据或信息而用户没有提供，你无法诚实完成——"
                "严禁编造数字或事实。此时输出一个问题向用户索要缺失信息，"
                "以 [需要输入: 开头，后跟具体要什么。"
                "这是你作为智能体主动发起的交互，不是把任务推回去。"
            )
        # v0.9.37：把内部会话摘要标记转成自然语言「历史背景」——模型仍看到连续上下文，
        # 但不再把 <<<会话摘要…>>> 这类内部 token 当指令或脏数据（复核问题6）。
        _ctx_clean, _digest_body = split_session_digest_for_prompt(context)
        _history_line = (
            f"本会话此前的真实进展（供延续参考，非本轮任务）：\n{_digest_body}\n"
            if _digest_body else ""
        )
        final_prompt = (
            f"用户的问题：{_ctx_clean}\n"
            f"{_history_line}"
            f"{label_line}"
            f"{plan_line}"
            "你现在是智能体，这一步由你亲自完成，把成果直接交付给用户，而不是告诉用户去做什么事。\n"
            "硬性要求：\n"
            "1. 直接给出这一步的实际成果（整理好的结论、要点、方案），就像你已经真的做完了一样。\n"
            "2. 禁止出现网址、链接、URL、域名。\n"
            "3. 禁止对用户说「建议您访问」「您可以查看」「请搜索」「去某某网站」这类把任务推回给用户的话。\n"
            "4. 不要复述问题、不要写标题、不要客套。150字以内。\n"
            f"{rule5}"
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

        # v0.9.41 内部状态指纹：只统计「生成段」的专家路由。
        # 诊断铁证：裸问题判别力 r=0.978，套上执行长模板后塌到 0.636——模板
        # prefill 的路由稀释了任务信号。故 before 在首个真实 token 到达时取
        # （prefill 已完成），after 在生成完成时取，差分只覆盖生成段。
        # 采集是纯数据层——不新增完成信号、不改变执行语义、不碰 3D。
        _cap_on = bool(expert_state and expert_state.capture_enabled())
        expert_before = None
        expert_after = None

        async def cap_before():
            nonlocal expert_before
            if _cap_on:
                expert_before = await expert_state.snapshot_total(self.llm_url)

        async def cap_after():
            nonlocal expert_after
            if _cap_on:
                expert_after = await expert_state.snapshot_total(self.llm_url)

        def make_internal_state(source_val: str, interrupted: bool = False) -> dict:
            if not _cap_on:
                return expert_state.unavailable("capture_disabled") if expert_state \
                    else {"status": "unavailable", "reason": "capture_disabled"}
            try:
                return expert_state.finalize(
                    expert_before, expert_after,
                    source=source_val, interrupted=interrupted,
                    model=self.llm_model, temperature=0.6)
            except Exception:
                return {"status": "unavailable", "reason": "capture_error"}

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
                "task_kind": kind,
                "completion": COMPLETION_PARTIAL,
                "tokens": tokens_est,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "note": "已由用户中断",
                "internal_state": make_internal_state("local", interrupted=True),
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
                    cancel_event=cancel_event,
                    on_first_token=cap_before, on_generation_done=cap_after)
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
                    # v0.9.41：重试前清空第一次的快照，指纹只对应最终采用的生成段
                    if _cap_on:
                        expert_before = None
                        expert_after = None
                    text2, reason2 = await self._llm_stream(
                        harder, max_tokens=220, on_chunk=on_chunk,
                        cancel_event=cancel_event,
                        on_first_token=cap_before, on_generation_done=cap_after)
                    if reason2 == "interrupted":
                        return interrupted_result()
                    # v0.9.49.2：以 reason 判定成败（错误进 reason，正文 "[" 开头合法）
                    if text2 and not reason2 \
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
                    "task_kind": kind,
                    "completion": COMPLETION_NEED_INPUT,
                    "tokens": tokens_est,
                    "elapsed_ms": elapsed_ms,
                    "note": "",
                    "clarify": True,
                    "question": question,
                    "internal_state": make_internal_state("llm"),
                }

        # v0.9.49.2：reason 为空 = 模型真实文本（流式调用早已结构化返回错误；
        # 此前的 startswith("[") 哨兵会误杀 "[草案] 一、…" 这类合法开头正文）。
        if text and not reason:
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
            "task_kind": kind,
            "completion": judge_completion(
                ok=True, source=source, output=output),
            "tokens": tokens_est,
            "elapsed_ms": elapsed_ms,
            "note": note,
            "internal_state": make_internal_state(source),
        }

    async def refine(self, context: str, prior_output: str, instruction: str,
                     mode: str = "expand", task_kind: str = "",
                     cancel_event=None) -> Dict:
        """P0 产出层/迭代层：基于已拿到的一次成果做二次真实生成。

        mode='expand'  → 把 150 字要点扩成 400–800 字可直接用的完整成果；
        mode='followup' → 用户追问（展开/改写/换格式/深入某点），把上一轮
                          真实成果作为上下文继续深化。

        设计纪律：
        - 真调 LLM（同一个 /chat/completions 流式接口），绝不拼装模板冒充生成；
        - 走独立 executor 实例，不碰 execute 主链的 tracker/任务条/3D 状态；
        - 输入里的 prior_output 是模型自己上一轮的真实产出，不是编造；
        - 中断/忙/失败一律返回 ok=False，交由前端如实呈现，不伪造成果。

        返回 {"ok","output","source","completion","reason","tokens",
              "elapsed_ms","mode","note","interrupted?"}。
        """
        mode = mode if mode in ("expand", "followup", "synthesize") else "expand"
        t0 = time.monotonic()
        tokens_est = 0
        parts_out: List[str] = []

        if mode == "synthesize":
            # v0.9.35 发现1：把多轮真实产出综合成一份可直接交付的终版。
            # prior_output 由前端收集所有 source=llm 的 done 轮原文传入，后端只做综合，
            # 不引入素材外的新事实（严禁编造）——综合 ≠ 新生成。
            task_line = (
                "用户最初要的是：" + (context or "") + "\n"
                "下面是这次旅程中分多轮真实拿到的成果（逐轮原文，可能有重复/不同侧面）：\n"
                "---\n" + (prior_output or "") + "\n---\n"
                "请把以上真实成果综合成一份完整、去重、结构清晰的最终答案，"
                "作为用户可以直接带走的终版。"
            )
        elif mode == "expand":
            task_line = (
                "用户最初要的是：" + (context or "") + "\n"
                "之前只给了一份简短要点（这是模型真实产出）：\n"
                "---\n" + (prior_output or "") + "\n---\n"
                "现在把这份要点扩写成一份完整、结构清晰、可直接使用的成果。"
            )
        else:
            task_line = (
                "用户最初的任务：" + (context or "") + "\n"
                "之前已经拿到的成果（模型真实产出）：\n"
                "---\n" + (prior_output or "") + "\n---\n"
                "用户现在的要求：" + (instruction or "") + "\n"
                "基于上面的真实成果，按用户要求继续深化/改写。"
            )

        hard_rules = (
            "\n硬性要求：\n"
            "1. 直接给出完整成果本身，不要复述任务、不要客套、不要写「以下是」。\n"
            "2. 产物要能直接用：起草类给可照做的分条内容，分析类给结论+依据+建议。\n"
            "3. 400字以上、800字以内，用清晰的编号或小标题分块。\n"
            "4. 禁止网址、链接、域名；不要把任务推回给用户。\n"
            "5. 严禁编造你不知道的具体数字或事实；确实缺外部数据时，"
            "在正文后用一行写 [达成度: 待补输入] 并说明缺什么，其余情况不要写这行。"
        )
        if mode == "synthesize":
            # 综合模式：不追求字数下限（素材可能本就短），核心是「只用素材 + 去重」。
            hard_rules = (
                "\n硬性要求：\n"
                "1. 直接给出综合后的最终答案本身，不要客套、不要写「以下是综合结果」。\n"
                "2. 只使用上面逐轮原文里出现过的信息与结论，不得引入素材之外的数字、事实或新观点；"
                "同一内容合并一次，不同侧面按逻辑组织，矛盾处并列保留并标注「两种说法」。\n"
                "3. 结构清晰、可直接交付：起草类给分条可执行内容，分析类给结论+依据+建议。\n"
                "4. 字数以说清为准，不强行凑数；禁止网址、链接、域名；不要把任务推回给用户。"
            )
        final_prompt = task_line + hard_rules

        def interrupted_result() -> Dict:
            partial = "".join(parts_out).strip()
            return {
                "ok": False, "output": partial, "interrupted": True,
                "source": "llm" if partial else "local",
                "completion": COMPLETION_PARTIAL,
                "reason": "user_cancelled", "mode": mode,
                "tokens": tokens_est,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "note": "已由用户中断",
            }

        async def on_chunk(chunk: str):
            nonlocal tokens_est
            parts_out.append(chunk)
            tokens_est += max(1, round(len(chunk) / 1.6))

        text, reason = "", ""
        if self.use_llm:
            free = await self._wait_strata(12, cancel_event)
            if cancel_event is not None and cancel_event.is_set():
                return interrupted_result()
            if free:
                text, reason = await self._llm_stream(
                    final_prompt, max_tokens=1200, on_chunk=on_chunk,
                    cancel_event=cancel_event)
                if reason == "interrupted":
                    return interrupted_result()
            else:
                reason = "model_busy"
        else:
            reason = "llm_disabled"

        # （v0.9.49.2：删除旧的「正文以 [ 开头 → need_input」整段判定——那是
        # _llm 哨兵字符串时代的残留。缺数据的诚实出口自 v0.9.36 起就是模型在
        # 正文尾写 [达成度: 待补输入]，由下方 self_rating 解析 + 就低降级承接；
        # 裸 "[" 前缀只会误杀 "[草案] 一、…" 这类合法正文为 need_input 并丢弃。）

        if text and not self._pushes_back_to_user(text):
            # 模型自评：正文末尾的 [达成度: …] 只作为附加信号，规则判据仍独立记录。
            self_rating = ""
            m = re.search(r"\[达成度:\s*([^\]]+)\]", text)
            if m:
                self_rating = m.group(1).strip()
                text = text[:m.start()].strip()
            # 三轮审查断点1：这里原先硬编码 ACHIEVED —— 但 hard_rules 第5条明确让模型在
            # 「确实缺外部数据」时于正文后写 [达成度: 待补输入]。原 793 行的 NEED_INPUT
            # 识别只认「整段以 [ 开头」，正文末尾标记落到这里被硬判 achieved，等于
            # 「模型自认无解、系统却记成功」，污染 P0/P1 达成率。
            # 修复：规则判据独立算（judge_completion），self_rating 只作「就低不就高」的
            # 降级信号——它不能把 partial 抬成 achieved，但能把 achieved 拉回 need_input。
            completion = judge_completion(ok=True, source="llm", output=text)
            note = ""
            if _rating_means_need_input(self_rating):
                completion = COMPLETION_NEED_INPUT
                note = "模型自评仍需补充输入，未判为完全达成"
            return {
                "ok": True, "output": text, "source": "llm",
                "completion": completion, "self_rating": self_rating,
                "reason": "", "mode": mode, "tokens": tokens_est,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "note": note,
            }

        return {
            "ok": False, "output": "", "source": "local",
            "completion": COMPLETION_PARTIAL,
            "reason": reason or "llm_failed", "mode": mode,
            "tokens": tokens_est,
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
            "note": self.HONEST_FALLBACK.get(reason or "", "这一步没有产生成果"),
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
