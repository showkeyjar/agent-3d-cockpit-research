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
from task_tracker import TaskTracker, AgentExecutor
import llm_config

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
    """健康检查：顺带报告模型服务是否在线。兼容 strata（/status）与 llama.cpp（/health）。"""
    def probe():
        import urllib.request
        from urllib.parse import urlsplit
        # 本机 HTTP_PROXY 会误转发 127.0.0.1/localhost 请求 → 探针超时误报 unknown。
        # 用空 ProxyHandler 建 opener，强制直连回环地址。
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        u = urlsplit(LLM_BASE_URL())
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
        "source": getattr(fc.sampler, "last_source", "local"),
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
                # 后台执行，不阻塞接收循环：用户可连续点击 / 重新选路
                conn.cancel_event = asyncio.Event()
                conn.exec_task = asyncio.create_task(
                    run_execute(conn, data, conn.cancel_event))

            elif data.get("type") == "cancel":
                # v0.9.16：停止生成。协作式取消 + 立即掐断流式 HTTP 连接；
                # 收尾由 run_execute 的 finally 统一发 execute_done(interrupted)。
                active = bool(conn.exec_task and not conn.exec_task.done())
                if active:
                    conn.cancel_event.set()
                    if conn.active_executor is not None:
                        await conn.active_executor.abort()
                await conn.send({"type": "cancel_ack", "active": active})

            elif data.get("type") == "explain":
                # 驾驶前认知对齐：把路牌翻译成大白话，后台执行不阻塞
                asyncio.create_task(run_explain(conn, data))

            elif data.get("type") == "set_context":
                # 前端主推演走 REST，这里同步一次上下文，保证 WS 会话可用
                conn.context = data.get("context", "")
                await conn.send({"type": "context_ack"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] error: {e}")


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
        "source": getattr(fc.sampler, "last_source", "local"),
    }
    conn.forecast_result = forecast_msg
    await conn.send(forecast_msg)

    # 任务追踪在用户选路后由 execute 消息触发（见 ws_endpoint）


async def run_execute(conn: WSConnection, data: dict, cancel_event=None):
    """
    执行选定候选的任务链：真实 LLM 推理 + 流式任务上报。

    契约：**无论成功、失败、超时还是被用户中断，都会回一条 execute_done**，
    前端据此解锁「执行中」状态，绝不静默挂起。

    v0.9.16：cancel_event 被 set 时，执行器关闭流式响应、返回部分文本，
    这里如实发 execute_done(interrupted=true, ok=false)，不发任何完成态。
    """
    async with conn.exec_lock:
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
            "interrupted": False, "cancel_late": False,
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
                                 use_llm=EXEC_USE_LLM())
        conn.active_executor = executor   # cancel 时可直接 abort 它的流式响应

        await conn.send({"type": "status", "phase": "executing",
                         "msg": f"执行任务链: {candidate_label}"})

        # 路线 B（v0.9.12）：token 流式下发。每个 chunk 都是模型真实产出，
        # 前端直接渲染为「正在生成的文本」——进度=真实信号本身。
        async def stream_sink(payload: dict):
            await conn.send({"type": "token", **payload})

        try:
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
                    "tokens": result.get("tokens", 0),
                    "note": "已由用户中断",
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
            await executor.close()


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
        executor = AgentExecutor(LLM_BASE_URL(), LLM_MODEL(), tracker, use_llm=True)
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
                ans = await asyncio.wait_for(
                    executor._llm(prompt, max_tokens=160), timeout=28)
                if isinstance(ans, str) and ans.strip() and not ans.startswith("["):
                    # 校验：解释文本同样禁止把任务推回给用户
                    if AgentExecutor._pushes_back_to_user(ans.strip()):
                        out["reason"] = "llm_pushed_back"   # 保留本地兜底文案
                    else:
                        out["text"] = ans.strip()
                        out["source"] = "llm"
                else:
                    out["reason"] = "llm_failed"
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
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8770")), log_level="info")
