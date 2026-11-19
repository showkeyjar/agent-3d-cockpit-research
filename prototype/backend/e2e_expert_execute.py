# e2e_expert_execute.py — 端到端：AgentExecutor.execute 真实 LLM + 内部状态指纹采集
# 依赖 8083 在线且槽空闲。跑法：D:/tools/Python312/python e2e_expert_execute.py
import asyncio, sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from task_tracker import TaskTracker, AgentExecutor

async def main():
    tracker = TaskTracker(callback=lambda d: None)
    ex = AgentExecutor("http://localhost:8083/v1", "local-primary", tracker, use_llm=True)
    ctx = "请写一段关于城市清晨雨水花园的科普说明，200字以内，直接给出正文。"
    try:
        r = await ex.execute(ctx, "直接起草", task_kind="compose")
    finally:
        await ex.close()
    print("source =", r.get("source"))
    print("completion =", r.get("completion"))
    print("output_len =", len(r.get("output") or ""))
    print("tokens =", r.get("tokens"))
    st = r.get("internal_state")
    print("--- internal_state ---")
    if not st:
        print("MISSING"); return 1
    print("status =", st.get("status"))
    print("reason =", st.get("reason", ""))
    print("source =", st.get("source", ""))
    print("model =", st.get("model", ""))
    print("n_expert/n_layers =", st.get("n_expert"), st.get("n_layers"))
    print("temperature =", st.get("temperature"))
    print("n_tokens_delta =", st.get("n_tokens_delta"))
    print("expert_hits =", st.get("expert_hits"))
    dist = st.get("dist", [])
    print("dist_len =", len(dist), "dist_sum =", round(sum(dist), 4) if dist else 0)
    print("top_experts =", st.get("top_experts", [])[:5])
    # 判据：真实 LLM + available + 512 维 + 和为1 + 有来源标注
    ok = (r.get("source") == "llm" and st.get("status") == "available"
          and st.get("n_expert") == 512 and len(dist) == 512
          and abs(sum(dist) - 1.0) < 1e-3
          and st.get("source") == "llm-expert-stats"
          and st.get("endpoint") == "/experts")
    print("E2E_PASS =", ok)
    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
