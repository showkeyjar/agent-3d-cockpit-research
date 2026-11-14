"""WebSocket 集成测试：forecast → execute → task_update 流式上报"""
import asyncio, json, sys, os

# 禁用代理，直连 localhost
os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)

import websockets

URL = "ws://localhost:8770/ws"

async def main():
    msgs = []
    async with websockets.connect(URL) as ws:
        # 1. 前瞻推演
        await ws.send(json.dumps({"type": "forecast", "context": "帮我写一个Python爬虫", "k": 2}))

        forecast = None
        # 接收推演结果（status ×5 + forecast_result）
        for _ in range(8):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=90))
            except asyncio.TimeoutError:
                print("❌ 推演超时")
                return
            t = msg.get("type")
            if t == "status":
                print(f"  [status] {msg['phase']}: {msg['msg']}")
            elif t == "forecast_result":
                forecast = msg
                print(f"  [forecast] D={msg['divergence']} road={msg['road_type']} K={len(msg['candidates'])}")
                for c in msg["candidates"]:
                    print(f"    - {c['label']}: pos3d={c['pos3d']}")
                break

        if not forecast:
            print("❌ 未收到 forecast_result")
            return

        # 2. 选路执行
        label = forecast["candidates"][0]["label"]
        print(f"\n→ 执行候选: {label}")
        await ws.send(json.dumps({"type": "execute", "label": label, "context": "帮我写一个Python爬虫"}))

        # 3. 接收任务更新流
        task_count = 0
        for _ in range(30):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            except asyncio.TimeoutError:
                print("  (等待超时，结束接收)")
                break
            t = msg.get("type")
            if t == "task_update":
                task_count += 1
                print(f"  [task] {msg['name']} {msg['status']} {msg['progress']:.0%} {msg.get('sub','')}")
            elif t == "execute_done":
                print(f"\n✅ 执行完成: {msg['output'][:80]}...")
                print(f"   任务总数: {len(msg.get('tasks', []))}")
                return
            elif t == "error":
                print(f"❌ 错误: {msg['msg']}")
                return

        if task_count == 0:
            print("⚠️ 未收到任何 task_update")
        else:
            print(f"\n✅ 收到 {task_count} 次 task_update 上报")

asyncio.run(main())
