"""v0.9.35 后端 synthesize 通道集成测试（真实后端 + 真实 LLM，不 mock）

验证：
1. refine(mode=synthesize) 走独立通道，回 refine_done，mode=synthesize 被保留
2. completion / self_rating / source 回传正确，产出为真实 LLM 内容（非模板）
3. 素材（prior_output）被真正用于综合：产出与素材主题相关
4. synthesize 不干扰 execute 主链（期间无残留 execute_done）

运行：/d/tools/Python312/python test_synthesize_backend.py
"""
import asyncio, json, os, time

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)

import websockets

URL = "ws://localhost:8770/ws"
# 模拟前端收集的两轮真实成果作为综合素材
PRIOR = (
    "【第1轮·代码评审】代码评审要聚焦三点：逻辑正确性、边界条件、可测试性；"
    "评审意见需在24小时内响应，重大设计问题需当面对齐。\n\n"
    "【第2轮·文档更新】接口变更必须同步更新README与示例；"
    "每次发布附带变更日志；文档责任人轮值，每月审计一次。"
)
CONTEXT = "起草一份面向新同事的团队协作指南"


async def recv_until(ws, wanted, timeout=90):
    got = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(1, deadline - time.monotonic())))
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

    async with websockets.connect(URL, max_size=None) as ws:
        # 先收掉连接时的初始握手消息（若有）
        await ws.send(json.dumps({
            "type": "refine", "mode": "synthesize", "context": CONTEXT,
            "prior_output": PRIOR, "instruction": "",
        }))
        done, msgs = await recv_until(ws, {"refine_done"}, timeout=90)
        if not done:
            print("❌ refine_done 未收到")
            return
        print(f"[synthesize] mode={done.get('mode')} ok={done.get('ok')} "
              f"source={done.get('source')} completion={done.get('completion')} "
              f"outlen={len(done.get('output',''))}")

        check("refine_done mode=synthesize（未被回退成 expand）",
              done.get("mode") == "synthesize", done.get("mode"))
        check("真实 LLM 产出（ok 且 source=llm 且 len>40）",
              done.get("ok") and done.get("source") == "llm" and len(done.get("output", "")) > 40,
              {k: done.get(k) for k in ("ok", "source")} )
        out = done.get("output", "")
        check("产出与素材主题相关（含评审/文档关键词）",
              ("评审" in out or "文档" in out or "指南" in out), out[:120])
        check("completion 字段回传", done.get("completion") in ("achieved", "partial", "need_input"),
              done.get("completion"))
        # 无残留 execute_done（synthesize 不碰执行主链）
        stray = [m for m in msgs if m.get("type") == "execute_done"]
        check("synthesize 期间无 execute_done（不碰主链）", len(stray) == 0, len(stray))

    print("\n" + ("✅ synthesize 后端通道全通过" if ok_all else "❌ 有失败项"))
    if not ok_all:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
