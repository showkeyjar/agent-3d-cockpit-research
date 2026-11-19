# ws_e2e_internal_state.py — 通过真实 WS 验证 execute_done 带 internal_state
import asyncio, json, sys, urllib.request
import websockets

async def main():
    # 确认槽空闲
    slots = json.loads(urllib.request.urlopen("http://127.0.0.1:8083/slots", timeout=5).read())
    print("8083 slots:", len(slots), flush=True)
    uri = "ws://127.0.0.1:8770/ws"
    async with websockets.connect(uri, max_size=8_000_000) as ws:
        msg = {
            "type": "execute",
            "context": "请写一段关于城市雨水花园如何净化雨水的科普说明，直接给出正文，150字以内。",
            "label": "直接起草",
            "steps": [],
            "task_kind": "compose",
        }
        await ws.send(json.dumps(msg))
        done = None
        tokens = 0
        t0 = asyncio.get_event_loop().time()
        while asyncio.get_event_loop().time() - t0 < 90:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=90)
            except asyncio.TimeoutError:
                break
            d = json.loads(raw)
            if d.get("type") == "token":
                tokens += 1
            elif d.get("type") == "execute_done":
                done = d
                break
        if not done:
            print("NO execute_done"); return 1
        st = done.get("internal_state")
        print("source =", done.get("source"), "completion =", done.get("completion"))
        print("output_len =", len(done.get("output") or ""), "token_events =", tokens)
        print("internal_state present =", st is not None)
        if st:
            print("  status =", st.get("status"))
            print("  source =", st.get("source", ""), "endpoint =", st.get("endpoint", ""))
            print("  n_expert/n_layers =", st.get("n_expert"), st.get("n_layers"))
            print("  dist_len =", len(st.get("dist", [])), "sum =", round(sum(st.get("dist", [])),4))
            print("  temperature =", st.get("temperature"))
        ok = (st is not None and st.get("status") == "available"
              and st.get("source") == "llm-expert-stats"
              and len(st.get("dist", [])) == 512
              and done.get("source") == "llm")
        print("WS_E2E_PASS =", ok)
        return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
