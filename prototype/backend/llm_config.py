"""LLM 配置中心 —— 环境变量默认值 + llm-config.json 覆盖 + 运行时热更新。

设计目标：驾驶舱作为独立产品，用户可在界面里配置大模型，不必改环境变量/重启。

优先级：llm-config.json > 环境变量 > 内置默认值。
- 无配置文件时，行为与旧版完全一致（读环境变量），回归兼容。
- 保存配置写入 llm-config.json（同目录），下次启动仍生效。
- 热更新：改配置后清空推理器缓存，下一次 forecast/execute 用新配置重建。

诚实原则：api_key 在任何对外接口中都脱敏，绝不回传明文。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

CONFIG_PATH = Path(__file__).parent / "llm-config.json"

# 字段定义：key -> (env 变量, 默认值, 是否敏感)
_FIELDS: dict[str, tuple[str, Any, bool]] = {
    "base_url": ("LLM_BASE_URL", "http://localhost:8083/v1", False),
    "model": ("LLM_MODEL", "local-primary", False),
    "api_key": ("LLM_API_KEY", "EMPTY", True),
    "embedding_model": ("LLM_EMBEDDING_MODEL", "", False),
    "exec_use_llm": ("EXEC_USE_LLM", "1", False),
}

_lock = threading.RLock()
_overrides: dict[str, Any] = {}          # 来自配置文件的覆盖值
_change_counter = 0                      # 每次变更 +1，供 server 判断是否需要重建推理器


def _load_file() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _coerce(key: str, value: Any) -> Any:
    """按字段语义规整类型，避免界面传来字符串导致布尔判断出错。"""
    if key == "exec_use_llm":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    return str(value)


def reload_from_disk() -> None:
    """从磁盘重新加载覆盖值（进程启动时调用一次）。"""
    global _overrides, _change_counter
    with _lock:
        raw = _load_file()
        _overrides = {
            k: _coerce(k, raw[k])
            for k in _FIELDS
            if k in raw and raw[k] is not None
        }
        _change_counter += 1


def get(key: str) -> Any:
    with _lock:
        if key in _overrides:
            return _overrides[key]
        env, default, _ = _FIELDS[key]
        return _coerce(key, os.environ.get(env, default))


def snapshot(mask: bool = True) -> dict[str, Any]:
    """返回当前生效配置。mask=True 时 api_key 脱敏。"""
    out = {k: get(k) for k in _FIELDS}
    # 来源标注：每个字段来自文件覆盖还是环境/默认，界面如实展示
    out["_source"] = {}
    for k in _FIELDS:
        if k in _overrides and os.environ.get(_FIELDS[k][0]) is not None:
            out["_source"][k] = "file (覆盖环境变量)"
        elif k in _overrides:
            out["_source"][k] = "file"
        elif os.environ.get(_FIELDS[k][0]) is not None:
            out["_source"][k] = "env"
        else:
            out["_source"][k] = "default"
    if mask:
        key = out.get("api_key", "")
        out["api_key"] = _mask(key)
        out["api_key_set"] = bool(key) and key != "EMPTY"
    return out


def _mask(key: str) -> str:
    if not key or key == "EMPTY":
        return ""
    if len(key) <= 4:
        return "*" * len(key)
    return key[:2] + "*" * (len(key) - 4) + key[-2:]


def version() -> int:
    """配置版本号；server 据此判断推理器缓存是否过期。"""
    with _lock:
        return _change_counter


def update(patch: dict[str, Any], persist: bool = True) -> dict[str, Any]:
    """热更新配置。仅接受已知字段；api_key 传空串表示保持不变（脱敏回传所致）。

    返回脱敏后的当前快照。
    """
    global _overrides, _change_counter
    with _lock:
        new = dict(_overrides)
        for k, v in patch.items():
            if k not in _FIELDS:
                continue
            if k == "api_key" and (v == "" or v is None):
                continue  # 脱敏占位，不改
            new[k] = _coerce(k, v)
        _overrides = new
        if persist:
            CONFIG_PATH.write_text(
                json.dumps(_overrides, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        _change_counter += 1
    return snapshot(mask=True)


def reset_to_defaults(persist: bool = True) -> dict[str, Any]:
    """清除所有覆盖，回到环境变量/默认值。"""
    global _overrides, _change_counter
    with _lock:
        _overrides = {}
        if persist and CONFIG_PATH.exists():
            CONFIG_PATH.unlink()
        _change_counter += 1
    return snapshot(mask=True)


# 进程启动时加载一次
reload_from_disk()
