#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""sync_live.py — repo → LIVE 一键同步（替代手动 cp，可干跑、可校验）。

背景：8770 看门狗从 LIVE 目录拉起 uvicorn，改 repo 后端后必须同步到 LIVE
并重启才生效——纯手动 cp 踩过「只改 repo 不生效」的坑（见工作日志）。
本工具把该流程固化：默认干跑显示差异，--apply 才真复制，--restart 连带重启。

用法（在仓库根目录）：
    python tools/sync_live.py                  # 干跑：显示 repo↔LIVE 差异
    python tools/sync_live.py --apply          # 同步（仅复制 repo 比 LIVE 新/不同的文件）
    python tools/sync_live.py --apply --restart  # 同步 + 重启 8770（杀监听进程，等看门狗拉起）

LIVE 目录解析顺序：
    1. 环境变量 COCKPIT_LIVE_DIR（精确路径，其根应含 backend/server.py）
    2. 自动探测 %USERPROFILE%/WorkBuddy/*/agent-3d-cockpit（恰好一个时直接用，多个时列出并退出）

安全边界：
    - 单向 repo→LIVE，绝不反向覆盖 repo。
    - LIVE 独有的文件不动（只同步清单内的映射文件）。
    - 每个文件复制前后 sha256 校验，失败即报错。
    - --restart 只杀 8770 的监听进程，由看门狗自动拉起；无看门狗时提示手动命令。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROTO = REPO / "prototype"
PORT = 8770

# repo/prototype/X → LIVE/X 的同步清单（后端 + 前端 + 推理器 + 回归入口）
SYNC_FILES = [
    "index.html",
    "CHANGELOG.md",
    "run_regression.sh",
    "package.json",
    "chrome_helper.js",
    "requirements.txt",
    "backend/server.py",
    "backend/task_tracker.py",
    "backend/llm_config.py",
    "backend/expert_state.py",
    "backend/memory.py",
    "backend/backend-watchdog.py",
    "backend/start-watchdog.bat",
    "forecaster/core.py",
    "forecaster/llm_forecaster.py",
    "forecaster/projection.py",
]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def find_live() -> Path | None:
    env = os.environ.get("COCKPIT_LIVE_DIR")
    if env:
        p = Path(env)
        if (p / "backend" / "server.py").exists():
            return p
        print(f"COCKPIT_LIVE_DIR={env} 下没有 backend/server.py，不是有效 LIVE 目录")
        return None
    wb = Path.home() / "WorkBuddy"
    if not wb.exists():
        return None
    cands = sorted(p for p in wb.glob("*/agent-3d-cockpit")
                   if (p / "backend" / "server.py").exists())
    if len(cands) == 1:
        return cands[0]
    if len(cands) > 1:
        print("探测到多个 LIVE 目录，请用 COCKPIT_LIVE_DIR 明确指定其一：")
        for c in cands:
            print(f"  {c}")
    return None


def kill_8770() -> bool:
    """杀掉 8770 监听进程（Windows）。返回是否找到并杀掉。"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue "
             f"| Select-Object -First 1 -ExpandProperty OwningProcess"],
            capture_output=True, text=True, timeout=15)
        pid = out.stdout.strip()
        if not pid.isdigit():
            print(f"  端口 {PORT} 当前无监听进程（看门狗会自动拉起）")
            return False
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=15)
        print(f"  已结束监听 {PORT} 的进程 PID={pid}；看门狗将在 ≤30s 内自动拉起新版")
        return True
    except Exception as e:
        print(f"  重启失败：{e}；请手动结束 {PORT} 端口进程")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="repo → LIVE 同步（默认干跑）")
    ap.add_argument("--apply", action="store_true", help="真复制（默认只显示差异）")
    ap.add_argument("--restart", action="store_true", help="同步后重启 8770（需 --apply）")
    args = ap.parse_args()

    live = find_live()
    if not live:
        print("未找到 LIVE 目录：请设置 COCKPIT_LIVE_DIR 指向运行副本根"
              "（其下应含 backend/server.py）")
        return 2
    print(f"LIVE = {live}")
    print(f"模式 = {'APPLY（真复制）' if args.apply else 'DRY-RUN（只显示差异）'}\n")

    changed, missing_in_live = [], []
    for rel in SYNC_FILES:
        src = PROTO / rel
        dst = live / rel
        if not src.exists():
            print(f"  ⚠ repo 缺少 {rel}（跳过）")
            continue
        if not dst.exists():
            missing_in_live.append(rel)
            continue
        if sha256(src) != sha256(dst):
            changed.append(rel)

    if missing_in_live:
        print("LIVE 缺少的文件（首次会复制）：")
        for rel in missing_in_live:
            print(f"  + {rel}")
    if changed:
        print("内容不同的文件：")
        for rel in changed:
            print(f"  ~ {rel}")
    todo = changed + missing_in_live
    if not todo:
        print("\nrepo 与 LIVE 完全一致，无需同步。")
        return 0
    print(f"\n共 {len(todo)} 个文件待同步。")

    if not args.apply:
        print("干跑结束（未复制）。加 --apply 执行同步。")
        return 0

    ok = 0
    for rel in todo:
        src, dst = PROTO / rel, live / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if sha256(src) == sha256(dst):
            ok += 1
            print(f"  ✅ {rel}")
        else:
            print(f"  ❌ {rel}（复制后校验不一致！）")
    print(f"\n同步完成：{ok}/{len(todo)} 校验通过。")
    if ok != len(todo):
        return 1

    if args.restart:
        print("\n重启 8770：")
        kill_8770()
        print("  等待看门狗拉起后可用以下命令验证：")
        print(f"  powershell -c \"(Invoke-WebRequest http://127.0.0.1:{PORT}/api/health -UseBasicParsing).Content\"")
    else:
        print("提示：后端进程不会热加载——需重启 8770 才生效（本工具加 --restart，或手动结束端口进程）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
