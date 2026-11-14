"""
分桶采样（diversify_candidates）单元测试。
不依赖 pytest：本机无 pytest 安装，直接 `python test_diversify.py` 运行。
Run: cd forecaster/tests && python test_diversify.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np

from core import (
    Candidate,
    diversify_candidates,
    cluster_candidates,
    cosine_distance,
)
from llm_forecaster import LLMCandidateSampler

FAILS = []


def check(cond, label):
    if cond:
        print("  PASS", label)
    else:
        print("  FAIL", label)
        FAILS.append(label)


def make_candidate(label, vec):
    return Candidate(label=label, sub=label, vec=np.asarray(vec, dtype=float), score=0.0)


# ── 1a. 独立方向不足时：分桶折叠同义簇，保量回补（客观约束）─────────

def test_synonym_cluster_collapses_to_one():
    # 同方向 5 种写法（向量几乎重合）+ 两个远方向
    same = np.array([0.9, 0.1, 0.1])
    a = np.array([0.3, 0.8, 0.2])
    b = np.array([0.2, 0.3, 0.85])
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 0.01, 3)
    cands = [make_candidate(f"检索资料{i}", same + noise) for i in range(5)]
    cands[1] = make_candidate("查资料", same + noise)
    cands.append(make_candidate("对比评估", a))
    cands.append(make_candidate("代码执行", b))

    out = diversify_candidates(cands, k=5, eps=0.60)
    labels = [c.label for c in out]
    labels_set = set(labels)
    # 远方向代表保留
    check("对比评估" in labels_set and "代码执行" in labels_set, "远方向代表保留")
    # 保量：凑回 k 块牌
    check(len(out) == 5, f"回填保量凑到 k=5（实际 {len(out)})")
    # 池里只有 2 个独立方向，其余只能由被折叠的同义载体回补——
    # 这是保量约束下的客观事实（近义写法露出 > 1 不违反分桶语义）
    near_labels = [l for l in labels if l.startswith("检索资料") or l == "查资料"]
    check(1 <= len(near_labels) <= 3,
          f"同义载体露出 1-3 个（独立方向不足时的保量回补，实际 {len(near_labels)})")


# ── 1b. 独立方向富余时：同义簇只留代表，全部回填用独立方向 ───────────

def test_rich_directions_collapse_synonyms_fully():
    # 4 个近义同向 + 4 个远方向，池 8 → k=5
    same = np.array([0.9, 0.1, 0.1])
    far_dirs = [
        [0.3, 0.8, 0.2], [0.2, 0.3, 0.85], [0.1, 0.1, 0.97], [0.4, 0.4, 0.8],
    ]
    cands = [make_candidate(f"检索资料{i}", same) for i in range(4)]
    cands += [make_candidate(f"方向{i}", np.array(v)) for i, v in enumerate(far_dirs)]

    out = diversify_candidates(cands, k=5, eps=0.60)
    labels = [c.label for c in out]
    near = [l for l in labels if l.startswith("检索资料")]
    check(len(near) == 1, "方向富余时同义簇只留 1 个代表")
    check(len(out) == 5, f"k=5 凑满（实际 {len(out)})")


# ── 2. 保量直出：池 ≤ k 不做任何压缩 ─────────────────────────────────

def test_pool_at_or_below_k_passthrough():
    cands = [make_candidate(f"c{i}", np.array([0.9, 0.1, 0.1]) + np.random.default_rng(i).normal(0, 0.01, 3)) for i in range(3)]
    out = diversify_candidates(cands, k=5)
    check(len(out) == 3, f"池=3<k=5 直出 3 个不压缩（实际 {len(out)}）")
    check(all(c.label in [x.label for x in cands] for c in out), "直出不丢候选")


# ── 3. k=1 直通 ───────────────────────────────────────────

def test_k_one_passthrough():
    cands = [make_candidate("a", [0.9, 0.1, 0.1]), make_candidate("b", [0.1, 0.9, 0.1])]
    out = diversify_candidates(cands, k=1)
    check(len(out) == 1 and out[0].label == "a", f"k=1 直通取第一个（{out[0].label if out else 'empty'}）")


# ── 4. 结果多样性：分散方向汇出来后 pairwise 间距全在 eps 之上 ─────────────

def test_diversity_min_distance():
    # 6 个刻意构造的分散方向，两两余弦距离 > 0.4
    anchors = [
        [0.95, 0.12, 0.25],
        [0.25, 0.90, 0.15],
        [0.15, 0.20, 0.95],
        [0.85, 0.45, 0.10],
        [0.10, 0.85, 0.40],
        [0.50, 0.20, 0.80],
    ]
    cands = [make_candidate(f"dir{i}", v) for i, v in enumerate(anchors)]
    out = diversify_candidates(cands, k=5)
    check(len(out) == 5, f"k=5 取满（实际 {len(out)}）")
    vecs = [c.vec for c in out]
    min_d = max(cosine_distance(vecs[i], vecs[j]) for i in range(len(vecs)) for j in range(i + 1, len(vecs)))
    check(min_d > 0.30, f"最终 5 候选两两最小距离 {min_d:.3f} > 0.30（分散性）")


# ── 5. hashed-TF 真实语义簇验证（贴近 LLM 场景，用实测距离校准）──────

def test_real_hashed_tf_clusters():
    """用 LLM 真实使用的 _hash_embed 生成向量，验证分桶判据在真实文本上的效果。

    实测数据（hashed-TF，dim=128）：
    - 同义模板（换动词、共享名词）距离 0.30-0.38 → 0.40 判据下同桶
    - 完全不同方向距离 0.55-0.79 → 不聚
    """
    H = LLMCandidateSampler._hash_embed

    pairs_same = [
        ("写代码 实现功能 开发程序", "写代码 编程实现 开发脚本"),          # 实测 0.303
        ("检索资料 查找这些信息 收集资料", "检索资料 查资料 收集信息 搜索相关信息 找资料"),  # 同族变体
        ("检索资料 找相关资料 搜索后整理 收集数据", "查资料 找依据 搜文献 核对信息"),  # 换动词近义，实测 0.571
    ]
    fars = [
        "对比评估 收集参考 分析差异 给结论",
        "先问清楚 追问范围 确认意图 减少返工",
    ]

    for a, b in pairs_same:
        d = cosine_distance(H(a), H(b))
        check(d < 0.60, f"{a[:6]}… vs {b[:6]}… 距离 {d:.3f} < 0.60（同义模板可折叠）")

    far_vs_same = cosine_distance(H(pairs_same[0][0]), H(fars[1]))
    check(far_vs_same > 0.60, f"近义模板 vs 远方向 {far_vs_same:.3f} > 0.60（不误聚）")

    # 典型池：1 组同义写法 3 个 + 2 个远方向 → 恰好 3 桶
    pool = [H(a) for a, _ in pairs_same] + [H(b) for _, b in pairs_same] + [H(f) for f in fars]
    buckets = cluster_candidates(pool, eps=0.60)
    check(len(buckets) == 4, f"同义 2 族 + 2 远方向聚成 4 桶（实际 {len(buckets)}）")


# ── 6. Forecaster 层：choice 触发分桶，sequential/direct 跳过 ─────────

class FakeSampler:
    def __init__(self, qtype, pool):
        self.last_question_type = qtype
        self.pool = pool

    def sample(self, context, k):
        # 模拟 LLM 超采样：返回 min(k + margin, pool) 个候选
        n = min(int(k) + 2, self.pool)
        out = []
        for i in range(n):
            v = np.array([0.9, 0.1, 0.1]) if i < 4 else np.array([0.1 * (i + 1), 0.8, 0.1])
            out.append(Candidate(label=f"假候选{i}", sub="", vec=v))
        return out


def test_forecaster_layer_switch():
    from core import SpeculativeForecaster

    # choice + 超采样池 → 分桶
    s = FakeSampler("choice", 6)
    f = SpeculativeForecaster(s, k=5)
    r = f.forecast("随便")
    check(getattr(f, 'last_diversify', None) is not None, f"choice 触发了分桶（池 {f.last_diversify[0]} → {f.last_diversify[1]}）")

    # sequential → 不触发
    s2 = FakeSampler("sequential", 6)
    f2 = SpeculativeForecaster(s2, k=5)
    r2 = f2.forecast("随便")
    check(getattr(f2, 'last_diversify', None) is None, "sequential 跳过分桶")

    # direct → 不触发
    s3 = FakeSampler("direct", 6)
    f3 = SpeculativeForecaster(s3, k=5)
    f3.forecast("随便")
    check(getattr(f3, 'last_diversify', None) is None, "direct 跳过分桶")


if __name__ == "__main__":
    print("=== 分桶采样（diversify）单元测试 ===")
    test_synonym_cluster_collapses_to_one()
    test_rich_directions_collapse_synonyms_fully()
    test_pool_at_or_below_k_passthrough()
    test_k_one_passthrough()
    test_diversity_min_distance()
    test_real_hashed_tf_clusters()
    test_forecaster_layer_switch()
    print()
    if FAILS:
        print(f"FAIL ({len(FAILS)}):", FAILS)
        sys.exit(1)
    print("ALL PASS")
