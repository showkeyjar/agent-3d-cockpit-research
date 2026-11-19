# verdict_via_execute.py — 走真实 execute 路径验证指纹判别力（决定 3D 编码是否上）
import asyncio, sys, os, itertools
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from task_tracker import TaskTracker, AgentExecutor
import expert_state as es

def pear(a, b):
    n = len(a); ma = sum(a)/n; mb = sum(b)/n
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    den = (sum((x-ma)**2 for x in a)*sum((x-mb)**2 for x in b)) ** 0.5
    return num/den if den else 0

CASES = {
    "A1": ("请详细解释海洋潮汐的形成原因，以及月球和太阳各自的作用。直接给出正文。", "compose"),
    "A2": ("请详细解释海洋潮汐的形成原因，以及月球和太阳各自的作用。直接给出正文。", "compose"),
    "B":  ("Write a short explanation of how binary search works. Give the answer directly.", "compose"),
    "C":  ("请写一段关于人工智能在医疗影像诊断中应用的说明，直接给出正文。", "compose"),
}

async def one(ctx, kind):
    tracker = TaskTracker(callback=lambda d: None)
    ex = AgentExecutor("http://localhost:8083/v1", "local-primary", tracker, use_llm=True)
    try:
        r = await ex.execute(ctx, "直接起草", task_kind=kind)
    finally:
        await ex.close()
    st = r.get("internal_state") or {}
    return st.get("dist", []), r.get("source"), st.get("status")

async def main():
    res = {}
    for k, (ctx, kind) in CASES.items():
        dist, src, status = await one(ctx, kind)
        res[k] = dist
        print(f"CASE {k}: source={src} status={status} dist_len={len(dist)}", flush=True)
        await asyncio.sleep(1)
    print("\n=== fingerprint Pearson r (via real execute) ===", flush=True)
    r_same = pear(res["A1"], res["A2"])
    print(f"  A1 vs A2 (same prompt): r={r_same:+.3f}", flush=True)
    diffs = []
    for a, b in itertools.combinations(CASES, 2):
        if {a, b} == {"A1", "A2"}:
            continue
        r = pear(res[a], res[b]); diffs.append(r)
        print(f"  {a} vs {b}: r={r:+.3f}", flush=True)
    mx = max(diffs); mean = sum(diffs)/len(diffs)
    print(f"\n  same r = {r_same:.3f} (need >0.90)", flush=True)
    print(f"  diff max r = {mx:.3f}, mean = {mean:.3f} (need <0.3)", flush=True)
    ok = r_same > 0.90 and mx < 0.3
    print(f"  VERDICT_PASS = {ok}", flush=True)
    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
