"""
test_ws_lifecycle.py — v0.9.49.2 WS 断开收尾契约（不依赖真实模型）

用本地 aiohttp 假推理服务模拟 OpenAI SSE 慢速流，验证：
  1. 连接断开（conn.shutdown()）后，在飞 execute 立即走「用户中断」路径收尾：
     不等 55s 超时、不等流全部吐完；execute_done 如实标 interrupted
  2. 断开同样能停掉在飞 refine（此前 refine 的 cancel_event 无人 set，只能等 70s）
  3. refine 并发守卫：上一轮在跑时，第二次 refine 如实回 busy
  4. 后台任务无 unretrieved 异常（shutdown 后全部 done）

运行：python backend/test_ws_lifecycle.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import aiohttp
from aiohttp import web

BACKEND_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(BACKEND_DIR))
import server  # noqa: E402

# 慢速流：30 块 × 0.1s ≈ 3s 才吐完；断开收尾应在 ~1s 内发生
CHUNKS = [f'字{i}，' for i in range(30)]
FULL_TEXT = ''.join(CHUNKS)
HITS = {'completions': 0, 'resets': 0}
# 场景 4 用：注入「以 [ 开头的合法正文」验证哨兵分离
MODE = {'text': None}
PASS = 0
FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + str(extra) if extra else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


async def completions(request):
    HITS['completions'] += 1
    resp = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
    await resp.prepare(request)
    chunks = [MODE['text']] if MODE['text'] else CHUNKS
    try:
        for c in chunks:
            payload = json.dumps({'choices': [{'delta': {'content': c}}]}, ensure_ascii=False)
            await resp.write(f'data: {payload}\n\n'.encode('utf-8'))
            await asyncio.sleep(0.1)
        await resp.write(b'data: [DONE]\n\n')
        await resp.write_eof()
    except (ConnectionResetError, aiohttp.ClientConnectionError, OSError):
        # 客户端（executor.abort）掐断连接的证据
        HITS['resets'] += 1
    return resp


class FakeConn(server.WSConnection):
    def __init__(self):
        super().__init__(None)
        self.sent = []

    async def send(self, msg):
        self.sent.append(dict(msg))


def done_of(conn, dtype):
    got = [m for m in conn.sent if m.get('type') == dtype]
    return got[-1] if got else None


async def main():
    app = web.Application()
    app.router.add_post('/v1/chat/completions', completions)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    import llm_config
    llm_config.update({
        'base_url': f'http://127.0.0.1:{port}/v1',
        'exec_use_llm': True,
    }, persist=False)

    print('\n=== 1. 断开连接：在飞 execute 立即中断收尾 ===')
    conn = FakeConn()
    ce = asyncio.Event()
    t0 = time.monotonic()
    task = conn.track(asyncio.create_task(server.run_execute(
        conn, {'context': '国内电力交易市场的格局？', 'label': '先查资料', 'steps': []}, ce)))
    # 等前几个 token 下发（说明流真的在生成中）
    while sum(1 for m in conn.sent if m.get('type') == 'token' and m.get('text')) < 3:
        await asyncio.sleep(0.05)
    await conn.shutdown()
    elapsed = time.monotonic() - t0
    done = done_of(conn, 'execute_done')
    check('1.1 execute_done 已回且标 interrupted', bool(done and done.get('interrupted')),
          f"interrupted={done and done.get('interrupted')}")
    check('1.2 秒级收尾（不等 55s 超时 / 不等流吐完）', elapsed < 2.5, f"elapsed={elapsed:.2f}s")
    check('1.3 reason=user_cancelled（非 error/timeout）',
          bool(done and done.get('reason') == 'user_cancelled'),
          f"reason={done and done.get('reason')}")
    streamed = sum(1 for m in conn.sent if m.get('type') == 'token' and m.get('text'))
    check('1.4 流被真掐断（未吐完全部块）', streamed < len(CHUNKS),
          f"streamed={streamed}/{len(CHUNKS)}")
    check('1.5 后台任务全部收口（无挂起）', task.done() and not conn.bg_tasks,
          f"task_done={task.done()} bg={len(conn.bg_tasks)}")

    print('\n=== 2. 断开连接：在飞 refine 同样被停 ===')
    conn2 = FakeConn()
    task2 = conn2.track(asyncio.create_task(server.run_refine(conn2, {
        'context': '起草一份技术方案', 'mode': 'expand',
        'prior_output': '已有真实成果文本若干。' * 20,
        'instruction': '扩写',
    })))
    # refine_ack 到达说明 refine 已真正开始
    while not any(m.get('type') == 'refine_ack' for m in conn2.sent):
        await asyncio.sleep(0.05)
    t1 = time.monotonic()
    await conn2.shutdown()
    r_done = done_of(conn2, 'refine_done')
    check('2.1 refine_done 已回', r_done is not None)
    check('2.2 秒级收尾（不等 70s 超时）', (time.monotonic() - t1) < 2.5)
    check('2.3 停止生成也作用于 refine（cancel 语义与断开一致）', task2.done())

    print('\n=== 3. refine 并发守卫：在跑时如实回 busy ===')
    conn3 = FakeConn()
    task3 = conn3.track(asyncio.create_task(server.run_refine(conn3, {
        'context': 'x', 'mode': 'expand', 'prior_output': '素材' * 30,
    })))
    while not any(m.get('type') == 'refine_ack' for m in conn3.sent):
        await asyncio.sleep(0.05)
    task4 = conn3.track(asyncio.create_task(server.run_refine(conn3, {
        'context': 'x', 'mode': 'expand', 'prior_output': '素材' * 30,
    })))
    await asyncio.wait_for(task4, timeout=5)
    busy_done = done_of(conn3, 'refine_done')
    check('3.1 第二次 refine 立即回 refine_done(reason=busy)',
          bool(busy_done and busy_done.get('reason') == 'busy'),
          f"reason={busy_done and busy_done.get('reason')}")
    await conn3.shutdown()
    check('3.2 第一轮 refine 被正常收口', task3.done())

    print('\n=== 4. 哨兵分离：以 [ 开头的合法正文不被丢弃 ===')
    # v0.9.49.2：错误进 reason、正文 [ 开头合法（judge_completion 同步移除 startswith）
    from task_tracker import judge_completion
    check('4.1 judge_completion 对 [ 开头正文判 achieved',
          judge_completion(ok=True, source='llm', output='[草案] 一、测试正文') == 'achieved')
    MODE['text'] = '[草案] 一、这是一份以方括号开头的合法正文。'
    conn4 = FakeConn()
    ce4 = asyncio.Event()
    task4 = conn4.track(asyncio.create_task(server.run_execute(
        conn4, {'context': '起草一份测试方案', 'label': '直接起草', 'steps': []}, ce4)))
    await asyncio.wait_for(task4, timeout=15)
    done4 = done_of(conn4, 'execute_done')
    check('4.2 execute_done.ok=True（正文未被当错误丢弃）',
          bool(done4 and done4.get('ok')), f"ok={done4 and done4.get('ok')}")
    check('4.3 output 原文保留（不以 [ 被剥空）',
          bool(done4 and (done4.get('output') or '').startswith('[草案]')),
          f"output={(done4 or {}).get('output', '')[:20]!r}")
    check('4.4 完成度不因 [ 开头误降为 need_input',
          bool(done4 and done4.get('completion') in ('achieved', 'partial')
               and done4.get('reason') != 'need_input'),
          f"completion={done4 and done4.get('completion')} reason={done4 and done4.get('reason')}")
    MODE['text'] = None

    await runner.cleanup()
    print(f'\n=== test_ws_lifecycle.py: {PASS} PASS / {FAIL} FAIL ===')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
