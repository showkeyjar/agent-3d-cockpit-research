"""三轮审查后端回归：refine 达成度降级 / 空素材守卫 / 超长截断标注

断点1：refine 中模型自评「待补输入」不能再硬判 achieved —— 规则判据独立算，
       self_rating 只做「就低不就高」降级。
断点8：synthesize/expand 空素材直接拒绝（no_material），不调模型、不发 achieved。
断点9：synthesize 素材超过上限被截断时如实标注 material_truncated + partial。

运行：D:/tools/Python312/python test_audit_round3_backend.py
"""
import asyncio, json, os, sys

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)

# 直接 import 判据函数（断点1的纯逻辑）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend"))
from task_tracker import _rating_means_need_input, judge_completion

import websockets

URL = "ws://localhost:8770/ws"


async def recv_until(ws, wanted, timeout=90):
    got = []
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(1, deadline - loop.time())))
        except asyncio.TimeoutError:
            break
        got.append(msg)
        if msg.get("type") in wanted:
            return msg, got
    return None, got


async def main():
    ok_all = True
    def check(name, cond, detail=""):
        nonlocal ok_all
        print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else f" → {detail}"))
        if not cond:
            ok_all = False

    print("=== 断点1：达成度降级判据（纯函数） ===")
    check("自评『待补输入』→ 判为需补输入", _rating_means_need_input("待补输入"))
    check("自评『need_input』→ 判为需补输入", _rating_means_need_input("need_input"))
    check("自评『达成』→ 不降级", not _rating_means_need_input("达成"))
    check("自评为空 → 不降级", not _rating_means_need_input(""))
    # 规则判据独立：正常产出=achieved
    check("规则判据：ok+llm+非空 → achieved",
          judge_completion(ok=True, source="llm", output="真实产出正文") == "achieved")
    # 就低不就高：规则 achieved 但自评待补 → need_input（refine 里的组合逻辑）
    base = judge_completion(ok=True, source="llm", output="真实产出正文")
    final = "need_input" if _rating_means_need_input("待补输入") else base
    check("就低不就高：规则 achieved + 自评待补 → need_input", final == "need_input", final)

    print("\n=== 断点8：空素材守卫（真实 WS） ===")
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps({
            "type": "refine", "mode": "synthesize", "context": "起草一份指南",
            "prior_output": "   ", "instruction": "",
        }))
        done, _ = await recv_until(ws, {"refine_done"}, timeout=30)
        if not done:
            check("空素材返回 refine_done", False, "超时未收到")
        else:
            check("空素材：reason=no_material", done.get("reason") == "no_material", done.get("reason"))
            check("空素材：ok=False（不伪造成功）", done.get("ok") is False, done.get("ok"))
            check("空素材：completion=partial（非 achieved）", done.get("completion") == "partial", done.get("completion"))
            check("空素材：source=local（未调用模型）", done.get("source") == "local", done.get("source"))

    print("\n=== 断点9：超长素材截断标注（真实 WS） ===")
    # 构造 > 8000 字的素材（synthesize cap）
    long_prior = ("【轮·测试】这是用于综合的真实产出正文，反复堆叠以超过上限。" * 300)
    check("测试素材确实超过 8000 字", len(long_prior) > 8000, len(long_prior))
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps({
            "type": "refine", "mode": "synthesize", "context": "起草一份指南",
            "prior_output": long_prior, "instruction": "",
        }))
        done, _ = await recv_until(ws, {"refine_done"}, timeout=90)
        if not done:
            check("超长素材返回 refine_done", False, "超时未收到")
        else:
            print(f"[synthesize-long] ok={done.get('ok')} completion={done.get('completion')} "
                  f"truncated={done.get('material_truncated')} note={done.get('note','')[:60]}")
            check("超长素材：material_truncated=True", done.get("material_truncated") is True, done.get("material_truncated"))
            check("超长素材：completion 降为 partial", done.get("completion") == "partial", done.get("completion"))
            check("超长素材：note 如实标注截断", "截断" in done.get("note", ""), done.get("note", "")[:80])

    print("\n" + ("✅ 三轮审查后端回归全通过" if ok_all else "❌ 有失败项"))
    if not ok_all:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
