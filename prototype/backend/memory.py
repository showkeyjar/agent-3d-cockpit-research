"""
Agent Cockpit Memory — SQLite 轨迹持久化

行驶完成后保存 journey + branches + metadata，
重新打开时一键恢复"上次开到哪"。

Usage:
    from memory import MemoryStore
    ms = MemoryStore("cockpit.db")
    ms.save_journey(...)
    journeys = ms.list_journeys()
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS journeys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    context     TEXT NOT NULL,
    divergence  REAL NOT NULL,
    road_type   TEXT NOT NULL,
    cost_ms     REAL NOT NULL,
    node_count  INTEGER NOT NULL,
    branch_count INTEGER NOT NULL,
    reached_end INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journey_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id  INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    label       TEXT NOT NULL,
    sub         TEXT,
    pos_json    TEXT NOT NULL,
    passed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journey_branches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id  INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    branch_id   TEXT NOT NULL,
    from_label  TEXT NOT NULL,
    label       TEXT NOT NULL,
    sub         TEXT,
    color       TEXT NOT NULL,
    pos_json    TEXT NOT NULL,
    committed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journey_meta (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id  INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL
);
"""


class MemoryStore:
    """SQLite 持久化层"""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # WS 高频写 + REST 读并发：开启 WAL 让读写不互斥，降低锁等待。
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _ensure_schema(self):
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    # ── 保存 ──

    def save_journey(
        self,
        title: str,
        context: str,
        divergence: float,
        road_type: str,
        cost_ms: float,
        nodes: list[dict],
        branches: list[dict],
        reached_end: bool = False,
        meta: dict[str, str] | None = None,
    ) -> int:
        """保存一次完整的行驶轨迹，返回 journey_id"""
        now = datetime.now().isoformat()
        with self._connect() as conn:
            cur = conn.execute(
                """INSERT INTO journeys
                   (title, context, divergence, road_type, cost_ms,
                    node_count, branch_count, reached_end, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    title,
                    context,
                    divergence,
                    road_type,
                    cost_ms,
                    len(nodes),
                    len(branches),
                    1 if reached_end else 0,
                    now,
                    now,
                ),
            )
            jid = cur.lastrowid

            for i, n in enumerate(nodes):
                conn.execute(
                    """INSERT INTO journey_nodes
                       (journey_id, idx, label, sub, pos_json, passed)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        jid,
                        i,
                        n.get("label", ""),
                        n.get("sub", ""),
                        json.dumps(n.get("pos", [0, 0, 0])),
                        1 if n.get("passed") else 0,
                    ),
                )

            for b in branches:
                conn.execute(
                    """INSERT INTO journey_branches
                       (journey_id, branch_id, from_label, label, sub, color, pos_json, committed)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        jid,
                        b.get("id", ""),
                        b.get("from", ""),
                        b.get("label", ""),
                        b.get("sub", ""),
                        b.get("color", "#5ee0ff"),
                        json.dumps(b.get("pos", [0, 0, 0])),
                        1 if b.get("committed") else 0,
                    ),
                )

            if meta:
                for k, v in meta.items():
                    conn.execute(
                        "INSERT INTO journey_meta (journey_id, key, value) VALUES (?, ?, ?)",
                        (jid, k, str(v)),
                    )

        return jid

    # ── 查询 ──

    def list_journeys(self, limit: int = 20) -> list[dict]:
        """列出最近的行驶记录"""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM journeys ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_journey(self, journey_id: int) -> dict | None:
        """获取完整轨迹（含 nodes + branches）"""
        with self._connect() as conn:
            j = conn.execute(
                "SELECT * FROM journeys WHERE id = ?", (journey_id,)
            ).fetchone()
            if not j:
                return None

            nodes = conn.execute(
                "SELECT * FROM journey_nodes WHERE journey_id = ? ORDER BY idx",
                (journey_id,),
            ).fetchall()
            branches = conn.execute(
                "SELECT * FROM journey_branches WHERE journey_id = ? ORDER BY id",
                (journey_id,),
            ).fetchall()
            meta_rows = conn.execute(
                "SELECT key, value FROM journey_meta WHERE journey_id = ?",
                (journey_id,),
            ).fetchall()

            return {
                "journey": dict(j),
                "nodes": [
                    {
                        "label": r["label"],
                        "sub": r["sub"],
                        "pos": json.loads(r["pos_json"]),
                        "passed": bool(r["passed"]),
                    }
                    for r in nodes
                ],
                "branches": [
                    {
                        "id": r["branch_id"],
                        "from": r["from_label"],
                        "label": r["label"],
                        "sub": r["sub"],
                        "color": r["color"],
                        "pos": json.loads(r["pos_json"]),
                        "committed": bool(r["committed"]),
                    }
                    for r in branches
                ],
                "meta": {r["key"]: r["value"] for r in meta_rows},
            }

    def delete_journey(self, journey_id: int) -> bool:
        """删除一条轨迹"""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM journeys WHERE id = ?", (journey_id,)
            )
            return cur.rowcount > 0

    def update_journey_progress(self, journey_id: int, reached_end: bool = False):
        """更新行驶进度（每次节点经过时调用）"""
        with self._connect() as conn:
            conn.execute(
                "UPDATE journeys SET reached_end = ?, updated_at = ? WHERE id = ?",
                (1 if reached_end else 0, datetime.now().isoformat(), journey_id),
            )


# ── 自测 ──
if __name__ == "__main__":
    import tempfile
    import os

    db = os.path.join(tempfile.gettempdir(), "cockpit_test.db")
    if os.path.exists(db):
        os.remove(db)

    ms = MemoryStore(db)

    jid = ms.save_journey(
        title="Python 爬虫开发",
        context="帮我写一个 Python 爬虫",
        divergence=0.47,
        road_type="fork",
        cost_ms=14500,
        nodes=[
            {"label": "开始", "sub": "意图解析", "pos": [0, 0, 0], "passed": True},
            {"label": "理解", "sub": "需求拆解", "pos": [5.5, 0, 5], "passed": True},
            {"label": "执行", "sub": "分支选择", "pos": [11, 0, 10], "passed": False},
            {"label": "验证", "sub": "测试运行", "pos": [16.5, 0, 15], "passed": False},
            {"label": "完成", "sub": "交付结果", "pos": [22, 0, 20], "passed": False},
        ],
        branches=[
            {
                "id": "b0",
                "from": "执行",
                "label": "检索资料",
                "sub": "需先查资料",
                "color": "#ffb13d",
                "pos": [12, 3.5, 8],
                "committed": False,
            },
            {
                "id": "b1",
                "from": "执行",
                "label": "代码执行",
                "sub": "需写代码",
                "color": "#4fa8ff",
                "pos": [12, -3.5, 12],
                "committed": False,
            },
        ],
        reached_end=False,
        meta={"source": "llm", "model": "local-primary"},
    )
    print(f"✅ Saved journey #{jid}")

    journeys = ms.list_journeys()
    print(f"✅ List: {len(journeys)} journey(s)")
    for j in journeys:
        print(f"   #{j['id']} {j['title']} ({j['road_type']}, D={j['divergence']})")

    full = ms.get_journey(jid)
    print(f"✅ Loaded: {full['journey']['title']}")
    print(f"   Nodes: {len(full['nodes'])}, Branches: {len(full['branches'])}")
    print(f"   Node[0]: {full['nodes'][0]}")
    print(f"   Branch[0]: {full['branches'][0]}")
    print(f"   Meta: {full['meta']}")

    ms.delete_journey(jid)
    print(f"✅ Deleted, remaining: {len(ms.list_journeys())}")
