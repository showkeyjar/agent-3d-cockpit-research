"""
Vector Space Projection — 向量空间投影

把高维 embedding 向量投影到 3D 坐标，让语义相近的分支在空间中靠近，
语义差异大的分支彼此远离。这是「道路即分歧」的几何化实现。

算法：力导向布局（Force-Directed Layout），纯 numpy 实现，无第三方依赖。
- 吸引力：相邻节点（余弦距离 < eps）互相吸引
- 排斥力：所有节点两两排斥
- 弹簧力：主干道上的节点有锚定弹簧，拉向预设路径

效果：
- 语义相似的候选 → 空间上靠近
- 语义差异大的候选 → 空间上远离
- 分岔路口的分支在 3D 空间中自然展开
"""

from __future__ import annotations

import hashlib
import math
from typing import List, Tuple

import numpy as np

from core import cosine_distance


# ──────────────────────────────────────────────
# 力导向布局
# ──────────────────────────────────────────────

def force_directed_3d(
    vecs: List[np.ndarray],
    anchors: List[Tuple[float, float, float]] | None = None,
    iterations: int = 300,
    attraction: float = 0.8,      # 吸引力强度
    repulsion: float = 2.0,       # 排斥力强度
    spring: float = 0.05,         # 弹簧力强度（锚定主干）
    damping: float = 0.9,         # 阻尼
    eps: float = 0.35,            # 吸引距离阈值
    radius: float = 1.0,          # 初始随机半径
    seed: int | None = None,      # 随机种子；None = 由输入内容派生
) -> List[Tuple[float, float, float]]:
    """
    力导向布局：把 N 个向量投影到 3D 坐标。

    参数：
        vecs:      候选走向的 embedding 向量列表
        anchors:   主干道锚点坐标列表（可选，提供后节点向锚点拉弹簧）
        iterations: 迭代次数
        attraction: 吸引力系数
        repulsion:  排斥力系数
        spring:     弹簧系数（锚定主干）
        damping:    阻尼（0.9 = 慢收敛，稳定）
        eps:        吸引距离阈值（余弦距离 < eps 时互相吸引）
        radius:     初始随机分布半径

    返回：
        List[(x, y, z)] — 每个向量的 3D 坐标
    """
    n = len(vecs)
    if n == 0:
        return []
    if n == 1:
        return [(0.0, 0.0, 0.0)]

    # v0.9.49.2：确定性投影——种子默认由候选向量内容派生（sha256 前缀）。
    # 此前用全局 RNG：同一组候选每次 forecast 的 pos3d 都不同，「道路即分歧」
    # 的几何结论在研究评审中不可复算（同一输入两次运行两种布局）。
    # 同输入 → 同种子 → 同布局；不同输入自然得到不同布局。显式传 seed 可复现实验。
    if seed is None:
        h = hashlib.sha256()
        for v in vecs:
            h.update(np.ascontiguousarray(v, dtype=np.float64).tobytes())
        seed = int.from_bytes(h.digest()[:8], "little")
    rng = np.random.default_rng(seed)

    # 初始��：随机分布在半径为 radius 的球体内
    positions = [
        np.array([
            (rng.standard_normal() * radius),
            (rng.standard_normal() * radius),
            (rng.standard_normal() * radius),
        ])
        for _ in range(n)
    ]

    # 如果提供了锚点，把第一个节点放在锚点位置
    if anchors and len(anchors) > 0:
        positions[0] = np.array(anchors[0], dtype=float)

    velocities = [np.zeros(3) for _ in range(n)]

    # 计算两两余弦距离矩阵
    dist_matrix = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            dist_matrix[i, j] = cosine_distance(vecs[i], vecs[j])

    for iteration in range(iterations):
        # 重置力
        forces = [np.zeros(3) for _ in range(n)]

        # 排斥力（所有节点两两排斥）
        for i in range(n):
            for j in range(i + 1, n):
                delta = positions[i] - positions[j]
                dist = np.linalg.norm(delta)
                if dist < 0.001:
                    delta = rng.standard_normal(3)
                    dist = np.linalg.norm(delta)
                force = repulsion / (dist ** 2)
                dir_vec = delta / dist
                forces[i] += dir_vec * force
                forces[j] -= dir_vec * force

        # 吸引力（语义相近的节点互相吸引）
        for i in range(n):
            for j in range(i + 1, n):
                if dist_matrix[i, j] < eps:
                    delta = positions[j] - positions[i]
                    dist = np.linalg.norm(delta)
                    if dist > 0.001:
                        attraction_strength = attraction * (1 - dist_matrix[i, j] / eps)
                        forces[i] += (delta / dist) * attraction_strength
                        forces[j] -= (delta / dist) * attraction_strength

        # 弹簧力（锚定主干道）
        if anchors and len(anchors) > 0:
            for i in range(min(n, len(anchors))):
                anchor = np.array(anchors[i], dtype=float)
                delta = anchor - positions[i]
                forces[i] += delta * spring

        # 更新速度和位置
        for i in range(n):
            velocities[i] = velocities[i] * damping + forces[i]
            # 限速
            v_mag = np.linalg.norm(velocities[i])
            if v_mag > 0.5:
                velocities[i] /= v_mag * 2
            positions[i] += velocities[i]

    return [(p[0], p[1], p[2]) for p in positions]


# ──────────────────────────────────────────────
# 便捷函数
# ──────────────────────────────────────────────

def project_to_3d(
    vecs: List[np.ndarray],
    anchors: List[Tuple[float, float, float]] | None = None,
    iterations: int = 200,
) -> List[Tuple[float, float, float]]:
    """
    便捷入口：投影到 3D（自动归一化）。

    用法：
        vecs = [np.array([0.9, 0.1, 0.2]), ...]
        coords = project_to_3d(vecs)
        # coords = [(x, y, z), ...]  — 归一化到半径 8 的球内
    """
    raw = force_directed_3d(vecs, anchors=anchors, iterations=iterations)
    return normalize_coords(raw, target_radius=8.0)


def normalize_coords(
    coords: List[Tuple[float, float, float]],
    target_radius: float = 8.0,
) -> List[Tuple[float, float, float]]:
    """
    把 3D 坐标归一化到以 target_radius 为半径的球体内。

    力导向布局的坐标尺度不固定，归一化后便于前端直接使用。
    """
    if not coords:
        return []

    # 找中心
    center = np.array(coords).mean(axis=0)

    # 平移到中心
    shifted = [(c[0] - center[0], c[1] - center[1], c[2] - center[2]) for c in coords]

    # 找最大距离
    max_dist = 0
    for c in shifted:
        d = math.sqrt(c[0]**2 + c[1]**2 + c[2]**2)
        if d > max_dist:
            max_dist = d

    if max_dist < 0.001:
        return [(0.0, 0.0, 0.0) for _ in coords]

    # 缩放
    scale = target_radius / max_dist
    return [
        (c[0] * scale, c[1] * scale, c[2] * scale)
        for c in shifted
    ]


def project_with_spine(
    vecs: List[np.ndarray],
    spine_count: int = 5,
    iterations: int = 200,
) -> Tuple[List[Tuple[float, float, float]], List[Tuple[float, float, float]]]:
    """
    把候选向量投影到 3D，同时生成主干道锚点。

    主干道沿 Z 轴均匀分布，分支节点通过弹簧力拉向主干道。

    返回：
        (branch_coords, spine_anchors)
        branch_coords: 候选分支的 3D 坐标
        spine_anchors: 主干道锚点坐标（沿 Z 轴均匀分布）
    """
    n = len(vecs)
    if n == 0:
        return [], []

    # 主干道锚点：沿 Z 轴均匀分布
    spine_spacing = 4.0
    spine_anchors = [
        (i * spine_spacing, 0.0, i * spine_spacing)
        for i in range(spine_count)
    ]

    # 分支节点投影
    raw_coords = force_directed_3d(
        vecs,
        anchors=spine_anchors,
        iterations=iterations,
        radius=2.0,
    )

    # 归一化到合理尺度
    branch_coords = normalize_coords(raw_coords, target_radius=6.0)

    return branch_coords, spine_anchors


# ──────────────────────────────────────────────
# 多模态 3D 向量空间投影
# ──────────────────────────────────────────────

MODALITY_LAYER = {
    "text":    0.0,   # 文本在主平面
    "vision":  6.0,   # 视觉层在上方
    "audio":  -5.0,   # 音频层在下方
    "multimodal": 3.0, # 融合层在中间偏上
}

MODALITY_COLOR = {
    "text":       "#5ee0ff",
    "vision":     "#ff5fe0",
    "audio":      "#ffd23f",
    "multimodal": "#34f5a0",
}


def multimodal_projection(
    items: List[dict],
    iterations: int = 200,
) -> List[dict]:
    """
    多模态 3D 向量空间投影。

    将不同模态的候选走向投影到 3D 空间的不同垂直层：
    - 文本候选 → y≈0（主平面）
    - 视觉候选 → y≈+6（上层）
    - 音频候选 → y≈-5（下层）
    - 融合候选 → y≈+3（中间偏上）

    每个 item 格式：
        {
            "label": "文本走向A",
            "sub": "描述",
            "vec": np.array([...]),     # embedding 向量
            "modality": "text",         # text / vision / audio / multimodal
            "color": "#5ee0ff",         # 可选，默认按 modality 取色
        }

    返回：
        [{
            "label", "sub", "modality", "color",
            "pos3d": [x, y, z],        # 投影后的 3D 坐标
        }]
    """
    if not items:
        return []

    # 按模态分组
    groups: dict[str, List[tuple]] = {}
    for i, item in enumerate(items):
        mod = item.get("modality", "text")
        groups.setdefault(mod, []).append((i, item["vec"]))

    # 对每个模态组做力导向布局
    all_coords = {}
    for mod, vec_list in groups.items():
        vecs = [v for _, v in vec_list]
        coords = project_to_3d(vecs, iterations=iterations)
        # 按模态设置 Y 层高
        y_layer = MODALITY_LAYER.get(mod, 0.0)
        for (idx, _), (x, _, z) in zip(vec_list, coords):
            all_coords[idx] = (x, y_layer, z)

    # 组装结果
    results = []
    for i, item in enumerate(items):
        mod = item.get("modality", "text")
        color = item.get("color", MODALITY_COLOR.get(mod, "#5ee0ff"))
        x, y, z = all_coords[i]
        results.append({
            "label": item["label"],
            "sub": item["sub"],
            "modality": mod,
            "color": color,
            "pos3d": [round(x, 2), round(y, 2), round(z, 2)],
        })

    return results


# ──────────────────────────────────────────────
# 测试
# ──────────────────────────────────────────────

if __name__ == "__main__":
    # 测试 1：三个正交向量 → 应该展开成三角形
    vecs = [
        np.array([1, 0, 0], dtype=float),
        np.array([0, 1, 0], dtype=float),
        np.array([0, 0, 1], dtype=float),
    ]
    coords = project_to_3d(vecs, iterations=200)
    print("测试 1：正交向量")
    for i, c in enumerate(coords):
        print(f"  节点 {i}: ({c[0]:.2f}, {c[1]:.2f}, {c[2]:.2f})")
    # 验证两两距离
    for i in range(3):
        for j in range(i+1, 3):
            d = math.sqrt(sum((coords[i][k]-coords[j][k])**2 for k in range(3)))
            print(f"  距离 {i}-{j}: {d:.2f}")
    print()

    # 测试 2：两个相似 + 一个正交
    vecs = [
        np.array([0.95, 0.1, 0.1], dtype=float),
        np.array([0.9, 0.2, 0.1], dtype=float),  # 相似
        np.array([0.1, 0.1, 0.95], dtype=float),  # 正交
    ]
    coords = project_to_3d(vecs, iterations=200)
    print("测试 2：相似 + 正交")
    for i, c in enumerate(coords):
        print(f"  节点 {i}: ({c[0]:.2f}, {c[1]:.2f}, {c[2]:.2f})")
    d01 = math.sqrt(sum((coords[0][k]-coords[1][k])**2 for k in range(3)))
    d02 = math.sqrt(sum((coords[0][k]-coords[2][k])**2 for k in range(3)))
    print(f"  相似节点距离: {d01:.2f}")
    print(f"  正交节点距离: {d02:.2f}")
    assert d01 < d02, "相似节点应该比正交节点更近！"
    print("  ✅ 相似节点更近，正交节点更远")
    print()

    # 测试 3：带主干道的投影
    vecs = [
        np.array([0.95, 0.12, 0.25], dtype=float),
        np.array([0.25, 0.90, 0.15], dtype=float),
        np.array([0.15, 0.20, 0.95], dtype=float),
        np.array([0.85, 0.45, 0.10], dtype=float),
    ]
    branch_coords, spine_anchors = project_with_spine(vecs, spine_count=5, iterations=200)
    print("测试 3：带主干道投影")
    print("  分支坐标:")
    for i, c in enumerate(branch_coords):
        print(f"    分支 {i}: ({c[0]:.2f}, {c[1]:.2f}, {c[2]:.2f})")
    print("  主干道锚点:")
    for i, c in enumerate(spine_anchors):
        print(f"    锚点 {i}: ({c[0]:.2f}, {c[1]:.2f}, {c[2]:.2f})")
    print("  ✅ 投影成功")
