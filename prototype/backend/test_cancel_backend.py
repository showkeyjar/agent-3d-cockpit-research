"""
test_cancel_backend.py — v0.9.16 后端 cancel / abort 契约（不依赖 35B）

用本地 aiohttp 假推理服务模拟 OpenAI SSE 流，验证：
  1. 收到 cancel 后真的断开流式 HTTP 响应，execute_done 如实标 interrupted
     而不是「模型未返回有效内容 / 超时」，也不是 ok=true 的假完成
  2. task_update 里任务条 status='stop'、进度保持中断时真实值，不写 done/100%
  3. 不取消时执行链照常完成（回归）
  4. 等推理槽期间也能被立刻打断，且根本不会发起生成请求

运行：python backend/test_cancel_backend.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

BACKEND_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(BACKEND_DIR))
import server  # noqa: E402

CHUNKS = ['国内', '电力', '交易', '市场', '以', '省', '级', '现货', '为主', '。',
          '中长', '期合', '约与', '现货', '并行', '结算', '规则', '各省', '不同', '。']
FULL_TEXT = ''.join(CHUNKS)
BUSY = {'value': False}
HITS = {'completions': 0}
PASS = 0
FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + str(extra) if extra else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


async def status(request):
    return web.json_response({'busy': BUSY['value'], 'queued': 0})


async def completions(request):
    HITS['completions'] += 1
    resp = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
    await resp.prepare(request)
    try:
        for c in CHUNKS:
            payload = json.dumps({'choices': [{'delta': {'content': c}}]}, ensure_ascii=False)
            await resp.write(f'data: {payload}\n\n'.encode('utf-8'))
            await asyncio.sleep(0.06)
        await resp.write(b'data: [DONE]\n\n')
        await resp.write_eof()
    except (ConnectionResetError, aiohttp.ClientConnectionError, OSError):
        # 客户端 abort 后服务端继续写会抛连接重置——这正是「流式真被掐断」的证据
        pass
    return resp


class FakeConn(server.WSConnection):
    """只记录出站消息，不真的写 WebSocket。"""

    def __init__(self):
        super().__init__(None)
        self.sent = []

    async def send(self, msg):
        self.sent.append(dict(msg))


async def wait_for(pred, timeout=6.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.02)
    return False


def done_of(conn):
    got = [m for m in conn.sent if m.get('type') == 'execute_done']
    return got[-1] if got else None


async def run_case(cancel_at_token=3, busy=False, do_cancel=True):
    BUSY['value'] = busy
    conn = FakeConn()
    ce = asyncio.Event()
    task = asyncio.create_task(server.run_execute(
        conn, {'context': '国内电力交易市场的格局？', 'label': '先查资料', 'steps': []}, ce))
    if do_cancel:
        ok = await wait_for(lambda: sum(
            1 for m in conn.sent if m.get('type') == 'token' and m.get('text')) >= cancel_at_token
            or (busy and conn.active_executor is not None), timeout=4)
        ce.set()
        if conn.active_executor is not None:
            await conn.active_executor.abort()   # 与 WS cancel 分支完全一致
        await asyncio.wait_for(task, timeout=8)
    else:
        await asyncio.wait_for(task, timeout=12)
    return conn, done_of(conn)


async def main():
    app = web.Application()
    app.router.add_get('/status', status)
    app.router.add_post('/v1/chat/completions', completions)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    server.LLM_BASE_URL = f'http://127.0.0.1:{port}/v1'
    server.EXEC_USE_LLM = True

    print('\n=== 1. 流式生成中收到 cancel ===')
    conn, done = await run_case(cancel_at_token=4)
    tokens = [m['text'] for m in conn.sent if m.get('type') == 'token' and m.get('text')]
    check('1.1 一定回 execute_done', done is not None)
    check('1.2 标 interrupted=True 且 ok=False（绝不发完成态）',
          bool(done and done.get('interrupted') and not done.get('ok')),
          f"interrupted={done and done.get('interrupted')} ok={done and done.get('ok')}")
    check('1.3 reason=user_cancelled / note=已由用户中断，不误报模型失败',
          bool(done and done.get('reason') == 'user_cancelled'
               and done.get('note') == '已由用户中断'
               and '模型' not in str(done.get('note'))),
          f"reason={done and done.get('reason')} note={done and done.get('note')}")
    check('1.4 回传中断前真实部分文本（非空、且短于完整答案）',
          bool(done and 0 < len(done.get('output') or '') < len(FULL_TEXT)),
          f"len={len((done or {}).get('output') or '')}/{len(FULL_TEXT)}")
    check('1.5 部分文本 = 已下发的 token 拼接（可核对）',
          bool(done and (done.get('output') or '').startswith(''.join(tokens))),
          f"tokens={len(tokens)}")
    check('1.6 任务条 status=stop，不算完成',
          bool(done and done.get('tasks') and done['tasks'][0]['status'] == 'stop'
               and done['tasks'][0]['progress'] < 1.0),
          f"tasks={done and done.get('tasks')}")
    check('1.7 chain 如实为单步真实执行 output',
          bool(done and done.get('chain') == ['output']), f"chain={done and done.get('chain')}")
    check('1.8 耗时/字数凭据如实下发',
          bool(done and done.get('elapsed_ms', 0) > 0 and done.get('tokens', 0) > 0),
          f"ms={done and done.get('elapsed_ms')} tokens={done and done.get('tokens')}")
    check('1.9 abort 生效：取消后不再有新增 token',
          len(tokens) < len(CHUNKS), f"streamed_chunks={len(tokens)}/{len(CHUNKS)}")

    print('\n=== 2. 不取消时正常完成（回归） ===')
    conn2, done2 = await run_case(do_cancel=False)
    check('2.1 ok=True 且 interrupted=False',
          bool(done2 and done2['ok'] and not done2.get('interrupted')),
          f"ok={done2 and done2.get('ok')} interrupted={done2 and done2.get('interrupted')}")
    check('2.2 输出为完整模型文本', bool(done2 and done2.get('output') == FULL_TEXT),
          f"len={len((done2 or {}).get('output') or '')}/{len(FULL_TEXT)}")
    check('2.3 没有残留 cancel_late', bool(done2 and not done2.get('cancel_late')))

    print('\n=== 3. 等推理槽期间被停止：不发起生成请求 ===')
    hits_before = HITS['completions']
    BUSY['value'] = True
    conn3 = FakeConn()
    ce3 = asyncio.Event()
    task3 = asyncio.create_task(server.run_execute(
        conn3, {'context': '国内电力交易市场的格局？', 'label': '先查资料', 'steps': []}, ce3))
    await wait_for(lambda: conn3.active_executor is not None, timeout=3)
    ce3.set()
    await asyncio.wait_for(task3, timeout=4)
    done3 = done_of(conn3)
    check('3.1 立刻回 execute_done(interrupted)，不等 12s 等槽超时',
          bool(done3 and done3.get('interrupted')), f"done={done3 and done3.get('interrupted')}")
    check('3.2 根本没有发起 /chat/completions',
          HITS['completions'] == hits_before,
          f"新增请求={HITS['completions'] - hits_before}")
    check('3.3 任务条仍标 stop（不是 done）',
          bool(done3 and done3['tasks'] and done3['tasks'][0]['status'] == 'stop'))
    BUSY['value'] = False

    await runner.cleanup()
    print(f'\n=== test_cancel_backend.py: {PASS} PASS / {FAIL} FAIL ===')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
