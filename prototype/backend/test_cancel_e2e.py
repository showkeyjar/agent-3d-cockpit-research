"""
test_cancel_e2e.py — v0.9.16 真 WS + 真 35B 端到端冒烟（可选，非日常回归）

与 test_cancel_backend.py 的区别：这里走真实的 8770 uvicorn、真实 8083 llama.cpp，
验证「cancel 消息确实被新后端识别、流式 HTTP 真被掐断、槽位被释放」。
需要 8083 空闲；单槽拥塞时结果可能走本地兜底，此时请稍后单独复跑。

运行：python backend/test_cancel_e2e.py   （解释器可用 COCKPIT_PYTHON 覆盖）
"""
from __future__ import annotations

import asyncio
import sys

import aiohttp

WS = 'ws://127.0.0.1:8770/ws'
HEALTH = 'http://127.0.0.1:8083/health'
PASS = 0
FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + str(extra) if extra else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


async def main():
    async with aiohttp.ClientSession() as sess:
        async with sess.ws_connect(WS) as ws:
            await ws.send_json({
                'type': 'execute',
                'context': '国内电力交易市场的格局？',
                'label': '先查资料', 'steps': [],
            })
            got = []
            ack = False
            deadline = asyncio.get_running_loop().time() + 10
            while asyncio.get_running_loop().time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.receive_json(), timeout=0.4)
                except asyncio.TimeoutError:
                    # 等槽/排队稍久，仍然发出取消（这本身就是有效的中断场景）
                    continue
                got.append(msg)
                if msg.get('type') == 'execute_ack':
                    ack = True
                ntok = sum(1 for m in got if m.get('type') == 'token' and m.get('text'))
                # 一有真实 token 就立刻取消（不等模型写完）
                if ack and ntok >= 2:
                    break
            await ws.send_json({'type': 'cancel'})

            done, cancel_ack = None, None
            for _ in range(100):
                try:
                    msg = await asyncio.wait_for(ws.receive_json(), timeout=20)
                except asyncio.TimeoutError:
                    break
                got.append(msg)
                if msg.get('type') == 'cancel_ack':
                    cancel_ack = msg
                if msg.get('type') == 'execute_done':
                    done = msg
                    break

            toks = ''.join(m.get('text', '') for m in got
                           if m.get('type') == 'token' and m.get('text'))
            check('E2E-1 后端认得 cancel（收到 cancel_ack）', cancel_ack is not None,
                  f"ack={cancel_ack}")
            check('E2E-2 一定回 execute_done，不静默挂起', done is not None)
            if done:
                check('E2E-3 interrupted=True / ok=False（不是假完成）',
                      done.get('interrupted') is True and done.get('ok') is False,
                      f"interrupted={done.get('interrupted')} ok={done.get('ok')}")
                check('E2E-4 reason=user_cancelled，不误报模型失败/超时',
                      done.get('reason') == 'user_cancelled',
                      f"reason={done.get('reason')} note={done.get('note')}")
                out = (done.get('output') or '').strip()
                stream = toks.strip()
                check('E2E-5 部分文本与已下发 token 对得上（可核对）',
                      (not out) or (bool(stream) and (out in stream or stream in out)),
                      f"out={len(out)}字 / stream={len(stream)}字")
                tasks = done.get('tasks') or []
                check('E2E-6 任务条是 stop 而非 done',
                      bool(tasks) and tasks[0].get('status') == 'stop',
                      f"tasks={tasks[:1]}")
            print(f"   [链路] 收到 {len(got)} 条 WS 消息；中断前真实 token 文本 {len(toks)} 字")

        # 掐断后推理槽应被释放，服务仍可用（不是把 35B 挂死）
        try:
            async with sess.get(HEALTH, timeout=aiohttp.ClientTimeout(total=5)) as r:
                check('E2E-7 中断后 8083 推理服务仍健康', r.status == 200, f"status={r.status}")
        except Exception as e:
            check('E2E-7 中断后 8083 推理服务仍健康', False, str(e))

    print(f'\n=== test_cancel_e2e.py: {PASS} PASS / {FAIL} FAIL ===')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
