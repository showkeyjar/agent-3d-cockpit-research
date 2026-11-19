# test_expert_state.py — expert_state 采集模块纯函数单测（不依赖 8083）
# 跑法：D:/tools/Python312/python test_expert_state.py
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import expert_state as es

NE = 8   # 假专家数
NL = 3   # 假层数

def snap(total2d, n_tokens):
    """total2d: [layer][expert] -> snapshot dict"""
    flat = []
    for row in total2d:
        flat.extend(row)
    return {"flat": flat, "n_expert": NE, "n_layers": NL,
            "n_tokens": n_tokens, "captured_at": "2026-01-01T00:00:00Z"}

def run():
    checks = []
    def ck(name, cond):
        checks.append((name, bool(cond)))
        print(("PASS " if cond else "FAIL ") + name)

    # 1. 端点推导
    ck("endpoint from /v1", es.experts_endpoint("http://localhost:8083/v1") ==
       "http://localhost:8083/experts?total=1")
    ck("endpoint bare", es.experts_endpoint("http://x:9999") ==
       "http://x:9999/experts?total=1")

    # 2. 正常差分聚合：before 全 0，after 每层 expert3 +=2、expert5 +=1
    before = snap([[0]*NE for _ in range(NL)], 100)
    after_total = []
    for _ in range(NL):
        row = [0]*NE; row[3] = 2; row[5] = 1
        after_total.append(row)
    after = snap(after_total, 110)
    core = es.aggregate_fingerprint(before, after)
    ck("aggregate returns core", core is not None)
    if core:
        # expert3 共 3层×2=6，expert5 共 3层×1=3，总 9
        ck("dist len == n_expert", len(core["dist"]) == NE)
        ck("dist expert3 = 6/9", abs(core["dist"][3] - 6/9) < 1e-6)
        ck("dist expert5 = 3/9", abs(core["dist"][5] - 3/9) < 1e-6)
        ck("dist sums to 1", abs(sum(core["dist"]) - 1.0) < 1e-6)
        ck("top_experts[0] is 3", core["top_experts"][0]["expert"] == 3)
        ck("n_tokens_delta = 10", core["n_tokens_delta"] == 10)
        ck("expert_hits = 9", core["expert_hits"] == 9)

    # 3. finalize 组装 available 契约（source=llm）
    st = es.finalize(before, after, source="llm", model="test-gguf", temperature=0.6)
    ck("finalize available", st["status"] == "available")
    ck("finalize source tag", st["source"] == "llm-expert-stats")
    ck("finalize endpoint", st["endpoint"] == "/experts")
    ck("finalize model", st["model"] == "test-gguf")
    ck("finalize temp", st["temperature"] == 0.6)

    # 4. 降级守卫
    ck("source local -> unavailable",
       es.finalize(before, after, source="local")["status"] == "unavailable")
    ck("interrupted -> unavailable",
       es.finalize(before, after, source="llm", interrupted=True)["status"] == "unavailable")
    ck("None before -> unavailable",
       es.finalize(None, after, source="llm")["status"] == "unavailable")
    ck("no new tokens -> unavailable",
       es.aggregate_fingerprint(before, snap(after_total, 100)) is None)
    ck("n_tokens decrease -> unavailable",
       es.aggregate_fingerprint(before, snap(after_total, 90)) is None)
    ck("huge token delta (concurrency) -> None",
       es.aggregate_fingerprint(before, snap(after_total, 100000)) is None)
    ck("empty diff -> None",
       es.aggregate_fingerprint(before, snap([[0]*NE for _ in range(NL)], 120)) is None)
    ck("length mismatch -> None",
       es.aggregate_fingerprint(before, {"flat":[1,2],"n_expert":NE,"n_layers":NL,"n_tokens":110}) is None)

    # 5. dist 非负、和为1、至少一个正数（前端 normInternalState 过滤 <=0 后仍非空）
    if core:
        ck("all dist >= 0", all(x >= 0 for x in core["dist"]))
        ck("at least one dist > 0", any(x > 0 for x in core["dist"]))

    n_ok = sum(1 for _, c in checks if c)
    print(f"\n{len(checks)} checks, {n_ok} passed")
    return 0 if n_ok == len(checks) else 1

if __name__ == "__main__":
    raise SystemExit(run())
