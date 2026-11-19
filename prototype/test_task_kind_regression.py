"""回归：任务类型门控不得误伤分析类的诚实 clarify 能力。

用 task_kind='analysis' 强制走原语义（或自动识别 data 类），
一个明确缺数据的分析任务应仍然 clarify —— 证明门控只针对起草类，
没有把「诚实索要输入」这个 P1/P4 机制一起关掉。
"""
import asyncio, json, os

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)
import websockets

URL = "ws://localhost:8770/ws"
# 明确需要外部数据、且用户没给的分析任务
TASK = "根据我们公司2024年Q1到Q4的实际销售数据，分析各区域的营收趋势并预测2025年Q1"


async def run_one(ws, tag, payload):
    print(f"\n=== {tag} ===")
    print(f"  task_kind={payload.get('task_kind')!r}  label={payload.get('label')!r}")
    await ws.send(json.dumps(payload))
    while True:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=90))
        except asyncio.TimeoutError:
            print("  !! 超时"); return None
        if msg.get("type") == "token":
            continue
        if msg.get("type") == "execute_done":
            c = bool(msg.get("clarify"))
            print(f"  → clarify={c}  task_kind={msg.get('task_kind')!r}  "
                  f"source={msg.get('source')}  out={(msg.get('output') or '')[:60]!r}")
            if c:
                print(f"  → question={msg.get('question','')!r}")
            return msg


async def main():
    async with websockets.connect(URL) as ws:
        # A：自动识别（用户原话含「根据…数据…预测」→ analysis）
        a = await run_one(ws, "A 自动识别（应识别为 analysis，仍 clarify）",
                          {"type": "execute", "context": TASK, "label": "先查资料/检索口径",
                           "steps": ["检索销售数据", "整理趋势", "核对口径"]})
        await asyncio.sleep(1)
        # B：显式强制 compose —— 起草中性化，即使带检索 label 也不该 clarify
        compose_task = "起草一份团队协作指南，涵盖代码评审、文档更新、问题响应"
        b = await run_one(ws, "B 强制 compose（起草类，不该 clarify）",
                          {"type": "execute", "context": compose_task,
                           "label": "先查资料/检索口径", "steps": ["检索口径"],
                           "task_kind": "compose"})
        print("\n=== 判定 ===")
        ak = (a or {}).get("task_kind", "")
        ac = bool(a and a.get("clarify"))
        bc = bool(b and b.get("clarify"))
        ok = (ak == "analysis" and ac and not bc)
        print(f"  A task_kind={ak!r} clarify={ac} | B clarify={bc}")
        print("  ✅ 门控只针对起草类：分析类仍诚实 clarify，起草类强制中性化后直达 done"
              if ok else "  ⚠ 判定异常，需结合模型状态判断")


asyncio.run(main())
