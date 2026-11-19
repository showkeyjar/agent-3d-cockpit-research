"""复现问题 1：推演层动作语义污染执行层，起草任务被误判为「缺数据」→ clarify。

同一 context（起草任务），两条 execute payload 对照：
  A 污染路：label="先查资料/检索口径", steps=["检索口径","整理资料","核对来源"]  → 预期 clarify
  B 中性路：label="直接给出成果", steps=[]                                    → 预期 done

串行执行（LLM 单槽），A 完全结束后再发 B。
用法：python test_repro_task_kind.py
"""
import asyncio, json, os, sys, time

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)

import websockets

URL = "ws://localhost:8770/ws"
TASK = "起草一份面向新同事的团队协作指南，涵盖代码评审、文档更新、问题响应三个方面，直接给出可执行的具体条款"


async def run_one(ws, tag, label, steps):
    payload = {"type": "execute", "context": TASK, "label": label, "steps": steps}
    print(f"\n=== {tag} ===")
    print(f"  label={label!r}  steps={steps}")
    await ws.send(json.dumps(payload))
    while True:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=90))
        except asyncio.TimeoutError:
            print("  !! 超时，未收到 execute_done")
            return None
        t = msg.get("type")
        if t == "token":
            continue
        if t == "execute_done":
            clarify = bool(msg.get("clarify"))
            out = (msg.get("output") or "").replace("\n", " ")
            print(f"  → clarify={clarify}  ok={msg.get('ok')}  source={msg.get('source')}  "
                  f"tokens={msg.get('tokens')}  elapsed={msg.get('elapsed_ms')}ms")
            print(f"  → output={out[:120]!r}")
            if clarify:
                print(f"  → question={msg.get('question', '')!r}")
            return msg
        # status / task_update / execute_ack 忽略


async def main():
    async with websockets.connect(URL) as ws:
        a = await run_one(ws, "A 污染路（推演 label/steps 原样注入）",
                          "先查资料/检索口径", ["检索口径", "整理资料", "核对来源"])
        await asyncio.sleep(1)
        b = await run_one(ws, "B 中性路（起草语境）", "直接给出成果", [])
        print("\n=== 判定 ===")
        ac = bool(a and a.get("clarify"))
        bc = bool(b and b.get("clarify"))
        ak = (a or {}).get("task_kind", "")
        print(f"  A clarify={ac} task_kind={ak!r}   B clarify={bc}")
        # 修复前：A clarify=True / B clarify=False（铁证：污染路被误判缺数据）
        # 修复后（v0.9.29 门控）：A 也被识别为 compose → clarify=False，直达 done
        if not ac and not bc and ak == "compose":
            print("  ✅ 门控生效：污染路被识别为 compose、不再 clarify → 起草任务直达 done")
        elif ac and not bc:
            print("  ❌ 门控未生效：污染路仍 clarify（检查 LIVE 后端是否已同步并重启）")
        else:
            print("  ⚠ 结果异常，需结合模型当前状态判断（随机性/槽位）")


asyncio.run(main())
