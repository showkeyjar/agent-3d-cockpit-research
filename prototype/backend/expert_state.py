"""
expert_state.py — v0.9.41 内部状态指纹采集（P1/P2 凭据）

把「本轮真实 LLM 执行的 MoE 聚合专家分布」作为内部状态指纹凭据，
随 execute_done 下发，由前端 v0.9.40 的 2D 凭据层自动接住。

数据源：llama.cpp --expert-stats 暴露的 GET /experts?total=1，
其中 layers[il].total[e] 是该专家的进程生命周期累积命中数。

方法（生成段采集，2026-11-19 诊断后定稿）：
  1. 真实 LLM 流式生成时，在「首个内容 token 到达」（prefill 已完成）取 before
     快照，在「生成完成」取 after 快照——只覆盖生成段，排除模板 prefill；
  2. 差分 diff = max(0, after - before)，只保留本轮新增命中；
  3. 跨层聚合到 512 维 v[e] = Σ_layers diff[layer][e]，归一化成占比 dist；
  4. top_experts = 占比最高的若干专家。

★ 根因诊断（勿回退，决定采集点）：裸问题 prompt 上指纹判别力 r_same=0.978、
  异题 max=0.327；套上执行链长模板后塌到 r_same=0.636、异题 max=0.776。
  根因=模板 prefill 的 token 路由淹没了任务自身信号（delta 从 ~90 膨胀到 ~340）。
  改在生成段采集后，走真实 execute 路径 r_same=0.990、异题 max=0.079——
  比判决实验更干净。故采集点必须钉在首 token→生成完成，不可挪回调用前后。

纪律（勿回退）：
  - 只编码聚合分布，绝不逐 token 上屏（逐 token 是噪声=新剧场，见判决实验）。
  - 只在 source=llm 的真实执行轮附指纹；降级/中断/未开启一律 unavailable。
  - 端点不可达 / 差分无新 token / 数据残缺 / 明显并发污染 → 一律 unavailable，
    绝不伪造，绝不用探针样例数据冒充本轮执行凭据。
  - 不改 execute 主链算法、不碰 3D 不变量，只是编排层在 execute 前后取两次快照。
  - 温度注意：execute 实际用 temperature=0.6，判决实验用 0；聚合指纹在 0.6 下的
    模式稳定性尚未做判决，元数据如实标注 temperature，P4 宣称保持克制。
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

# 端点不可达等异常时的诚实缺省（与前端 INTERNAL_STATE_UNAVAILABLE 对齐）
def unavailable(reason: str) -> dict:
    return {"status": "unavailable", "reason": str(reason or "expert_stats_not_enabled")}


def capture_enabled() -> bool:
    """显式关闭才关；默认开（8083 主力已带 --expert-stats）。
    无 /experts 的本地/离线模型会在 snapshot_total 自然降级，无需关开关。"""
    return os.environ.get("EXPERT_STATE_CAPTURE", "1").strip().lower() \
        not in ("0", "false", "no", "off")


def experts_endpoint(base_url: str) -> str:
    """http://localhost:8083/v1 → http://localhost:8083/experts?total=1"""
    root = str(base_url or "").rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    return root.rstrip("/") + "/experts?total=1"


async def _http_get_json(url: str, timeout_s: float = 5.0) -> Optional[dict]:
    try:
        import aiohttp
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get(url) as resp:
                if resp.status == 200:
                    return await resp.json(content_type=None)
    except Exception:
        return None
    return None


async def snapshot_total(base_url: str) -> Optional[dict]:
    """取一次 lifetime total 快照。返回
    {'flat':[n_layers*n_expert ints], 'n_expert','n_layers','n_tokens','captured_at'}
    或 None（端点不可达/缺字段/空数据）。"""
    d = await _http_get_json(experts_endpoint(base_url))
    if not isinstance(d, dict):
        return None
    layers = d.get("layers")
    if not isinstance(layers, list) or not layers:
        return None
    try:
        n_expert = int(d.get("n_expert") or 0)
        n_tokens = int(d.get("n_tokens") or 0)
    except (ValueError, TypeError):
        return None
    if n_expert <= 0:
        return None
    flat: list[int] = []
    used_layers = 0
    for L in layers:
        total = L.get("total") if isinstance(L, dict) else None
        if not isinstance(total, list) or len(total) < n_expert:
            continue
        try:
            flat.extend(int(x) for x in total[:n_expert])
        except (ValueError, TypeError):
            return None
        used_layers += 1
    if used_layers == 0 or not flat:
        return None
    return {
        "flat": flat,
        "n_expert": n_expert,
        "n_layers": used_layers,
        "n_tokens": n_tokens,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


def aggregate_fingerprint(before: Optional[dict], after: Optional[dict],
                          *, concurrency_guard: int = 3000) -> Optional[dict]:
    """纯函数：两次快照 → 指纹核心 {dist, top_experts, n_expert, n_layers,
    n_tokens_delta, expert_hits}。残缺/无新 token/明显并发污染 → None。"""
    if not before or not after:
        return None
    be, af = before.get("flat"), after.get("flat")
    if not isinstance(be, list) or not isinstance(af, list) or len(be) != len(af) or not be:
        return None
    try:
        n_expert = int(before.get("n_expert") or 0)
        n_delta = int(after.get("n_tokens", 0)) - int(before.get("n_tokens", 0))
    except (ValueError, TypeError):
        return None
    if n_expert <= 0 or len(be) < n_expert:
        return None
    # 无新 token：本轮没真正推理（或快照取反了），不认。
    if n_delta <= 0:
        return None
    # 明显并发污染：单轮 max_tokens≈220，n_tokens_delta 一般不会超过 prompt+completion
    # 的数百量级。异常大说明两次快照之间混入了别的请求，宁可降级不冒充凭据。
    if n_delta > concurrency_guard:
        return None
    diff = [max(0, af[i] - be[i]) for i in range(len(be))]
    total_hits = sum(diff)
    if total_hits <= 0:
        return None
    v = [0.0] * n_expert
    for i, x in enumerate(diff):
        v[i % n_expert] += x
    s = sum(v)
    if s <= 0:
        return None
    dist = [x / s for x in v]
    order = sorted(range(n_expert), key=lambda i: -dist[i])[:8]
    top = [{"expert": i, "share": round(dist[i], 6)} for i in order if dist[i] > 0]
    return {
        "dist": [round(x, 8) for x in dist],
        "top_experts": top,
        "n_expert": n_expert,
        "n_layers": int(before.get("n_layers") or 0),
        "n_tokens_delta": n_delta,
        "expert_hits": total_hits,
    }


def finalize(before: Optional[dict], after: Optional[dict], *,
             source: str = "llm", interrupted: bool = False,
             model: str = "", temperature: Optional[float] = None,
             concurrency_guard: int = 3000) -> dict:
    """编排层收尾：把两次快照组装成前端契约的 internal_state。
    只有 source=llm 且未中断才认真指纹，其余一律诚实降级。"""
    if interrupted:
        return unavailable("interrupted_no_fingerprint")
    if source != "llm":
        return unavailable("source_not_llm")
    core = aggregate_fingerprint(before, after, concurrency_guard=concurrency_guard)
    if not core:
        return unavailable("no_new_expert_activity")
    return {
        "status": "available",
        "source": "llm-expert-stats",
        "endpoint": "/experts",
        "model": str(model or ""),
        "n_expert": core["n_expert"],
        "n_layers": core["n_layers"],
        "temperature": temperature,
        "dist": core["dist"],
        "top_experts": core["top_experts"],
        "captured_at": (after or {}).get("captured_at", ""),
        "n_tokens_delta": core["n_tokens_delta"],
        "expert_hits": core["expert_hits"],
    }
