"""
Unit tests for SpeculativeForecaster.
Run: python -m pytest tests/test_core.py -v
Or:  python tests/test_core.py  (standalone)
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from core import (
    SpeculativeForecaster,
    MockSampler,
    compute_divergence,
    cosine_distance,
    road_type_from_divergence,
    cluster_candidates,
    RoadType,
    Candidate,
    DEFAULT_THRESHOLDS,
)


# ──────────────────────────────────────────────
# cosine_distance
# ──────────────────────────────────────────────

class TestCosineDistance:
    def test_identical_vectors(self):
        v = np.array([1, 2, 3])
        assert cosine_distance(v, v) == pytest.approx(0.0, abs=1e-9)

    def test_orthogonal_vectors(self):
        assert cosine_distance(np.array([1, 0]), np.array([0, 1])) == pytest.approx(1.0)

    def test_opposite_vectors(self):
        assert cosine_distance(np.array([1, 0]), np.array([-1, 0])) == pytest.approx(2.0)

    def test_zero_vector(self):
        assert cosine_distance(np.array([0, 0]), np.array([1, 0])) == pytest.approx(1.0)

    def test_same_direction_different_magnitude(self):
        d = cosine_distance(np.array([2, 0]), np.array([5, 0]))
        assert d == pytest.approx(0.0, abs=1e-9)


# ──────────────────────────────────────────────
# compute_divergence
# ──────────────────────────────────────────────

class TestDivergence:
    def test_single_candidate(self):
        assert compute_divergence([np.array([1, 0, 0])]) == 0.0

    def test_identical_candidates(self):
        v = np.array([0.5, 0.5, 0.5])
        assert compute_divergence([v, v, v]) == pytest.approx(0.0, abs=1e-9)

    def test_orthogonal_candidates(self):
        vecs = [np.array([1, 0, 0]), np.array([0, 1, 0])]
        D = compute_divergence(vecs)
        # mean=1.0, max=1.0 → tanh(1)*0.6 + tanh(1)*0.4 = tanh(1)
        assert D == pytest.approx(np.tanh(1.0), abs=1e-9)

    def test_partial_divergence(self):
        vecs = [
            np.array([0.9, 0.1, 0.1]),
            np.array([0.7, 0.5, 0.3]),
            np.array([0.3, 0.25, 0.92]),
        ]
        D = compute_divergence(vecs)
        assert 0.0 < D < 1.0

    def test_range(self):
        """D should always be in [0, 1]"""
        rng = np.random.default_rng(42)
        for _ in range(50):
            vecs = [rng.normal(size=8) for _ in range(5)]
            D = compute_divergence(vecs)
            assert 0.0 <= D <= 1.0


# ──────────────────────────────────────────────
# road_type_from_divergence
# ──────────────────────────────────────────────

class TestRoadType:
    def test_straight(self):
        assert road_type_from_divergence(0.05) == RoadType.STRAIGHT
        assert road_type_from_divergence(0.15) == RoadType.STRAIGHT

    def test_curve(self):
        assert road_type_from_divergence(0.25) == RoadType.CURVE
        assert road_type_from_divergence(0.35) == RoadType.CURVE

    def test_fork(self):
        assert road_type_from_divergence(0.45) == RoadType.FORK
        assert road_type_from_divergence(0.8) == RoadType.FORK

    def test_custom_thresholds(self):
        t = {"straight": 0.1, "curve": 0.2}
        assert road_type_from_divergence(0.15, t) == RoadType.CURVE
        assert road_type_from_divergence(0.25, t) == RoadType.FORK


# ──────────────────────────────────────────────
# cluster_candidates
# ──────────────────────────────────────────────

class TestClustering:
    def test_identical_cluster(self):
        v = np.array([1, 0, 0])
        clusters = cluster_candidates([v, v, v])
        assert len(clusters) == 1

    def test_two_clusters(self):
        vecs = [
            np.array([1, 0, 0]),
            np.array([0.98, 0.02, 0]),
            np.array([0, 1, 0]),
        ]
        clusters = cluster_candidates(vecs, eps=0.1)
        assert len(clusters) == 2

    def test_empty(self):
        assert cluster_candidates([]) == []


# ──────────────────────────────────────────────
# SpeculativeForecaster (integration)
# ──────────────────────────────────────────────

class TestForecaster:
    def test_fork_preset(self):
        f = SpeculativeForecaster(MockSampler("fork"), k=4)
        result = f.forecast("帮我写一个爬虫")
        assert result.road_type == RoadType.FORK
        assert result.fork_count >= 2
        assert len(result.candidates) == 4
        assert result.cost_ms > 0

    def test_straight_preset(self):
        f = SpeculativeForecaster(MockSampler("straight"), k=3)
        result = f.forecast("你好")
        assert result.road_type == RoadType.STRAIGHT
        assert result.divergence < DEFAULT_THRESHOLDS["straight"]

    def test_curve_preset(self):
        f = SpeculativeForecaster(MockSampler("curve"), k=3)
        result = f.forecast("帮我查一下天气")
        assert result.road_type == RoadType.CURVE
        assert DEFAULT_THRESHOLDS["straight"] <= result.divergence < DEFAULT_THRESHOLDS["curve"]

    def test_result_fields(self):
        f = SpeculativeForecaster(MockSampler("fork"), k=4)
        result = f.forecast("test")
        assert hasattr(result, "divergence")
        assert hasattr(result, "road_type")
        assert hasattr(result, "candidates")
        assert hasattr(result, "clusters")
        assert hasattr(result, "cost_ms")
        assert hasattr(result, "fork_count")

    def test_custom_thresholds(self):
        t = {"straight": 0.05, "curve": 0.15}
        f = SpeculativeForecaster(MockSampler("curve"), k=3, thresholds=t)
        result = f.forecast("test")
        # With tighter thresholds, curve preset should be FORK
        assert result.road_type == RoadType.FORK


# ──────────────────────────────────────────────
# Standalone runner
# ──────────────────────────────────────────────

if __name__ == "__main__":
    # Simple standalone test (no pytest dependency)
    print("Running standalone tests...\n")
    failures = 0

    def check(name, cond):
        global failures
        status = "✅" if cond else "❌"
        if not cond: failures += 1
        print(f"  {status} {name}")

    # Test cosine
    v = np.array([1, 2, 3])
    check("cosine identical", abs(cosine_distance(v, v)) < 1e-9)
    check("cosine orthogonal", abs(cosine_distance(np.array([1,0]), np.array([0,1])) - 1.0) < 1e-9)

    # Test divergence
    check("divergence single", compute_divergence([np.array([1,0,0])]) == 0.0)
    check("divergence identical", compute_divergence([v, v, v]) < 1e-9)
    check("divergence orthogonal", compute_divergence([np.array([1,0,0]), np.array([0,1,0])]) > 0.5)

    # Test road type
    check("road straight", road_type_from_divergence(0.05) == RoadType.STRAIGHT)
    check("road curve", road_type_from_divergence(0.3) == RoadType.CURVE)
    check("road fork", road_type_from_divergence(0.6) == RoadType.FORK)

    # Test forecaster
    f = SpeculativeForecaster(MockSampler("fork"), k=4)
    r = f.forecast("test")
    check("forecaster fork", r.road_type == RoadType.FORK)
    check("forecaster fork_count", r.fork_count >= 2)
    check("forecaster cost", r.cost_ms > 0)

    f2 = SpeculativeForecaster(MockSampler("straight"), k=3)
    r2 = f2.forecast("test")
    check("forecaster straight", r2.road_type == RoadType.STRAIGHT)

    print(f"\n{'✅ All tests passed!' if failures == 0 else f'❌ {failures} test(s) failed!'}")
    sys.exit(1 if failures else 0)
