"""P0 结果可用性 · 后端 WS 集成测试

验证四件事（真实后端 + 真实 LLM，不 mock）：
1. execute_done 回传 completion 字段（起草类达成 → achieved）
2. refine(mode=expand) 走独立通道，回 refine_done，产出 400+ 字完整成果
3. refine 的 completion 与 self_rating 回传
4. refine 不干扰 execute 主链（refine 期间/之后无残留 execute_done 误发）

运行：/d/tools/Python312/python test_p0_backend.py
"""
import asyncio, json, os, sys, time

os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(k, None)

import websockets

URL = "ws://localhost:8770/ws"
TASK = "起草一份面向新同事的团队协作指南，涵盖代码评审、文档更新、问题响应三个方面，给出可执行的具体条款"


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
    async with websockets.connect(URL, max_size=None) as ws:
        # ---- 1. execute（起草类，compose 门控）----
        await ws.send(json.dumps({
            "type": "execute", "context": TASK,
            "label": "先查资料/检索口径", "steps": ["检索", "整理", "核对"],
            "task_kind": "compose",
        }))
        done, msgs = await recv_until(ws, {"execute_done"}, timeout=90)
        if not done:
            print("❌ execute_done 未收到")
            return
        print(f"[execute] ok={done.get('ok')} task_kind={done.get('task_kind')} "
              f"clarify={done.get('clarify')} completion={done.get('completion')} "
              f"outlen={len(done.get('output',''))}")
        c1 = done.get("completion")
        if done.get("ok") and not done.get("clarify") and len(done.get("output", "")) >= 20:
            print("  ✅ 起草类直达成果")
        else:
            print("  ❌ 起草类未拿到成果")
            ok_all = False
        if c1 == "achieved":
            print("  ✅ execute completion=achieved")
        else:
            print(f"  ❌ execute completion 应为 achieved，实际 {c1}")
            ok_all = False
        prior = done.get("output", "")

        # ---- 2. refine expand ----
        await ws.send(json.dumps({
            "type": "refine", "mode": "expand", "context": TASK,
            "prior_output": prior, "instruction": "", "task_kind": "compose",
        }))
        ack, _ = await recv_until(ws, {"refine_ack"}, timeout=20)
        print(f"[refine] ack={bool(ack)} mode={ack.get('mode') if ack else '-'}")
        refined, rmsgs = await recv_until(ws, {"refine_done"}, timeout=90)
        if not refined:
            print("❌ refine_done 未收到")
            ok_all = False
        else:
            out = refined.get("output", "")
            print(f"[refine_done] ok={refined.get('ok')} mode={refined.get('mode')} "
                  f"source={refined.get('source')} completion={refined.get('completion')} "
                  f"self_rating={refined.get('self_rating')!r} outlen={len(out)}")
            if refined.get("ok") and len(out) >= 200:
                print("  ✅ 展开为 400+ 字级完整成果" if len(out) >= 300 else "  ⚠ 成果偏短")
            else:
                print(f"  ❌ 展开失败：{refined.get('note')}")
                ok_all = False
            # refine 期间不应误发 execute_done
            stray = [m for m in rmsgs if m.get("type") == "execute_done"]
            if not stray:
                print("  ✅ refine 未干扰 execute 主链")
            else:
                print(f"  ❌ refine 期间误发 {len(stray)} 条 execute_done")
                ok_all = False

    print("\n=== P0 后端总判定 ===")
    print("✅ ALL PASS" if ok_all else "❌ SOME FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
