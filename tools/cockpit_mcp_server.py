#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent-3d-cockpit MCP Server — 把「智能体 3D 可视化驾驶舱」封装成智能体可调用的工具集。

设计原则（与原型 P1–P4 判据一致，勿回退）：
  - P1 真实性：execute 走真实后端 WebSocket，返回真实 LLM 输出；不伪造完成。
  - P2 可核对：透传 source 四态(llm/fast/local/offline)、elapsed_ms、tokens、chain、reason，
               让调用方能核对「这一步到底是不是真模型做的」。
  - P3 可追溯：forecast 返回候选 label/steps/rationale，execute 带回 label/planned_steps。
  - P4 可感知：open_cockpit 给出可视化入口 URL，供人在 3D 路空间里看到过程。

诚实边界：
  - clarify（反问澄清）与 interrupted（用户中断）是合法状态，原样返回，不包装成成功。
  - 后端 8770 不可达时明确报错并给出启动指引，绝不返回兜底数据冒充真实结果。
  - health 报的 llm_service/busy 如实透传，health=200 不等于槽位空闲。

运行：由 WorkBuddy 通过 stdio 拉起（见 ~/.workbuddy/mcp.json），或本地直跑调试：
  D:/tools/Python312/python.exe tools/cockpit_mcp_server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import webbrowser
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer

# ── 配置：可用环境变量覆盖，默认跟随项目约定 ────────────────────────────
BACKEND_BASE = os.environ.get("COCKPIT_BACKEND", "http://127.0.0.1:8770")
BACKEND_WS = os.environ.get("COCKPIT_BACKEND_WS", "ws://127.0.0.1:8770/ws")
HTTP_TIMEOUT = float(os.environ.get("COCKPIT_HTTP_TIMEOUT", "90"))

# 来源四态诚实标注
SOURCE_LABEL = {
    "llm": "模型推演（真实调用）",
    "fast": "本地快速预览（未调用模型）",
    "local": "本地兜底（模型未参与）",
    "offline": "前端固定模板（后端不可达）",
}

server = MCPServer(
    name="agent-3d-cockpit",
    title="智能体 3D 可视化驾驶舱",
    instructions=(
        "把智能体的岔口推演与真实执行可视化为 3D 路径驾驶。"
        "先用 forecast 看候选方向，再用 execute 真实执行某条路，"
        "用 open_cockpit 让用户在 3D 路空间看到过程。"
        "所有 source 四态如实返回，local/offline 不可当作模型结果。"
    ),
)


def _annotate_source(source: str | None) -> dict[str, Any]:
    s = source or "unknown"
    return {
        "source": s,
        "source_label": SOURCE_LABEL.get(s, "未知来源"),
        "is_real_llm": s == "llm",
    }


async def _http_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET 后端 REST；不可达时抛可读错误（不返回兜底）。"""
    url = BACKEND_BASE + path
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            r = await client.get(url, params=params or {})
            r.raise_for_status()
            return r.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as e:
        raise RuntimeError(
            f"驾驶舱后端 {url} 不可达（{e.__class__.__name__}）。"
            "请先启动：cd prototype/backend && uvicorn server:app --port 8770，"
            "并确保看门狗或手动进程在跑。"
        )
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"后端返回 HTTP {e.response.status_code}: {url}")


@server.tool()
async def health() -> str:
    """检查驾驶舱后端与 LLM 服务状态。做任何推演/执行前先调它确认服务在线。

    返回后端 health 原文 + 来源标注。注意 health=200 不代表模型槽位空闲——
    单槽模型忙时推演会走 local 兜底，看 forecast/execute 返回的 source 才是准。
    """
    info = await _http_get("/api/health")
    lines = [
        f"后端状态: {info.get('status', '?')}  ({BACKEND_BASE})",
        f"LLM 端点: {info.get('llm_url', '?')}  模型: {info.get('model', '?')}",
        f"LLM 服务: {info.get('llm_service', '?')}  忙碌: {info.get('llm_busy', '?')}",
        f"向量编码: {info.get('embed_provider', '?')}",
    ]
    if info.get("status") != "ok":
        lines.append("⚠ 后端未就绪，推演/执行可能不可用。")
    lines.append("提示：health 正常 ≠ 模型槽位空闲，请以 forecast/execute 的 source 判断。")
    return "\n".join(lines)


@server.tool()
async def forecast(context: str, k: int = 3, fast: bool = False) -> str:
    """路径推演：把用户任务拆成若干真实候选方向（岔口/路牌），供选择后执行。

    Args:
        context: 用户原始任务描述（用原话，别概括——路牌业务词绑定依赖原话真实短语）。
        k: 想要的候选方向数量，默认 3。
        fast: True 走本地快速预览（秒级，source=local/fast，未调模型）；
              False 走完整模型推演（慢，占模型单槽，source 可能为 llm 或兜底 local）。
              默认 False。模型忙或只想快速看岔口时用 True。

    返回分歧度、路形、执行模式、候选(label/sub/steps/rationale)、聚类与来源四态。
    source 如实标注：若返回 local/fast，不要用「模型分析认为…」措辞复述。
    """
    data = await _http_get(
        "/api/forecast",
        params={"context": context, "k": k, "fast": 1 if fast else 0},
    )
    src = _annotate_source(data.get("source"))
    candidates = data.get("candidates", [])
    cand_lines = []
    for i, c in enumerate(candidates):
        steps = c.get("steps") or []
        cand_lines.append(
            f"  [{i}] {c.get('label', '?')} — {c.get('sub', '')}\n"
            f"      理由: {c.get('rationale', '')}\n"
            f"      规划步骤: {'; '.join(str(s) for s in steps) if steps else '(无)'}"
        )
    lines = [
        f"推演来源: {src['source_label']} (source={src['source']})",
        f"路形: {data.get('road_type', '?')}  执行模式: {data.get('execution_mode', '?')}",
        f"分歧度: {data.get('divergence', '?')}  岔路数: {data.get('fork_count', '?')}",
        f"候选数: {len(candidates)}  耗时: {data.get('cost_ms', '?')}ms",
        "",
        "候选方向:" if cand_lines else "候选方向: (无)",
        *cand_lines,
    ]
    if not src["is_real_llm"]:
        lines.append(
            "\n⚠ 本地/兜底推演（模型未参与）：以上是本地快速路牌，"
            "复述时请说「本地预览的候选方向」，不要说「模型认为」。"
        )
    lines.append(
        "\n下一步：选择一条候选，用 execute 真实执行（传该候选的 label、context、steps）。"
        "或用 open_cockpit 让用户在 3D 里点选。"
    )
    return "\n".join(lines)


@server.tool()
async def execute(
    context: str,
    label: str = "直接回答",
    steps: str = "",
    timeout: float = 70,
) -> str:
    """真实执行选定方向：走后端 WebSocket 调用真实 LLM，流式产出最终文本。

    Args:
        context: 用户原始任务（与 forecast 同一个 context，必填）。
        label: 选定的候选 label（forecast 返回的某条；默认「直接回答」）。
        steps: 该候选的规划步骤，用 JSON 数组字符串传入，如 '["检索资料","分析"]'；可空。
        timeout: 等待真实执行的秒数，默认 70（模型单槽慢，别设太短）。

    返回真实输出全文 + 凭据（source/elapsed_ms/tokens/chain/reason）。
    合法状态如实返回、不伪装成功：
      - source=llm 且 ok → 真实模型结果；
      - clarify（反问澄清）→ 任务模糊，模型在反问，需补充信息重跑；
      - interrupted（用户中断）→ 只有部分真实文本，未写成完成；
      - source=local + reason(model_busy/llm_failed...) → 诚实降级，未真正产出。
    """
    try:
        parsed_steps = json.loads(steps) if steps else []
        if not isinstance(parsed_steps, list):
            parsed_steps = []
    except (json.JSONDecodeError, TypeError):
        parsed_steps = []

    try:
        import websockets
    except ImportError:
        raise RuntimeError("execute 需要 websockets 库：pip install websockets")

    payload = {
        "type": "execute",
        "context": context,
        "label": label,
        "steps": [str(s)[:40] for s in parsed_steps[:4]],
        "mode": "auto",
        "candidate": 0,
    }

    events: list[dict[str, Any]] = []
    try:
        async with websockets.connect(BACKEND_WS, open_timeout=10) as ws:
            await ws.send(json.dumps(payload, ensure_ascii=False))
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout)
                msg = json.loads(raw)
                events.append(msg)
                if msg.get("type") == "execute_done":
                    break
    except (OSError, TimeoutError) as e:
        raise RuntimeError(
            f"连接驾驶舱 WebSocket {BACKEND_WS} 失败：{e}。"
            "请确认后端 8770 已启动。"
        )

    done = next((e for e in events if e.get("type") == "execute_done"), None)
    if done is None:
        raise RuntimeError(f"{timeout}s 内未收到 execute_done（可能超时/断线），未取得真实结果。")

    src = _annotate_source(done.get("source"))
    tokens_evt = [e for e in events if e.get("type") == "token"]
    streamed = "".join(e.get("text", "") for e in tokens_evt if not e.get("reset"))
    output = done.get("output") or streamed

    # 状态判定：P1–P4 诚实分层
    if done.get("interrupted"):
        status = "⏹ 已中断（第三态，非完成）：仅保留中断前的部分真实文本，未写成完成。"
    elif done.get("clarify"):
        status = (
            f"❓ 模型反问澄清（合法状态）：{done.get('question', '')}\n"
            "   任务太模糊，请补充具体信息后重跑 execute。"
        )
    elif done.get("ok") and src["is_real_llm"]:
        status = "✅ 真实模型执行完成。"
    elif done.get("ok") and not src["is_real_llm"]:
        status = f"⚠ 完成但来源非模型（{src['source']}）：未调用真实模型，不可当模型结论。"
    else:
        status = (
            f"✗ 执行未完成/降级：reason={done.get('reason', '')} "
            f"note={done.get('note', '')}"
        )

    chain = done.get("chain") or []
    lines = [
        status,
        "",
        f"执行方向: {done.get('label', label)}",
        f"来源: {src['source_label']} (source={src['source']}, reason={done.get('reason') or '-'})",
        f"凭据: 耗时={done.get('elapsed_ms', '?')}ms  tokens={done.get('tokens', len(streamed))}  "
        f"chain={json.dumps(chain, ensure_ascii=False)}  ok={done.get('ok')}",
        f"规划步骤(真实用到): {json.dumps(done.get('planned_steps') or steps and parsed_steps or [], ensure_ascii=False)}",
        "",
        "真实输出:",
        output or "(无文本产出)",
    ]
    if done.get("interrupted"):
        lines.append("\n提示：这是用户主动中断的部分结果，可补充后重新执行；不要当作已完成任务。")
    return "\n".join(lines)


@server.tool()
async def journeys(limit: int = 10, journey_id: int | None = None) -> str:
    """查看已保存的驾驶轨迹（P1/P3 可追溯的持久化记录）。

    Args:
        limit: 列出最近多少条，默认 10。
        journey_id: 传则查看该条完整轨迹（含 nodes/branches/meta），不传则列最近 N 条。

    轨迹 meta 里带 forecast_source/forecast_kind/exec_* 等凭据，可回看每轮来源四态。
    """
    if journey_id is not None:
        data = await _http_get(f"/api/journeys/{journey_id}")
        if data.get("error"):
            return f"未找到轨迹 {journey_id}。"
        return json.dumps(data, ensure_ascii=False, indent=2)
    data = await _http_get("/api/journeys", params={"limit": limit})
    if not isinstance(data, list):
        return json.dumps(data, ensure_ascii=False, indent=2)
    if not data:
        return "暂无已保存的行驶轨迹。"
    lines = [f"最近 {len(data)} 条行驶轨迹:"]
    for j in data:
        if isinstance(j, dict):
            lines.append(
                f"  #{j.get('id', '?')} {j.get('title', '?')} "
                f"({j.get('created_at', j.get('ts', '?'))}) reached_end={j.get('reached_end', '?')}"
            )
        else:
            lines.append(f"  {j}")
    lines.append("\n用 journey_id 查看某条完整轨迹与其 meta 凭据。")
    return "\n".join(lines)


@server.tool()
async def open_cockpit() -> str:
    """打开 3D 可视化驾驶舱页面（P4 可感知）——让用户在 3D 路空间看到岔口与执行过程。

    会尝试在本机默认浏览器打开 http://127.0.0.1:8770/ ，并返回 URL。
    浏览器打开失败不影响 URL 返回，可手动访问。需先确认后端已启动（见 health）。
    """
    url = BACKEND_BASE + "/"
    opened = False
    try:
        # 浏览器启动是阻塞的，丢到线程里避免卡住事件循环
        opened = await asyncio.to_thread(webbrowser.open, url)
    except Exception:
        opened = False
    note = "已在默认浏览器打开。" if opened else "未能自动打开浏览器，请手动访问。"
    return (
        f"3D 可视化驾驶舱: {url}\n{note}\n"
        "在页面输入任务 → 看岔口候选路牌 → 点选走向它 → 观察真实 token 流与到达结果卡。"
        "若页面提示后端不可达，请先启动 8770 服务（见 health 工具的指引）。"
    )


if __name__ == "__main__":
    server.run(transport="stdio")
