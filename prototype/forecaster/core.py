"""
Speculative Forecaster — 前瞻推理器核心

在用户下一次输入之前，主动推演上下文所有可能的走向，
用分歧度 (divergence) 决定路形：直道 / 缓弯 / 分岔。

设计原则：
- 不依赖具体 LLM SDK，通过 CandidateSampler 抽象注入
- embedding 用 numpy 向量，距离用余弦
- 路形映射阈值可调，按领域校准
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, List, Optional, Protocol

import numpy as np


# ──────────────────────────────────────────────
# 路牌文案净化（防「建议用户访问网站」类泄漏）
# ──────────────────────────────────────────────

# 「建议/请/您+动词+外部资源」句式：动词后必须绑定网站/数据/资料等对象才算命中，
# 避免误伤「建议关注以下要点」这类正常用法。
# 公开常量（URL_RE / PUSHBACK_RE）：前瞻推演路牌净化与执行结果校验共用同一套规则，
# 任何调用方都应从这里导入，不要各自抄写正则（避免规则漂移）。
PUSHBACK_RE = re.compile(
    r'((建议|推荐|请|您|你|用户)(可以|能|可|能够)?(去|先)?(访问|打开|查看|浏览|查阅|搜索|查找|关注|了解|参考)\s*'
    r'[^。；\n]{0,10}(网站|网页|链接|网址|官网|页面|数据集|数据|资料|文献|源))'
)
# 网址 / 链接 / 常见域名后缀
URL_RE = re.compile(r'(https?://|www\.|\.(com|cn|net|org|gov)\b)')


def sanitize_sign_text(text: str) -> str:
    """净化路牌文案：去掉网址与「让用户自己去访问/查看」类话术。

    智能体驾驶舱的哲学是「活儿由智能体干」，路牌上任何暗示用户去外部
    网站/数据源自己查的说法都是产品缺陷。命中即整体替换为空串，
    由调用方决定兜底文案。
    """
    t = (text or "").strip()
    if not t:
        return ""
    if URL_RE.search(t) or PUSHBACK_RE.search(t):
        return ""
    return t


def pushes_back_to_user(text: str) -> bool:
    """判断一段文字是否把任务推回给了用户（建议用户访问网站/查数据）。"""
    t = (text or "").strip()
    if not t:
        return False
    return bool(URL_RE.search(t) or PUSHBACK_RE.search(t))


# ──────────────────────────────────────────────
# 数据结构
# ──────────────────────────────────────────────

class RoadType(str, Enum):
    STRAIGHT = "straight"   # 直道：走向高度一致
    CURVE = "curve"         # 缓弯：轻微分歧
    FORK = "fork"           # 分岔：走向差异显著


@dataclass
class Candidate:
    """一个候选走向"""
    label: str                       # 人类可读标签
    sub: str                        # 简短描述
    vec: np.ndarray                  # embedding 向量
    color: str = "#5ee0ff"          # 可视化颜色
    score: float = 0.0               # 采样概率/置信度
    modality: str = "text"           # 模态类型: text/vision/audio/multimodal
    steps: List[str] = field(default_factory=list)  # 预估子步骤
    rationale: str = ""              # 推荐理由（为什么走这条路）


@dataclass
class ForecastResult:
    """前瞻推理结果"""
    divergence: float                # 分歧度 D ∈ [0, 1]
    road_type: RoadType              # 路形判定
    candidates: List[Candidate]      # 候选走向列表
    clusters: List[List[int]]        # 聚类结果（候选索引分组）
    cost_ms: float                   # 推演耗时
    thresholds: dict = field(default_factory=dict)
    question_type: str = "choice"     # 问题类型: direct/sequential/choice（LLM判断）

    @property
    def fork_count(self) -> int:
        """分岔数量 = 聚类数"""
        return len([c for c in self.clusters if len(c) > 0])


# ──────────────────────────────────────────────
# 抽象接口
# ──────────────────────────────────────────────

class CandidateSampler(Protocol):
    """候选采样器接口——注入具体 LLM 实现"""

    def sample(self, context: str, k: int) -> List[Candidate]:
        """给定上下文，采样 k 个候选走向"""
        ...


# ──────────────────────────────────────────────
# 分歧度计算
# ──────────────────────────────────────────────

def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """余弦距离 = 1 - cos(θ)"""
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 1.0
    return 1.0 - float(np.dot(a, b) / (na * nb))


def compute_divergence(vecs: List[np.ndarray]) -> float:
    """
    分歧度 D = mean(pairwise_dist) × w_mean + max(pairwise_dist) × w_max

    - mean: 整体分散程度
    - max:  最大离散度（捕捉极端分叉）
    - 权重可调，默认 0.6 / 0.4
    """
    n = len(vecs)
    if n <= 1:
        return 0.0

    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs.append(cosine_distance(vecs[i], vecs[j]))

    if not pairs:
        return 0.0

    mean_d = float(np.mean(pairs))
    max_d = float(np.max(pairs))

    # 归一化到 [0, 1]（余弦距离天然 ∈ [0, 2]，但实际聚类时通常 < 1）
    # 用 tanh 压缩，让分布更线性
    mean_norm = math.tanh(mean_d)
    max_norm = math.tanh(max_d)

    return mean_norm * 0.6 + max_norm * 0.4


def cluster_candidates(vecs: List[np.ndarray], eps: float = 0.35) -> List[List[int]]:
    """
    简单聚类：基于余弦距离的贪心聚类。
    eps 越小聚类越严格。

    返回：[[idx, idx, ...], [idx, ...], ...]
    """
    n = len(vecs)
    if n == 0:
        return []

    clusters: List[List[int]] = []
    assigned = [False] * n

    for i in range(n):
        if assigned[i]:
            continue
        cluster = [i]
        assigned[i] = True
        for j in range(i + 1, n):
            if not assigned[j]:
                if cosine_distance(vecs[i], vecs[j]) < eps:
                    cluster.append(j)
                    assigned[j] = True
        clusters.append(cluster)

    return clusters


# ──────────────────────────────────────────────
# 路形映射


# ──────────────────────────────────────────────
# 候选多样化：同义簇折叠 + 最远回填
# ──────────────────────────────────────────────

def diversify_candidates(
    candidates: List[Candidate],
    k: int,
    eps: float = 0.35,
) -> List[Candidate]:
    """
    分桶采样后处理：同义簇只留一个代表，然后按「离所有代表最远者优先」
    回填，直到凑够 k 个或候选池耗尽。

    背景：LLM 采样经常把一堆近义写法塞一个方向（「检索资料/查资料/
    搜索资料/收集信息/全网搜集」在 hashed-TF 下向量几乎重合），
    分岔时用户看着 5 块牌实际只有 1 个方向——「选项不够丰富」的
    下一层形态不是数量缺，而是语义挤。

    规则：
    - 池 ≤ k（人为构造的小规模或候选本就少）：不做任何压缩，
      保量直出——没有冗余可折叠，压缩只会让选项更少。
    - 池 > k：先按 eps 聚类分桶，每桶留一个代表（离桶均值中心最近），
      再把「离所有代表最远」的候选逐个回填进屋，直到凑够 k。
    - 回填池包含被折叠的簇内成员（它们离代表近、优先级低，但当池子
      不够 k 个独立方向时会被重新派上场）。
    """
    if k <= 1 or len(candidates) <= 1:
        return candidates[:k]
    if len(candidates) <= k:
        return candidates

    vecs = [c.vec for c in candidates]

    # 1. 聚类分桶（与展示聚类同一判据 eps，共用一个概念）
    clusters = cluster_candidates(vecs, eps)

    # 2. 每桶留代表：离桶均值中心最近的候选，语义上「最典型」
    retained: List[int] = []
    for cl in clusters:
        mean = np.zeros_like(vecs[cl[0]])
        for i in cl:
            mean += vecs[i]
        if np.linalg.norm(mean) > 0:
            mean /= np.linalg.norm(mean)
        retained.append(min(cl, key=lambda i: cosine_distance(vecs[i], mean)))

    # 3. 最远回填：每轮选离所有已保留代表最远的，直到凑够 k
    pool = [i for i in range(len(candidates)) if i not in retained]
    while len(retained) < k and pool:
        best_i, best_d = None, -1.0
        for i in pool:
            d = min(cosine_distance(vecs[i], vecs[j]) for j in retained)
            if d > best_d:
                best_i, best_d = i, d
        pool.remove(best_i)
        retained.append(best_i)

    # 4. 按原序重排，并截到 k
    retained = sorted(retained)[:k]
    return [candidates[i] for i in retained]
# ──────────────────────────────────────────────

DEFAULT_THRESHOLDS = {
    "straight": 0.20,   # D < 0.2 → 直道
    "curve": 0.35,      # 0.2 ≤ D < 0.35 → 缓弯
    # D ≥ 0.35 → 分岔
}


def road_type_from_divergence(
    divergence: float,
    thresholds: Optional[dict] = None,
) -> RoadType:
    """分歧度 → 路形"""
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    if divergence < t["straight"]:
        return RoadType.STRAIGHT
    if divergence < t["curve"]:
        return RoadType.CURVE
    return RoadType.FORK


# ──────────────────────────────────────────────
# 前瞻推理器
# ──────────────────────────────────────────────

class SpeculativeForecaster:
    """
    前瞻推理器

    流程：
    1. sampler.sample(context, k) → k 个候选
    2. compute_divergence(vecs) → D
    3. road_type_from_divergence(D) → 路形
    4. cluster_candidates(vecs) → 聚类
    """

    def __init__(
        self,
        sampler: CandidateSampler,
        k: int = 5,
        thresholds: Optional[dict] = None,
        cluster_eps: float = 0.35,
        diversify: bool = True,
    ):
        self.sampler = sampler
        self.k = k
        self.thresholds = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
        self.cluster_eps = cluster_eps
        # 候选多样化开关：同义簇折叠 + 最远回填，只对 choice 生效
        self.diversify = diversify

    def forecast(self, context: str, k: int | None = None) -> ForecastResult:
        import time
        # 请求级 k 优先（端点传入），否则用实例默认。
        # 让前端「要 5 个就给 5 个」，而不是写死。
        kk = k if k else self.k

        t0 = time.perf_counter()

        # 1. 采样候选
        candidates = self.sampler.sample(context, kk)
        if not candidates:
            candidates = [Candidate("无候选", "无", np.zeros(3), "#666666")]

        # 1b. 候选多样化（只对 choice）：LLM 超采样池常把一堆近义写法塞进
        #   同一方向——同义簇折叠 + 最远回填，保证 k 块牌语义分散。
        #   direct/sequential 的候选是顺序步骤（向量天然相近），分桶会
        #   把步骤折叠成一个，跳过。
        #   注意：qtype 读取移前从 sampler.last_question_type 直接读，
        #   后续 step 6 有兜底读取（无副作用）。
        _qtype = getattr(self.sampler, 'last_question_type', 'choice')
        if _qtype == 'choice' and self.diversify:
            before = len(candidates)
            # 分桶判据 0.60（工程校准，展示聚类保持 0.35）：
            # hashed-TF 是词面向量。实测「检索资料 vs 查资料 vs 搜索相关
            # 资料」这种「换动词保留名词」的同义模板族内余弦距离
            # 0.52-0.57，而方向间（对比评估 vs 写代码 vs 生成报告等）
            # 最小 0.68——0.60 落在间隙中（覆盖族内最大 0.571，距方向间最小 0.68 留 0.08）。
            # ⚠ 接入真实 embedding（_embed_api）后应回调到 0.35-0.4
            # 语义档——hashed-TF 的物理边界就是词面重合，不是语义。
            candidates = diversify_candidates(candidates, kk, eps=0.60)
            self.last_diversify = (before, len(candidates))

        # 2. 计算分歧度
        vecs = [c.vec for c in candidates]
        divergence = compute_divergence(vecs)

        # 3. 路形
        road = road_type_from_divergence(divergence, self.thresholds)

        # 4. 聚类
        clusters = cluster_candidates(vecs, self.cluster_eps)

        # 5. 若分岔但聚类数 < 2，强制至少 2 簇
        if road == RoadType.FORK and len(clusters) < 2:
            # 把最远的两个候选拆成两簇
            if len(candidates) >= 2:
                clusters = [[0], list(range(1, len(candidates)))]

        t1 = time.perf_counter()
        cost_ms = (t1 - t0) * 1000

        # 6. 读取 sampler 判断的问题类型
        qtype = getattr(self.sampler, 'last_question_type', 'choice')
        # 如果 LLM 判断为 direct，强制 road_type 为 straight
        if qtype == 'direct':
            road = RoadType.STRAIGHT
        elif qtype == 'sequential' and road == RoadType.STRAIGHT:
            road = RoadType.CURVE

        return ForecastResult(
            divergence=divergence,
            road_type=road,
            candidates=candidates,
            clusters=clusters,
            cost_ms=cost_ms,
            thresholds=self.thresholds,
            question_type=qtype,
        )


# ──────────────────────────────────────────────
# 模拟采样器（测试/演示用）
# ──────────────────────────────────────────────

class MockSampler:
    """模拟候选采样器——不调用真实 LLM"""

    def __init__(self, preset: str = "fork"):
        """
        preset: "straight" | "curve" | "fork"
        """
        self.preset = preset

    def sample(self, context: str, k: int) -> List[Candidate]:
        if self.preset == "straight":
            # 高度相似 → 直道
            base = np.array([0.9, 0.1, 0.1])
            noise = np.random.default_rng().normal(0, 0.02, 3)
            return [
                Candidate("直接回答", "信息充分，直接生成", base + noise, "#34f5a0"),
                Candidate("直接回答(变体)", "信息充分，直接生成", base - noise, "#34f5a0"),
                Candidate("直接回答(变体2)", "信息充分，直接生成", base * 0.98, "#34f5a0"),
            ][:k]

        elif self.preset == "curve":
            # 轻微分歧 → 缓弯
            return [
                Candidate("检索资料", "需先查资料", np.array([0.7, 0.6, 0.3]), "#ffb13d"),
                Candidate("直接回答", "信息较充分", np.array([0.95, 0.15, 0.1]), "#34f5a0"),
                Candidate("部分检索", "少量补充即可", np.array([0.4, 0.8, 0.2]), "#ffd23f"),
            ][:k]

        else:  # fork
            # 显著分歧 → 分岔
            return [
                Candidate("直接回答", "信息充分，直接生成", np.array([0.95, 0.12, 0.25]), "#34f5a0"),
                Candidate("检索资料", "需先 RAG 查资料", np.array([0.25, 0.90, 0.15]), "#ffb13d"),
                Candidate("澄清需求", "意图模糊，先追问", np.array([0.15, 0.20, 0.95]), "#ff5fe0"),
                Candidate("代码执行", "需写代码/跑工具", np.array([0.85, 0.45, 0.10]), "#4fa8ff"),
            ][:k]
