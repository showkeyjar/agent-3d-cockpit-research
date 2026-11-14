# -*- coding: utf-8 -*-
"""端到端验证：LLM 超采样池（7）→ SpeculativeForecaster 分桶 → 期望 5 候选 = 1 检索代表 + 4 方向。

池构成刻意构造为历史上「选项不够丰富」的实际形态：
LLM 给 k+2=7 个候选，其中 3 个是「检索资料」的换词同义
（搜索相关资料 / 查找资料 / 网上收集数据），hashed-TF 下向量
几乎重合（族内 0.30-0.57 < eps=0.60），折叠为 1 个代表；
剩下 4 个独立方向都离代表 ≥ 0.68（0.60 判据下不误聚），回填满 k=5。
"""
import sys
from core import SpeculativeForecaster, Candidate
from llm_forecaster import LLMCandidateSampler

H = LLMCandidateSampler._hash_embed

# 同义三元组用实测距离校准（hashed-TF 实测，均 < eps=0.60）：
#   A=检索资料找相关资料 ↔ B=查资料找依据 = 0.586
#   A ↔ C=搜索相关资料收集信息 = 0.455
# 方向候选对同义代表距离 ≥ 0.912、方向间 ≥ 0.785（不误聚）。
retrieval_syns = [
    "检索资料 找相关资料",
    "查资料 找依据",
    "搜索相关资料 收集信息",
]
directions = [
    "写代码实现功能开发",
    "对比评估差异说明",
    "生成结构化报告",
    "先问清楚需求再动手",
]

POOL = []
for t in retrieval_syns:
    POOL.append(Candidate(label=t, sub="", vec=H(t)))
for t in directions:
    POOL.append(Candidate(label=t, sub="", vec=H(t)))


class PooledSampler:
    """模拟 LLMCandidateSampler 超采样：sample(k) 返回 k+2 个候选（池子有多即给多）。"""
    last_question_type = "choice"

    def __init__(self, pool):
        self.pool = pool

    def sample(self, context, k):
        n = int(k) + 2  # oversample_margin=2
        return self.pool[:n]


s = PooledSampler(POOL)
f = SpeculativeForecaster(s, k=5)
r = f.forecast("用户想调研竞品情报")

cands = r.candidates
labels = [c.label for c in cands]
print(f"池 {len(s.pool)} → 分桶后 {len(cands)} 候选: {labels}")
print(f"last_diversify: {f.last_diversify}")
print(f"分歧度 {r.divergence:.3f} · 路形 {r.road_type}")

FAILS = []
def check(cond, msg):
    print(("  ✔ " if cond else "  ✘ ") + msg)
    if not cond:
        FAILS.append(msg)

check(len(cands) == 5, f"k=5 保量（实际 {len(cands)}）")
retrieval_n = sum(1 for c in cands if c.vec is POOL[0].vec or c.label in retrieval_syns)
check(retrieval_n <= 1, f"检索同义只露出 1 张牌（实际 {retrieval_n}）")
dir_n = sum(1 for c in cands if c.label in directions)
check(dir_n == 4, f"4 个独立方向全保留（实际 {dir_n}）")

# pairwise 最小距离：代表 vs 各方向 ≈ 0.68，方向间也都 > 0.60
min_d = 9.99
for i in range(len(cands)):
    for j in range(i + 1, len(cands)):
        d = 1.0 - float(cands[i].vec @ cands[j].vec)
        if d < min_d:
            min_d = d
print(f"final pairwise min distance = {min_d:.3f}")
check(min_d > 0.60, f"最终 5 候选两两最小距离 {min_d:.3f} > 0.60（语义分散）")

print()
if FAILS:
    print(f"FAIL ({len(FAILS)}): {FAILS}")
    sys.exit(1)
print("ALL PASS")
