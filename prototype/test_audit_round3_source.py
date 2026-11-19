"""三轮审查断点6：forecaster 来源快照不再串线（结构 + 并发）

断点：_forecaster 是共享单例，last_source/last_question_type 写在 sampler 上；
      并发 forecast 时 A 的来源被 B 覆盖 → local 冒充 llm。
修复：forecast() 内在实例锁中采样并立即快照 source/qtype 进 ForecastResult，
      server 从 result.source 读，不再事后读共享 sampler。

运行：D:/tools/Python312/python test_audit_round3_source.py
"""
import os, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "forecaster")))

import numpy as np
from core import SpeculativeForecaster, Candidate, RoadType
from llm_forecaster import LLMForecaster

ok_all = True
def check(name, cond, detail=""):
    global ok_all
    print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else f" → {detail}"))
    if not cond:
        ok_all = False

print("=== 断点6：ForecastResult 结构保证 ===")
# ForecastResult 必须带 source 字段
from core import ForecastResult
check("ForecastResult 有 source 字段（默认 local）",
      getattr(ForecastResult.__dataclass_fields__.get("source"), "default", None) == "local",
      ForecastResult.__dataclass_fields__.keys())

# SpeculativeForecaster 必须有实例锁
fc = SpeculativeForecaster(sampler=None)
check("SpeculativeForecaster 有 _forecast_lock", hasattr(fc, "_forecast_lock"), type(getattr(fc, "_forecast_lock", None)))

print("\n=== 断点6：并发采样来源快照（自定义 sampler）===")
# 构造一个慢 sampler：每次 sample 先把 last_source 设成本轮值，sleep 一会再返回，
# 模拟「写完共享属性后、别的线程又写」的竞态窗口。
class SlowSampler:
    def __init__(self):
        self.last_source = "local"
        self.last_question_type = "choice"
    def sample(self, context, k):
        tag = "llm" if "LLM" in context else "local"
        self.last_source = tag
        self.last_question_type = "direct" if "DIRECT" in context else "choice"
        time.sleep(0.05)  # 放大竞态窗口：这里另一个线程可能覆盖 last_source
        return [Candidate(f"c{i}", "s", np.array([1.0, i, 0.0]), "#34f5a0") for i in range(k)]
    def uses_semantic_embedding(self):
        return False

sampler = SlowSampler()
fc2 = SpeculativeForecaster(sampler=sampler, k=5, diversify=False)
results = {}
def run(tag):
    ctx = ("LLM DIRECT" if tag == "llm" else "LOCAL") + ctx_suffix
    results[tag] = fc2.forecast(ctx, 5)

ctx_suffix = " 起草"
t1 = threading.Thread(target=run, args=("llm",))
t2 = threading.Thread(target=run, args=("local",))
t1.start(); t2.start(); t1.join(); t2.join()

check("并发两轮都拿到 ForecastResult", set(results.keys()) == {"llm", "local"}, list(results.keys()))
r_llm = results.get("llm"); r_local = results.get("local")
check("llm 轮 source 快照为 llm（不被并发 local 覆盖）",
      r_llm is not None and r_llm.source == "llm", getattr(r_llm, "source", None))
check("local 轮 source 快照为 local",
      r_local is not None and r_local.source == "local", getattr(r_local, "source", None))
check("llm 轮 question_type 快照为 direct（与本次同源）",
      r_llm is not None and r_llm.question_type == "direct", getattr(r_llm, "question_type", None))
check("local 轮 question_type 快照为 choice",
      r_local is not None and r_local.question_type == "choice", getattr(r_local, "question_type", None))

print("\n" + ("✅ 断点6 来源快照回归全通过" if ok_all else "❌ 有失败项"))
if not ok_all:
    raise SystemExit(1)
