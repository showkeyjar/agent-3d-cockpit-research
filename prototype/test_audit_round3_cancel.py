"""三轮审查断点7：排队 execute 场景下的 cancel 归属（真实后端）

场景：连续两次 execute —— 第一轮持锁在跑，第二轮排队。用户按停止。
断言：
1. cancel_ack.active=True（有正在运行的轮次）
2. 收到两条 execute_done，都是 interrupted=True / reason=user_cancelled / ok=False
   —— 真正在跑的那轮不再被误记为 error/achieved，排队轮不再产生「停止后还在生成」的假完成
3. 没有 execute_done 被标成 ok=True（停止后不该有成功轮）

运行：D:/tools/Python312/python test_audit_round3_cancel.py
"""
import asyncio, json, os, time

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)

import websockets

URL = "ws://localhost:8770/ws"
CTX = "起草一份面向新同事的团队协作指南，包含代码评审、文档更新、沟通规范三个部分"


async def main():
    ok_all = True
    def check(name, cond, detail=""):
        nonlocal ok_all
        print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else f" → {detail}"))
        if not cond:
            ok_all = False

    async with websockets.connect(URL, max_size=None) as ws:
        # 连发两次 execute：第一轮持锁开跑，第二轮排队
        await ws.send(json.dumps({"type":"execute", "context":CTX, "label":"路径A", "steps":[]}))
        await asyncio.sleep(0.3)   # 让第一轮先拿到锁、登记 active_cancel_event
        await ws.send(json.dumps({"type":"execute", "context":CTX, "label":"路径B", "steps":[]}))
        await asyncio.sleep(0.2)
        await ws.send(json.dumps({"type":"cancel"}))

        # 收集消息直到两条 execute_done 都到（或超时）
        dones = []
        cancel_acks = []
        loop = asyncio.get_event_loop()
        deadline = loop.time() + 40
        while loop.time() < deadline and len(dones) < 2:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(1, deadline - loop.time())))
            except asyncio.TimeoutError:
                break
            if msg.get("type") == "execute_done":
                dones.append(msg)
            elif msg.get("type") == "cancel_ack":
                cancel_acks.append(msg)

        print(f"[cancel-queue] execute_done 条数={len(dones)} cancel_ack={cancel_acks}")
        for d in dones:
            print(f"  - label={d.get('label')} interrupted={d.get('interrupted')} "
                  f"ok={d.get('ok')} reason={d.get('reason')} note={d.get('note','')[:40]}")

        check("收到 cancel_ack", len(cancel_acks) >= 1, cancel_acks)
        if cancel_acks:
            check("cancel_ack.active=True（有在跑的轮次）", cancel_acks[0].get("active") is True, cancel_acks[0])
        check("收到两条 execute_done（排队轮也有诚实收尾）", len(dones) == 2, len(dones))
        check("所有 execute_done 都是 interrupted=True（无假完成）",
              len(dones) > 0 and all(d.get("interrupted") is True for d in dones),
              [(d.get("label"), d.get("interrupted"), d.get("ok"), d.get("reason")) for d in dones])
        check("所有 execute_done 都 ok=False",
              len(dones) > 0 and all(d.get("ok") is False for d in dones),
              [(d.get("label"), d.get("ok")) for d in dones])
        check("所有 execute_done reason=user_cancelled",
              len(dones) > 0 and all(d.get("reason") == "user_cancelled" for d in dones),
              [d.get("reason") for d in dones])
        check("无 execute_done 被误记为 error/achieved（断点7核心）",
              all(d.get("reason") not in ("error", "") for d in dones),
              [d.get("reason") for d in dones])

    print("\n" + ("✅ 断点7 排队 cancel 归属回归全通过" if ok_all else "❌ 有失败项"))
    if not ok_all:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
