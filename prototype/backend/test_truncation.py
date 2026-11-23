# test_truncation.py — FI-02（v0.9.49.4）：上限截断如实标注回归
# 用本地 aiohttp 假推理服务模拟 OpenAI SSE 流（finish_reason=length / stop 两态），验证：
#   A. judge_completion：truncated=True → partial（有真实产出也不判达成）
#   B. _llm_stream：SSE finish_reason=length → last_truncated=True；stop → False
#   C. execute 全链：截断轮 completion=partial / truncated=True / note 含「截断」/
#      任务条不打 ✓；正常轮 completion=achieved / truncated=False
#   D. EXEC_MAX_TOKENS：compose 档 > general 档（起草给足篇幅）
#   E. server 结果卡 6000 字符裁剪：超长 output 标 truncated + note 说明（单元级）
# 不占真实模型槽；python test_truncation.py 直跑。
import asyncio
import json
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

BACKEND_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(BACKEND_DIR))
from task_tracker import (  # noqa: E402
    AgentExecutor, TaskTracker, judge_completion,
    COMPLETION_ACHIEVED, COMPLETION_PARTIAL,
)

PASS = 0
FAIL = 0
MODE = {'finish': 'stop'}   # 假服务当前 finish_reason
CHUNKS = ['第一段', '内容', '正在', '生成', '但被', '上限', '掐', '停']
FULL = ''.join(CHUNKS)


def check(name, ok, extra=''):
    global PASS, FAIL
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + str(extra) if extra else ''}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


async def completions(request):
    body = await request.json()
    HITS['max_tokens'] = body.get('max_tokens')
    resp = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
    await resp.prepare(request)
    for c in CHUNKS:
        payload = json.dumps({'choices': [{'delta': {'content': c}}]}, ensure_ascii=False)
        await resp.write(f'data: {payload}\n\n'.encode('utf-8'))
        await asyncio.sleep(0.01)
    end = json.dumps({'choices': [{'delta': {}, 'finish_reason': MODE['finish']}]})
    await resp.write(f'data: {end}\n\n'.encode('utf-8'))
    await resp.write(b'data: [DONE]\n\n')
    await resp.write_eof()
    return resp


async def health(request):
    return web.json_response({'status': 'ok'})


HITS = {'max_tokens': None}


async def main():
    app = web.Application()
    app.router.add_post('/v1/chat/completions', completions)
    app.router.add_get('/health', health)
    app.router.add_get('/v1/models', lambda r: web.json_response({'data': [{'id': 'fake'}]}))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 18991)
    await site.start()

    print('\n[A] judge_completion 截断判据')
    check('A1 截断 → partial', judge_completion(ok=True, source='llm', output='半句话', truncated=True) == COMPLETION_PARTIAL)
    check('A2 未截断 → achieved', judge_completion(ok=True, source='llm', output='完整成果') == COMPLETION_ACHIEVED)
    check('A3 截断但无产出 → partial', judge_completion(ok=True, source='llm', output='', truncated=True) == COMPLETION_PARTIAL)

    tracker = TaskTracker(callback=lambda t: None)
    ex = AgentExecutor('http://127.0.0.1:18991/v1', 'fake', tracker, use_llm=True)

    print('\n[B] _llm_stream finish_reason 捕获')
    MODE['finish'] = 'length'
    text, reason = await ex._llm_stream('测试', max_tokens=8)
    check('B1 length → last_truncated=True', ex.last_truncated is True)
    check('B2 文本仍真实返回', text == FULL and reason == '', f'text={text!r}')
    MODE['finish'] = 'stop'
    text, reason = await ex._llm_stream('测试', max_tokens=8)
    check('B3 stop → last_truncated=False', ex.last_truncated is False)

    print('\n[C] execute 全链')
    MODE['finish'] = 'length'
    r = await ex.execute('帮我起草一份说明文档', '起草说明', task_kind='compose')
    check('C1 截断轮 source=llm（产出真实）', r['source'] == 'llm', r['source'])
    check('C2 截断轮 truncated=True', r.get('truncated') is True)
    check('C3 截断轮 completion=partial', r['completion'] == COMPLETION_PARTIAL, r['completion'])
    check('C4 note 含「截断」', '截断' in (r.get('note') or ''), r.get('note'))
    subs = [t.get('sub', '') for t in r.get('tasks', [])]
    check('C5 任务条不打 ✓ 且注明未完整', any('未完整' in s for s in subs) and not any(s.endswith('✓') for s in subs), subs)
    MODE['finish'] = 'stop'
    r2 = await ex.execute('帮我起草一份说明文档', '起草说明', task_kind='compose')
    check('C6 正常轮 completion=achieved', r2['completion'] == COMPLETION_ACHIEVED, r2['completion'])
    check('C7 正常轮 truncated=False', r2.get('truncated') is False)

    print('\n[D] 任务类型分档上限')
    check('D1 compose 上限 > general', ex.EXEC_MAX_TOKENS['compose'] > ex.EXEC_MAX_TOKENS['general'], ex.EXEC_MAX_TOKENS)
    check('D2 compose 请求实际带大上限', HITS['max_tokens'] == ex.EXEC_MAX_TOKENS['compose'], HITS['max_tokens'])
    await ex.execute('对比这组数据的差异', '对比数据', task_kind='general')
    check('D3 general 请求带小上限', HITS['max_tokens'] == ex.EXEC_MAX_TOKENS['general'], HITS['max_tokens'])

    await ex.close()
    await runner.cleanup()
    print(f'\n=== test_truncation.py: {PASS} PASS / {FAIL} FAIL ===')
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
