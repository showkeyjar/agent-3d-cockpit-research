"""
Demo: Speculative Forecaster 三种场景演示

运行: python demo.py
"""

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from core import SpeculativeForecaster, MockSampler, RoadType


def print_result(title: str, result, verbose=True):
    print(f"\n{'━' * 60}")
    print(f"  {title}")
    print(f"{'━' * 60}")

    print(f"\n  分歧度 D:     {result.divergence:.4f}")
    print(f"  路形:         {result.road_type.value.upper()}")
    print(f"  候选数 K:     {len(result.candidates)}")
    print(f"  聚类数:       {result.fork_count}")
    print(f"  推演耗时:     {result.cost_ms:.1f} ms")
    print(f"  阈值:         straight={result.thresholds['straight']}, curve={result.thresholds['curve']}")

    if verbose:
        print(f"\n  候选走向:")
        for i, c in enumerate(result.candidates):
            vec_str = ", ".join(f"{v:.2f}" for v in c.vec)
            print(f"    {i+1}. [{vec_str}] {c.label} — {c.sub}")

        print(f"\n  聚类结果:")
        for ci, cluster in enumerate(result.clusters):
            labels = [result.candidates[i].label for i in cluster]
            print(f"    簇 {ci+1}: {labels}")

    # ASCII 路形可视化
    print(f"\n  路形可视化:")
    if result.road_type == RoadType.STRAIGHT:
        print("    ──────────────────────────────────────────→")
        print("    [直道] 各走向高度一致，无需决策")
    elif result.road_type == RoadType.CURVE:
        print("    ──────~~──────~~──────→")
        print("    [缓弯] 存在轻微分歧，微调方向")
    else:
        print("    ────────┬────────")
        print("             ├──→ 分支1")
        print("             ├──→ 分支2")
        print("             └──→ 分支3")
        print("    [分岔] 走向差异显著，需用户决策")


def main():
    print("╔" + "═" * 58 + "╗")
    print("║" + " " * 12 + "前瞻推理器 Demo" + " " * 29 + "║")
    print("║" + " " * 8 + "Speculative Forecaster v0.1" + " " * 22 + "║")
    print("╚" + "═" * 58 + "╝")

    # 场景1：直道
    print("\n\n输入上下文: \"你好，请帮我写一首关于春天的诗\"")
    print("（意图明确，走向高度一致）")
    f1 = SpeculativeForecaster(MockSampler("straight"), k=3)
    r1 = f1.forecast("你好，请帮我写一首关于春天的诗")
    print_result("场景 1：直道 STRAIGHT", r1)

    # 场景2：缓弯
    print("\n\n输入上下文: \"帮我查一下最近的天气情况\"")
    print("（可能需要检索，也可能直接回答，轻微分歧）")
    f2 = SpeculativeForecaster(MockSampler("curve"), k=3)
    r2 = f2.forecast("帮我查一下最近的天气情况")
    print_result("场景 2：缓弯 CURVE", r2)

    # 场景3：分岔
    print("\n\n输入上下文: \"帮我开发一个爬虫\"")
    print("（意图模糊，可能检索/澄清/写代码，显著分歧）")
    f3 = SpeculativeForecaster(MockSampler("fork"), k=4)
    r3 = f3.forecast("帮我开发一个爬虫")
    print_result("场景 3：分岔 FORK", r3)

    # 总结
    print(f"\n\n{'━' * 60}")
    print("  总结")
    print(f"{'━' * 60}")
    print(f"  直道 STRAIGHT:  D < {r1.thresholds['straight']:.2f}  → 无决策负担，自动前进")
    print(f"  缓弯 CURVE:     {r1.thresholds['straight']:.2f} ≤ D < {r1.thresholds['curve']:.2f}  → 轻微调整")
    print(f"  分岔 FORK:      D ≥ {r1.thresholds['curve']:.2f}  → 用户决策")
    print(f"\n  分歧度 = mean(pairwise_dist) × 0.6 + max(pairwise_dist) × 0.4")
    print(f"  余弦距离 = 1 - cos(θ) ∈ [0, 2]")
    print(f"  聚类: 基于余弦距离的贪心聚类 (eps={0.35})\n")


if __name__ == "__main__":
    main()
