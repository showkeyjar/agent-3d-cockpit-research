"""
Agent Cockpit Backend — FastAPI + WebSocket

在用户下一次输入之前，主动推演上下文所有可能的走向，
通过 WebSocket 流式推送分歧度、路形、候选走向、任务状态。

Usage:
    uvicorn server:app --host 0.0.0.0 --port 8770

Then open index.html — it will auto-connect to ws://localhost:8770/ws
(统一端口 8770：与 backend-watchdog.py / README / m-instrument.html / 测试脚本一致)
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── 路径 ──
BACKEND_DIR = Path(__file__).parent.resolve()
PROJECT_DIR = BACKEND_DIR.parent
FORECASTER_DIR = PROJECT_DIR / "forecaster"
sys.path.insert(0, str(FORECASTER_DIR))

from core import (
    SpeculativeForecaster,
    Candidate,
    RoadType,
    compute_divergence,
    road_type_from_divergence,
    cluster_candidates,
    DIVERSIFY_EPS_HASH,
    DIVERSIFY_EPS_SEMANTIC,
)
from llm_forecaster import LLMCandidateSampler
from projection import project_to_3d, multimodal_projection
from task_tracker import TaskTracker, AgentExecutor, judge_completion
import llm_config
import expert_state   # v0.9.41：真实 MoE 聚合专家指纹采集（P1/P2 凭据，纯数据层）

# ──────────────────────────────────────────────
# App
# ──────────────────────────────────────────────

app = FastAPI(title="Agent Cockpit Backend", version="0.3.0")

# CORS：本地研究原型默认只允许同源/本地回环来源。生产或跨机访问时由
# COCKPIT_CORS_ORIGINS 环境变量显式指定（逗号分隔），不要用 "*" 暴露到公网。
_CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "COCKPIT_CORS_ORIGINS",
        "http://localhost:8770,http://127.0.0.1:8770,"
        "http://localhost:8899,http://127.0.0.1:8899",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────
# LLM 配置（从环境变量读取，有默认值）
# ──────────────────────────────────────────────

# 配置统一由 llm_config 管理：环境变量默认值 + llm-config.json 覆盖 + 界面热更新。
# 无配置文件时与旧版完全一致（读同样的环境变量）。别名仍须与 llama-server
# 启动时的 -a 注册名一致，否则 forecast 被拒 → 退回本地模板（路牌退化）。
# 用函数取值而非模块常量，保证界面改配置后 forecast/execute 下一次即用新值。
def LLM_BASE_URL() -> str: return llm_config.get("base_url")
def LLM_MODEL() -> str: return llm_config.get("model")
def LLM_API_KEY() -> str: return llm_config.get("api_key")
def LLM_EMBEDDING_MODEL() -> str: return llm_config.get("embedding_model")
def EXEC_USE_LLM() -> bool: return llm_config.get("exec_use_llm")

# ──────────────────────────────────────────────
# 全局推理器（懒初始化）
# ──────────────────────────────────────────────

_forecaster: SpeculativeForecaster | None = None
_fast_forecaster: SpeculativeForecaster | None = None
_forecaster_cfg_version: int = -1   # 推理器是按当前 LLM 配置构建的；配置变更即失效

# LLM 配置块结束（字段定义见上方函数）—— 保持模块级符号 LLM_BASE_URL 等为函数，
# 界面热更新后下一次 get_forecaster/execute 自动读取新值。


def _build_forecaster(force_local: bool) -> SpeculativeForecaster:
    sampler = LLMCandidateSampler(
        base_url=LLM_BASE_URL(),
        model=LLM_MODEL(),
        api_key=LLM_API_KEY(),
        embedding_model=LLM_EMBEDDING_MODEL() or None,
    )
    sampler.force_local = force_local
    # embedding 决策落地：默认 hashed-TF（eps 0.60，诚实近似）；配置
    # LLM_EMBEDDING_MODEL 且不同于生成模型时自动切真实 embedding 语义档（eps 0.38）。
    _div_eps = (
        DIVERSIFY_EPS_SEMANTIC if sampler.uses_semantic_embedding()
        else DIVERSIFY_EPS_HASH
    )
    return SpeculativeForecaster(sampler=sampler, k=5, diversify_eps=_div_eps)


def get_forecaster(fast: bool = False) -> SpeculativeForecaster:
    """fast=True 使用独立的纯本地实例，与正在跑 LLM 的实例互不干扰。

    配置热更新后版本号变化 → 重建实例，下一次推演/执行即用新模型参数。
    """
    global _forecaster, _fast_forecaster, _forecaster_cfg_version
    cur_ver = llm_config.version()
    if cur_ver != _forecaster_cfg_version:
        _forecaster = None
        _fast_forecaster = None
        _forecaster_cfg_version = cur_ver
    if fast:
        if _fast_forecaster is None:
            _fast_forecaster = _build_forecaster(True)
        return _fast_forecaster
    if _forecaster is None:
        _forecaster = _build_forecaster(False)
    return _forecaster


# ──────────────────────────────────────────────
# REST API
# ──────────────────────────────────────────────

@app.get("/api/health")
async def health():
    """健康检查：顺带报告模型服务是否在线。兼容 strata（/status）、llama.cpp（/health）
    与任意 OpenAI 兼容端点（{base}/models：Ollama / vLLM / 云端）。FI-06。"""
    def probe():
        import urllib.request
        from urllib.parse import urlsplit
        # 本机 HTTP_PROXY 会误转发 127.0.0.1/localhost 请求 → 探针超时误报 unknown。
        # 回环地址用空 ProxyHandler 强制直连；远程端点尊重系统代理。
        u = urlsplit(LLM_BASE_URL())
        opener = (
            urllib.request.build_opener(urllib.request.ProxyHandler({}))
            if u.hostname in ("localhost", "127.0.0.1", "::1")
            else urllib.request.build_opener()
        )
        try:
            with opener.open(f"{u.scheme}://{u.netloc}/status", timeout=3) as r:
                st = json.loads(r.read())
            return {
                "llm_service": "strata",
                "llm_busy": bool(st.get("busy") or (st.get("queued") or 0) > 0),
                "llm_prompt_tokens": st.get("prompt_tokens", 0),
            }
        except Exception:
            pass
        try:
            with opener.open(f"{u.scheme}://{u.netloc}/health", timeout=3) as r:
                if r.status == 200:
                    return {"llm_service": "llamacpp", "llm_busy": None, "llm_prompt_tokens": 0}
        except Exception:
            pass
        # FI-06：OpenAI 兼容 /models 探测（Ollama 的 /v1 无 /health，此前误报 unknown）。
        # 只读模型列表，不消耗推理槽；带鉴权头以兼容云端端点。
        try:
            base = LLM_BASE_URL().rstrip("/")
            key = LLM_API_KEY()
            headers = {"Authorization": f"Bearer {key}"} if key and key != "EMPTY" else {}
            req = urllib.request.Request(base + "/models", headers=headers)
            with opener.open(req, timeout=4) as r:
                body = json.loads(r.read(65536))
            if isinstance(body.get("data"), list):
                return {"llm_service": "openai_compat", "llm_busy": None, "llm_prompt_tokens": 0}
        except Exception:
            pass
        return {"llm_service": "unknown", "llm_busy": None, "llm_prompt_tokens": 0}

    info = await asyncio.to_thread(probe)
    # 向量编码来源如实上报：semantic（真实 embedding，语义档 eps 0.38）/
    # hash（hashed-TF 词面近似，eps 0.60）。供前端/评审核对，不粉饰。
    _embed_provider = (
        "semantic" if (LLM_EMBEDDING_MODEL() and LLM_EMBEDDING_MODEL() != LLM_MODEL())
        else "hash"
    )
    return {"status": "ok", "llm_url": LLM_BASE_URL(), "model": LLM_MODEL(),
            "embed_provider": _embed_provider,
            "embedding_model": LLM_EMBEDDING_MODEL() or None,
            "exec_use_llm": EXEC_USE_LLM(),
            "config_file": str(llm_config.CONFIG_PATH) if llm_config.CONFIG_PATH.exists() else None,
            **info}


class LLMConfigPatch(BaseModel):
    """界面下发的配置补丁。留空字段表示不改；api_key 空串表示保持原值。"""
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None
    embedding_model: str | None = None
    exec_use_llm: bool | None = None


@app.get("/api/config/llm")
async def get_llm_config():
    """读取当前生效的 LLM 配置（api_key 脱敏）+ 每个字段的来源标注。"""
    return llm_config.snapshot(mask=True)


@app.post("/api/config/llm")
async def post_llm_config(patch: LLMConfigPatch):
    """热更新 LLM 配置：写盘持久化 + 使推理器缓存失效。下一次调用即用新配置。

    诚实原则：api_key 永不明文回传；返回的是脱敏快照。
    """
    data = {k: v for k, v in patch.model_dump().items() if v is not None}
    if not data:
        return {"ok": False, "error": "没有可更新的字段", **llm_config.snapshot(mask=True)}
    cfg = llm_config.update(data, persist=True)
    return {"ok": True, "config": cfg}


@app.post("/api/config/llm/reset")
async def reset_llm_config():
    """清除界面覆盖，回到环境变量/默认值。"""
    cfg = llm_config.reset_to_defaults(persist=True)
    return {"ok": True, "config": cfg}


@app.post("/api/config/llm/test")
async def test_llm_config(patch: LLMConfigPatch | None = None):
    """用给定配置（不落盘）或当前配置测试模型端点连通性，返回真实响应或可读错误。

    只探测 /models 或 /health，不消耗推理槽、不生成内容。
    """
    from urllib.parse import urlsplit
    import urllib.request

    cfg = llm_config.snapshot(mask=False)
    if patch is not None:
        for k, v in patch.model_dump().items():
            if v is not None and not (k == "api_key" and v == ""):
                cfg[k] = v
    base = str(cfg.get("base_url", "")).rstrip("/")
    model = cfg.get("model", "")
    result: dict[str, Any] = {"ok": False, "base_url": base, "model": model}

    def probe():
        u = urlsplit(base)
        origin = f"{u.scheme}://{u.netloc}"
        # 回环地址（本机模型）必须绕过 HTTP_PROXY，否则被误转发；
        # 远程端点则尊重系统代理配置。
        _opener = (
            urllib.request.build_opener(urllib.request.ProxyHandler({}))
            if u.hostname in ("localhost", "127.0.0.1", "::1")
            else urllib.request.build_opener()
        )
        # llama.cpp / vLLM 都支持 /health；先试它，快且不占槽
        for path in ("/health", "/v1/models"):
            try:
                req = urllib.request.Request(
                    origin + path,
                    headers={"Authorization": f"Bearer {cfg.get('api_key', 'EMPTY')}"},
                )
                with _opener.open(req, timeout=4) as r:
                    body = r.read(2048).decode("utf-8", "replace")
                    if path == "/v1/models":
                        try:
                            ids = [m.get("id") for m in json.loads(body).get("data", [])]
                            result["models"] = ids[:20]
                            result["model_registered"] = model in ids if ids else None
                        except Exception:
                            pass
                    return True, path, r.status, body[:200]
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
        return False, None, None, last

    ok, path, status, detail = await asyncio.to_thread(probe)
    result.update(ok=ok, probe_path=path, http_status=status, detail=detail)
    if ok:
        result["note"] = "端点可达。若 model_registered=false，检查模型别名是否与服务端一致。"
    else:
        result["note"] = "端点不可达。检查地址/端口，以及模型服务是否已启动。"
    return result


@app.get("/api/forecast")
async def forecast_api(context: str = "你好，帮我写一段Python爬虫", k: int = 3,
                       fast: int = 0):
    """
    REST 接口：同步前瞻推理
    GET /api/forecast?context=...&k=4

    返回:
      {
        "divergence": 0.47,
        "road_type": "fork",
        "execution_mode": "choice",  // direct | sequential | choice
        "candidates": [...],
        "clusters": [...],
        "cost_ms": 14500,
        "fork_count": 2
      }
    """
    fc = get_forecaster(fast=bool(fast))
    # forecast 内含阻塞的 LLM 调用，必须丢到线程池，
    # 否则会占住事件循环，让推演期间的 WS 消息（如 execute）排队卡住。
    loop = asyncio.get_running_loop()
    # 请求级 k 透传进采样器：前端要 5 个候选就给 5 个，不再写死 k=4
    result = await loop.run_in_executor(None, fc.forecast, context, k)
    # 判定执行模式：优先用 LLM 判断的问题类型
    qtype = getattr(result, 'question_type', 'choice')
    if qtype == 'direct':
        execution_mode = "direct"
    elif qtype == 'sequential':
        execution_mode = "sequential"
    else:
        execution_mode = "choice"
    # 多模态向量空间投影：按模态分层
    items = [
        {
            "label": c.label,
            "sub": c.sub,
            "vec": c.vec,
            "modality": c.modality,
            "color": c.color,
        }
        for c in result.candidates
    ]
    coords_3d = multimodal_projection(items, iterations=200)
    return {
        "divergence": round(result.divergence, 4),
        "road_type": result.road_type.value,
        "execution_mode": execution_mode,
        "candidates": [
            {
                "label": coords_3d[i]["label"],
                "sub": coords_3d[i]["sub"],
                "color": coords_3d[i]["color"],
                "modality": coords_3d[i]["modality"],
                "vec": result.candidates[i].vec.tolist(),
                "pos3d": coords_3d[i]["pos3d"],
                "steps": result.candidates[i].steps,
                "rationale": result.candidates[i].rationale,
            }
            for i in range(len(coords_3d))
        ],
        "clusters": result.clusters,
        "cost_ms": round(result.cost_ms, 1),
        "fork_count": result.fork_count,
        # 三轮审查断点6：从本次 ForecastResult 的快照读来源，不再读共享 sampler 属性
        # （并发请求会因 last_source 被互相覆盖而串线，导致 local/llm 冒充）。
        "source": getattr(result, "source", "local"),
        "fast": bool(fast),
    }


@app.get("/")
async def index():
    """返回前端页面"""
    return FileResponse(PROJECT_DIR / "index.html")


# 静态文件：three.js 本地库
app.mount("/vendor", StaticFiles(directory=PROJECT_DIR / "vendor"), name="vendor")


# ──────────────────────────────────────────────
# 记忆持久化 REST API (v0.5)
# ──────────────────────────────────────────────

from memory import MemoryStore

MEMORY_DB = BACKEND_DIR / "cockpit_memory.db"
_memory: MemoryStore | None = None


def get_memory() -> MemoryStore:
    global _memory
    if _memory is None:
        _memory = MemoryStore(MEMORY_DB)
    return _memory


@app.get("/api/journeys")
async def list_journeys(limit: int = 20):
    """列出最近的行驶记录"""
    return get_memory().list_journeys(limit)


@app.get("/api/journeys/{journey_id}")
async def get_journey(journey_id: int):
    """获取完整轨迹"""
    j = get_memory().get_journey(journey_id)
    if not j:
        return {"error": "journey not found"}
    return j


@app.post("/api/journeys")
async def save_journey(payload: dict[str, Any]):
    """保存一次行驶轨迹。

    字段白名单：只接收已知字段，未知键直接丢弃，避免任意 JSON 入库。
    类型做了最小校验，畸形值退回安全默认，不抛 500。
    """
    def _num(v, default=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    def _str(v, default=""):
        return v if isinstance(v, str) else (default if v is None else str(v))

    def _bool(v):
        return bool(v)

    def _list(v):
        return v if isinstance(v, list) else []

    allowed = {
        "title": _str(payload.get("title"), "未命名"),
        "context": _str(payload.get("context")),
        "divergence": _num(payload.get("divergence")),
        "road_type": _str(payload.get("road_type"), "straight"),
        "cost_ms": _num(payload.get("cost_ms")),
        "nodes": _list(payload.get("nodes")),
        "branches": _list(payload.get("branches")),
        "reached_end": _bool(payload.get("reached_end")),
        "meta": payload.get("meta") if isinstance(payload.get("meta"), (dict, type(None))) else None,
    }
    ms = get_memory()
    jid = ms.save_journey(**allowed)
    return {"journey_id": jid}


@app.delete("/api/journeys/{journey_id}")
async def delete_journey(journey_id: int):
    """删除一条轨迹"""
    ok = get_memory().delete_journey(journey_id)
    return {"deleted": ok}


# ──────────────────────────────────────────────
# WebSocket — 流式推演
# ──────────────────────────────────────────────

class WSConnection:
    """管理一个 WebSocket 连接的会话状态"""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.context = ""
        self.phase = "IDLE"
        self.tasks: list[dict] = []
        self.forecast_result: dict = {}
        self.send_lock = asyncio.Lock()
        self.exec_lock = asyncio.Lock()
        # v0.9.16 停止生成：每次 execute 有独立的取消信号；cancel 消息 set 它，
        # 同时直接 abort 正在读的流式 HTTP 响应（真正让模型停下来，不是前端假停）。
        self.cancel_event: asyncio.Event | None = None
        self.active_executor = None
        self.exec_task: asyncio.Task | None = None
        # 三轮审查断点7：cancel 必须与「持锁正在运行那一轮」绑定。连续两次 execute
        # 时第二次会排队，而共享 cancel_event 被覆盖 → cancel 只 set 到排队轮，真正
        # 在跑的那轮 abort 后查自己旧 event 未 set，被误记为 error/achieved。
        # cancel_epoch 每次 cancel +1；排队轮获锁后若发现提交后发生过 cancel 就跳过。
        self.cancel_epoch = 0
        self.active_cancel_event: asyncio.Event | None = None
        # v0.9.49.2：本连接派生的全部后台任务（execute/refine/explain）。
        # 此前 exec_task 只存最后一轮（旧引用被覆盖丢失）、refine/explain 连引用
        # 都不存——WS 断开后在飞 LLM 生成继续白烧单槽 55–70s，异常还会成为
        # "Task exception was never retrieved"。断开时统一收尾（见 ws_endpoint）。
        self.bg_tasks: set[asyncio.Task] = set()
        # refine 独立通道的取消信号与执行器：「停止生成」此前只作用于 execute，
        # refine 一旦发起只能等 70s 超时（cancel_event 建完无人 set）。
        self.refine_cancel_event: asyncio.Event | None = None
        self.refine_executor = None

    def track(self, task: asyncio.Task) -> asyncio.Task:
        """登记后台任务，完成即自动移除。"""
        self.bg_tasks.add(task)
        task.add_done_callback(self.bg_tasks.discard)
        return task

    async def shutdown(self):
        """连接断开：让在飞任务走「用户中断」路径真实收尾（掐断 LLM 流、
        释放单槽）。先给一个短窗口走协作式中断（interrupted 语义、部分文本、
        任务条 stop——与用户主动点停止完全一致），窗口内未收口的才兜底
        cancel。收尾里的 send 会失败但被自吞，无妨。"""
        if self.active_cancel_event is not None:
            self.active_cancel_event.set()
        if self.active_executor is not None:
            await self.active_executor.abort()
        if self.refine_cancel_event is not None:
            self.refine_cancel_event.set()
        if self.refine_executor is not None:
            await self.refine_executor.abort()
        pending = [t for t in self.bg_tasks if not t.done()]
        if pending:
            await asyncio.wait(pending, timeout=1.5)
        still = [t for t in self.bg_tasks if not t.done()]
        for t in still:
            t.cancel()
        if still:
            await asyncio.gather(*still, return_exceptions=True)

    async def send(self, msg: dict):
        # task_update 回调是 create_task 异步发出的，和主流程 send 会并发写同一个 WS，
        # 必须串行化，否则 ASGI 会抛 "Unexpected ASGI message"。
        async with self.send_lock:
            try:
                await self.ws.send_json(msg)
            except Exception:
                pass


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """
    WebSocket 协议：

    客户端 → 服务端:
      {
        "type": "forecast",
        "context": "帮我开发一个爬虫",
        "k": 4
      }

    服务端 → 客户端（流式推演过程）:
      {"type": "status",  "phase": "sampling",  "msg": "采样候选走向中…"}
      {"type": "status",  "phase": "encoding",  "msg": "编码 embedding…"}
      {"type": "status",  "phase": "divergence", "msg": "计算分歧度…"}
      {"type": "status",  "phase": "clustering", "msg": "聚类分析…"}
      {"type": "status",  "phase": "road_type",  "msg": "判定路形…"}

    服务端 → 客户端（推演结果）:
      {
        "type": "forecast_result",
        "divergence": 0.47,
        "road_type": "fork",
        "candidates": [...],
        "clusters": [...],
        "cost_ms": 14500,
        "fork_count": 2
      }

    服务端 → 客户端（任务状态更新）:
      {
        "type": "task_update",
        "name": "检索知识库",
        "status": "run|done|wait",
        "progress": 0.5,
        "sub": "RAG · 12 篇命中"
      }

    服务端 → 客户端（路线 B：token 流式增量）:
      {
        "type": "token",
        "text": "…模型本次生成的增量文本…",   // 逐字累积即真实进度
        "reset": false                        // 重试前发送 true，前端清空流面板
      }

    v0.9.16 停止生成：
      客户端 → 服务端: {"type": "cancel"}
      服务端 → 客户端: {"type": "cancel_ack", "active": true|false}
      服务端 → 客户端: {"type": "execute_done", "interrupted": true,
                         "ok": false, "reason": "user_cancelled",
                         "output": "<中断前已真实生成的部分文本>",
                         "tasks": [...status='stop'...], "chain": ["output"],
                         "tokens": ..., "elapsed_ms": ...}
      契约：一定回 execute_done；绝不发 completed/ok=true 的假完成，
            也不会把它写成「模型未返回有效内容」的降级失败。
    """
    await ws.accept()
    conn = WSConnection(ws)

    try:
        while True:
            data = await ws.receive_json()

            if data.get("type") == "forecast":
                context = data.get("context", "")
                k = data.get("k", 4)
                # 与 REST /api/forecast 保持字段一致：透传 fast（0/1），
                # 不传则走完整推演（默认），避免两通道行为分裂。
                fast = data.get("fast", 0)
                conn.context = context
                await run_forecast_stream(conn, context, k, fast)

            elif data.get("type") == "ping":
                await conn.send({"type": "pong", "ts": time.time()})

            elif data.get("type") == "reset":
                conn.phase = "IDLE"
                conn.tasks.clear()
                await conn.send({"type": "reset_ack"})

            elif data.get("type") == "execute":
                # 后台执行，不阻塞接收循环：用户可连续点击 / 重新选路。
                # 三轮审查断点7：每轮独立 cancel_event，并在「持锁后」才登记为活跃轮，
                # 这样排队轮不会覆盖正在运行那轮的取消信号。
                my_cancel = asyncio.Event()
                conn.cancel_event = my_cancel       # 兼容旧读点
                submitted_epoch = conn.cancel_epoch  # 提交时的纪元快照
                conn.exec_task = conn.track(asyncio.create_task(
                    run_execute(conn, data, my_cancel, submitted_epoch)))

            elif data.get("type") == "cancel":
                # v0.9.16：停止生成。协作式取消 + 立即掐断流式 HTTP 连接；
                # 收尾由 run_execute 的 finally 统一发 execute_done(interrupted)。
                # 三轮审查断点7：cancel 只作用于「持锁正在运行」的那一轮——用
                # active_cancel_event + active_executor，而不是 conn.cancel_event
                # （后者可能属于排队中、尚未开跑的第二轮）。epoch++ 让排队轮获锁后
                # 自查跳过，避免停了 A 却把 B 记成执行完成。
                conn.cancel_epoch += 1
                # 复核补充：active 不仅看「持锁运行轮」，也看是否有未完成的 exec_task
                # （排队轮）——否则 A 刚结束/B 未获锁的窗口内 cancel 会回 active=false，
                # 但 epoch++ 仍会跳过 B，反馈与实际不符。
                active = (conn.active_cancel_event is not None) or \
                         bool(conn.exec_task and not conn.exec_task.done())
                if conn.active_cancel_event is not None:
                    conn.active_cancel_event.set()
                    if conn.active_executor is not None:
                        await conn.active_executor.abort()
                # 停止生成同时作用于 refine 通道（此前 refine 无法停止，只能等 70s 超时）
                if conn.refine_cancel_event is not None:
                    conn.refine_cancel_event.set()
                if conn.refine_executor is not None:
                    await conn.refine_executor.abort()
                await conn.send({"type": "cancel_ack", "active": active})

            elif data.get("type") == "refine":
                # P0 产出层/迭代层：基于已拿到的一次成果做二次真实生成，
                # 独立后台任务，不占用/不重置 execute 的 cancel/任务条状态。
                conn.track(asyncio.create_task(run_refine(conn, data)))

            elif data.get("type") == "explain":
                # 驾驶前认知对齐：把路牌翻译成大白话，后台执行不阻塞
                conn.track(asyncio.create_task(run_explain(conn, data)))

            elif data.get("type") == "set_context":
                # 前端主推演走 REST，这里同步一次上下文，保证 WS 会话可用
                conn.context = data.get("context", "")
                await conn.send({"type": "context_ack"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] error: {e}")
    finally:
        # v0.9.49.2：断开即收尾在飞任务（此前断开后 execute 继续持锁跑满
        # 55s、refine 70s，白烧单槽且异常 unretrieved）。
        await conn.shutdown()


async def run_forecast_stream(conn: WSConnection, context: str, k: int, fast: int = 0):
    """流式推演：先推状态更新，再推结果

    k / fast 透传自前端请求，与 REST /api/forecast 字段对齐（修复此前
    WS 通道丢弃 k、且 fast 不一致的分裂行为）。
    """

    fc = get_forecaster(fast=bool(fast))

    # 阶段 1: 采样
    await conn.send({"type": "status", "phase": "sampling", "msg": "采样候选走向中…"})

    # 在线程池中跑推理（LLM 调用是阻塞的）
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, fc.forecast, context, k)

    # 阶段 2: 编码
    await conn.send({"type": "status", "phase": "encoding", "msg": "编码 embedding…"})

    # 阶段 3: 分歧度
    await conn.send({"type": "status", "phase": "divergence", "msg": f"分歧度 D={result.divergence:.4f}"})

    # 阶段 4: 聚类
    await conn.send({"type": "status", "phase": "clustering", "msg": f"聚类 {len(result.clusters)} 簇"})

    # 阶段 5: 路形
    rt_label = {
        RoadType.STRAIGHT: "直道 · STRAIGHT",
        RoadType.CURVE: "缓弯 · CURVE",
        RoadType.FORK: "分岔路口 · FORK",
    }[result.road_type]
    await conn.send({"type": "status", "phase": "road_type", "msg": rt_label})

    # 多模态向量空间投影
    items = [
        {"label": c.label, "sub": c.sub, "vec": c.vec, "modality": c.modality, "color": c.color}
        for c in result.candidates
    ]
    coords_3d = multimodal_projection(items, iterations=200)

    # 判定执行模式：优先用 LLM 判断的问题类型
    qtype = getattr(result, 'question_type', 'choice')
    if qtype == 'direct':
        execution_mode = "direct"
    elif qtype == 'sequential':
        execution_mode = "sequential"
    else:
        execution_mode = "choice"

    # 推演结果
    forecast_msg = {
        "type": "forecast_result",
        "divergence": round(result.divergence, 4),
        "road_type": result.road_type.value,
        "execution_mode": execution_mode,
        "candidates": [
            {
                "label": coords_3d[i]["label"],
                "sub": coords_3d[i]["sub"],
                "color": coords_3d[i]["color"],
                "modality": coords_3d[i]["modality"],
                "vec": result.candidates[i].vec.tolist(),
                "pos3d": coords_3d[i]["pos3d"],
                "steps": result.candidates[i].steps,
                "rationale": result.candidates[i].rationale,
            }
            for i in range(len(coords_3d))
        ],
        "clusters": result.clusters,
        "cost_ms": round(result.cost_ms, 1),
        "fork_count": result.fork_count,
        # 三轮审查断点6：同上，逐请求快照来源，杜绝并发串线冒充。
        "source": getattr(result, "source", "local"),
    }
    conn.forecast_result = forecast_msg
    await conn.send(forecast_msg)

    # 任务追踪在用户选路后由 execute 消息触发（见 ws_endpoint）


async def run_execute(conn: WSConnection, data: dict, cancel_event=None, submitted_epoch=0):
    """
    执行选定候选的任务链：真实 LLM 推理 + 流式任务上报。

    契约：**无论成功、失败、超时还是被用户中断，都会回一条 execute_done**，
    前端据此解锁「执行中」状态，绝不静默挂起。

    v0.9.16：cancel_event 被 set 时，执行器关闭流式响应、返回部分文本，
    这里如实发 execute_done(interrupted=true, ok=false)，不发任何完成态。
    """
    async with conn.exec_lock:
        # 三轮审查断点7：拿到锁 = 本轮真正开跑，记录 epoch。活跃取消信号延后到
        # executor 创建成功后才登记（见下方），使其恰好落在 try/finally 覆盖范围内，
        # 避免构造异常时残留 active_cancel_event。
        epoch_at_start = conn.cancel_epoch
        # 排队期间若用户已按过停止（epoch 前进），本轮不应再执行——直接如实回一个
        # interrupted 收尾，不调用模型、不产生「停止后还在生成」的假进展。
        if epoch_at_start != submitted_epoch:
            done_skip = {
                "type": "execute_done", "output": "", "tasks": [], "ok": False,
                "label": str(data.get("label") or data.get("candidate_label") or "直接回答"),
                "source": "local", "reason": "user_cancelled", "chain": [],
                "note": "停止请求到达时本轮仍在排队，未开始生成", "completion": "partial",
                "interrupted": True, "cancel_late": False, "elapsed_ms": 0, "tokens": 0,
            }
            await conn.send(done_skip)
            return
        # 前端主推演走 REST /api/forecast，WS 会话里的 conn.context 往往为空。
        # 优先用 execute 消息自带的 context（这是过去「执行中」永久卡住的根因）。
        context = data.get("context") or conn.context or ""
        candidate_label = data.get("label") or data.get("candidate_label") or "直接回答"
        if not isinstance(candidate_label, str):
            candidate_label = "直接回答"
        conn.context = context
        # 前瞻阶段模型拆出的步骤：执行时真正用上，不再「推演完就丢」
        planned_steps = data.get("steps") or []
        if not isinstance(planned_steps, list):
            planned_steps = []
        planned_steps = [str(s)[:40] for s in planned_steps[:4]]
        # v0.9.29 任务类型门控：前端可显式指定 compose（起草类，中性化执行语境），
        # 后端也会按用户原话自动识别兜底（curl/直连路径同样受保护）。
        # 只接受三个合法值，其余交后端自动判断，避免客户端伪造未知类型。
        task_kind = data.get("task_kind")
        if task_kind not in ("compose", "analysis", "general"):
            task_kind = None

        t0 = time.monotonic()
        done = {
            "type": "execute_done",
            "output": "", "tasks": [], "ok": False,
            "label": candidate_label,
            "source": "local", "reason": "",
            "chain": [], "note": "", "elapsed_ms": 0, "tokens": 0,
            "planned_steps": planned_steps,
            "task_kind": task_kind or "",
            "completion": "partial",
            "interrupted": False, "cancel_late": False,
            # v0.9.41：内部状态指纹缺省不可用（各提前 return 路径也带此契约字段）
            "internal_state": expert_state.unavailable("not_collected"),
        }

        if not context:
            done["note"] = "没有上下文，请先做前瞻推演"
            done["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
            await conn.send(done)
            return

        await conn.send({"type": "execute_ack", "label": candidate_label})

        def on_task_update(task: dict):
            asyncio.create_task(conn.send({"type": "task_update", **task}))

        tracker = TaskTracker(callback=on_task_update)
        executor = AgentExecutor(LLM_BASE_URL(), LLM_MODEL(), tracker,
                                 use_llm=EXEC_USE_LLM(), api_key=LLM_API_KEY())
        conn.active_executor = executor   # cancel 时可直接 abort 它的流式响应

        await conn.send({"type": "status", "phase": "executing",
                         "msg": f"执行任务链: {candidate_label}"})

        # 路线 B（v0.9.12）：token 流式下发。每个 chunk 都是模型真实产出，
        # 前端直接渲染为「正在生成的文本」——进度=真实信号本身。
        async def stream_sink(payload: dict):
            await conn.send({"type": "token", **payload})

        try:
            # 三轮审查断点7（复核补充）：活跃取消信号在 try 内登记，由 finally 统一
            # 清理——构造/发送阶段若抛异常，活跃信号不会被登记，自然无残留。
            conn.active_cancel_event = cancel_event
            result = await asyncio.wait_for(
                executor.execute(context, candidate_label, planned_steps,
                                 stream_sink=stream_sink,
                                 cancel_event=cancel_event,
                                 task_kind=task_kind), timeout=55
            )
            if result.get("interrupted"):
                # 用户主动停止：部分文本 + stop 任务条 + 未完成标志。
                # 绝不能 ok=True，也绝不能套用「模型没有返回有效内容」的降级文案。
                done.update({
                    "interrupted": True,
                    "ok": False,
                    "output": (result.get("output") or "")[:400],
                    "tasks": result.get("tasks", []),
                    "chain": result.get("chain", ["output"]),
                    "source": result.get("source", "local"),
                    "reason": "user_cancelled",
                    "task_kind": result.get("task_kind", ""),
                    "completion": result.get("completion", "partial"),
                    "tokens": result.get("tokens", 0),
                    "note": "已由用户中断",
                    "internal_state": result.get("internal_state") or expert_state.unavailable("interrupted"),
                })
            else:
                done.update({
                    "output": (result.get("output") or "")[:400],
                    "tasks": result.get("tasks", []),
                    "chain": result.get("chain", []),
                    "source": result.get("source", "local"),
                    "reason": result.get("reason", ""),
                    "tokens": result.get("tokens", 0),
                    "note": result.get("note", ""),
                    "ok": True,
                    "clarify": result.get("clarify", False),
                    "question": result.get("question", ""),
                    "task_kind": result.get("task_kind", ""),
                    "completion": result.get("completion", "partial"),
                    # v0.9.41：内部状态指纹由 executor 紧贴真实 LLM 调用采集，
                    # 这里只透传；采集关闭/不可达/降级轮 executor 已标 unavailable。
                    "internal_state": result.get("internal_state") or expert_state.unavailable("not_collected"),
                })
        except asyncio.TimeoutError:
            # 不发 error：让前端用 execute_done 里的完整 tasks 展示结果卡
            done.update({"note": "执行超时，已自动收尾", "reason": "timeout",
                         "tasks": tracker.get_all()})
        except Exception as e:
            print(f"[execute] error: {e}")
            done.update({"note": str(e), "reason": "error",
                         "tasks": tracker.get_all()})
        finally:
            done["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
            # 停止请求在生成已正常结束后才到达：如实说明，不把完整结果倒标成中断
            if cancel_event is not None and cancel_event.is_set() and done.get("ok") \
               and not done.get("interrupted"):
                done["cancel_late"] = True
                done["note"] = (done.get("note") or "") + "；停止请求到达时已生成完毕"
            await conn.send(done)      # 一定会发，前端一定能解锁
            conn.active_executor = None
            # 三轮审查断点7：只有本轮登记的活跃信号才由本轮清理，避免排队轮收尾时
            # 误清掉正在运行那一轮的取消信号。
            if conn.active_cancel_event is cancel_event:
                conn.active_cancel_event = None
            await executor.close()


async def run_refine(conn: WSConnection, data: dict):
    """P0 产出层/迭代层（v0.9.30）：基于已拿到的一次成果做二次真实生成。

    与 run_execute 完全独立：自己的 executor、自己的 cancel_event、自己的
    refine_done 回执。不改主轴、不铺到达牌、不进 execute 的任务条——它是
    「把摘要变成可用成果」的深化通道，不是新一轮执行。前端把 refine_done
    作为带 parent_run_id 的账本轮次记入 P1，形成追问链。

    契约：无论成功/忙/中断/失败，都回一条 refine_done，绝不静默挂起。
    """
    context = str(data.get("context") or conn.context or "")[:600]
    mode = data.get("mode") if data.get("mode") in ("expand", "followup", "synthesize") else "expand"
    # v0.9.35 synthesize：素材是所有真实轮次原文，放宽上限；其余模式维持 1200。
    _prior_cap = 8000 if mode == "synthesize" else 1200
    prior_raw = str(data.get("prior_output") or "")
    # 三轮审查断点9：超长素材被静默硬切、却仍声称「综合全部真实轮次」——记下截断事实，
    # 稍后在回执里如实标注并把达成度降为 partial（可核对性 P4）。
    # 真正的截断常发生在前端（startSynthesize 也截 8000），故合并前端上报的 prior_truncated，
    # 两层任一截断都如实标注。
    _prior_truncated = len(prior_raw) > _prior_cap or bool(data.get("prior_truncated"))
    prior = prior_raw[:_prior_cap]
    instruction = str(data.get("instruction") or "")[:300]
    task_kind = data.get("task_kind")
    if task_kind not in ("compose", "analysis", "general"):
        task_kind = ""

    done = {
        "type": "refine_done", "mode": mode, "ok": False,
        "output": "", "source": "local", "completion": "partial",
        "self_rating": "", "reason": "", "note": "",
        "tokens": 0, "elapsed_ms": 0, "interrupted": False,
    }
    t0 = time.monotonic()
    # 三轮审查断点8：synthesize/expand 的承诺是「综合/扩写已拿到的真实成果」。
    # 空素材时若照常调 LLM，模型只能凭 context 编造，却被判 achieved——等于伪造。
    # 这里先做输入守卫：无真实素材直接拒绝，不调用模型、不发 achieved。
    # （前端 startSynthesize/startRefine 已有 parts.length<1 拦截；此守卫覆盖直连/竞态路径。）
    if not prior.strip():
        done.update({
            "reason": "no_material", "completion": "partial",
            "note": "没有可综合/扩写的真实素材，未调用模型",
        })
        done["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
        await conn.send(done)
        return
    # 并发守卫：上一轮 refine 还在跑时如实回 busy，不排队叠加
    # （后端单槽模型下并发 refine 只会互相等槽 + 覆盖取消信号）。
    if conn.refine_cancel_event is not None:
        done.update({"reason": "busy", "note": "上一轮深化仍在进行，请稍候再试"})
        done["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
        await conn.send(done)
        return
    cancel_event = asyncio.Event()
    tracker = TaskTracker(callback=lambda d: None)
    executor = AgentExecutor(LLM_BASE_URL(), LLM_MODEL(), tracker,
                             use_llm=EXEC_USE_LLM(), api_key=LLM_API_KEY())
    # v0.9.49.2：登记到连接，使「停止生成」与「连接断开」都能真正停掉 refine
    conn.refine_cancel_event = cancel_event
    conn.refine_executor = executor
    try:
        await conn.send({"type": "refine_ack", "mode": mode})
        result = await asyncio.wait_for(
            executor.refine(context, prior, instruction, mode=mode,
                            task_kind=task_kind, cancel_event=cancel_event),
            timeout=70,
        )
        done.update({
            "ok": bool(result.get("ok")),
            "output": (result.get("output") or "")[:6000],
            "source": result.get("source", "local"),
            "completion": result.get("completion", "partial"),
            "self_rating": result.get("self_rating", ""),
            "reason": result.get("reason", ""),
            "note": result.get("note", ""),
            "tokens": result.get("tokens", 0),
            "interrupted": bool(result.get("interrupted")),
        })
    except asyncio.TimeoutError:
        done.update({"reason": "timeout", "note": "展开生成超时，已如实收尾"})
    except Exception as e:
        print(f"[refine] error: {e}")
        done.update({"reason": "error", "note": str(e)})
    finally:
        # 三轮审查断点9：素材被硬切时如实标注，不冒充「综合了全部轮次」；达成度降为
        # partial（输出本身仍真实可用，只是覆盖范围不完整）。仅 synthesize 有此承诺。
        if _prior_truncated and mode == "synthesize" and done.get("ok"):
            done["completion"] = "partial"
            done["material_truncated"] = True
            done["note"] = (done.get("note") or "") + \
                f"（素材超过 {_prior_cap} 字已截断，综合仅覆盖前 {_prior_cap} 字）"
        done["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
        await conn.send(done)
        await executor.close()
        # 只有本轮登记的信号才由本轮清理（与 execute 的三轮审查断点7 同款纪律）
        if conn.refine_cancel_event is cancel_event:
            conn.refine_cancel_event = None
        if conn.refine_executor is executor:
            conn.refine_executor = None


async def run_explain(conn: WSConnection, data: dict):
    """
    驾驶前认知对齐：把智能体给出的路牌翻译成普通用户能懂的大白话。
    「看不懂可解释」是原始需求里明确的交互，之前一直缺失。

    契约：无论成功、忙、还是超时，都会回一条 explain_result，
    且 text 永远是一句能读的话（本地回退时基于路牌已知信息整理）。
    """
    context = str(data.get("context") or conn.context or "")[:200]
    label = str(data.get("label") or "")[:40]
    sub = str(data.get("sub") or "")[:80]
    steps = data.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    steps = [str(s)[:30] for s in steps[:4]]
    rationale = str(data.get("rationale") or "")[:60]

    def local_text() -> str:
        parts = []
        if sub:
            parts.append(sub)
        if steps:
            parts.append("具体会做：" + "、".join(steps))
        if rationale:
            parts.append("理由：" + rationale)
        return "；".join(parts) or f"「{label}」是智能体建议的一种做法。"

    out = {
        "type": "explain_result",
        "label": label,
        "text": local_text(),
        "source": "local",
        "reason": "",
    }
    if not label:
        out["reason"] = "nothing_to_explain"
        await conn.send(out)
        return

    if EXEC_USE_LLM():
        tracker = TaskTracker(callback=lambda t: None)
        executor = AgentExecutor(LLM_BASE_URL(), LLM_MODEL(), tracker, use_llm=True,
                                 api_key=LLM_API_KEY())
        try:
            # 解释是「用户明确发起」的请求，值得等一下推理槽
            if await asyncio.wait_for(executor._wait_strata(8), timeout=9):
                prompt = (
                    f"用户的问题：{context}\n"
                    f"系统给出的一个候选做法：{label}"
                    + (f"（{sub}）" if sub else "") + "\n"
                    + (f"规划的步骤：{'、'.join(steps)}\n" if steps else "")
                    + "请用最通俗的大白话，向完全不懂技术的普通用户解释这个做法："
                      "它是什么意思、为什么智能体要做、做完后智能体自己会交付什么。"
                      "70字以内，只用日常用语，不要术语，不要客套，不要复述问题。\n"
                      "特别注意：所有活儿都是智能体自己做。禁止说「你去查/访问/打开/浏览某网站、"
                      "某链接、某数据」这类把任务推回给用户的话，禁止出现任何网址。"
                )
                ans, ans_reason = await asyncio.wait_for(
                    executor._llm(prompt, max_tokens=160), timeout=28)
                # v0.9.49.2：_llm 已结构化返回 (text, reason)，错误看 reason，
                # 不再用 startswith("[") 哨兵（会误杀 "[" 开头的合法正文）
                if isinstance(ans, str) and ans.strip() and not ans_reason:
                    # 校验：解释文本同样禁止把任务推回给用户
                    if AgentExecutor._pushes_back_to_user(ans.strip()):
                        out["reason"] = "llm_pushed_back"   # 保留本地兜底文案
                    else:
                        out["text"] = ans.strip()
                        out["source"] = "llm"
                else:
                    out["reason"] = ans_reason or "llm_failed"
            else:
                out["reason"] = "model_busy"
        except asyncio.TimeoutError:
            out["reason"] = "timeout"
        except Exception as e:
            print(f"[explain] error: {e}")
            out["reason"] = "error"
        finally:
            await executor.close()

    await conn.send(out)


# ──────────────────────────────────────────────
# 启动
# ──────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    # 统一端口 8770（与 watchdog / README / m-instrument / 测试脚本一致）。
    # 推荐用看门狗或 `uvicorn server:app --port 8770` 启动，本分支仅作兜底。
    # 默认只绑回环：全 API 无鉴权 + WS 无 Origin 校验 + base_url 可热改，
    # 绑 0.0.0.0 会把「改 base_url → 触发 forecast/test → api_key 发往任意地址」
    # 变成同网段可达的密钥外带通道。需要跨机访问时显式设 HOST=0.0.0.0。
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", "8770")), log_level="info")
