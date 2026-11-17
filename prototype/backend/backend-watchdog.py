# -*- coding: utf-8 -*-
"""8770 后端看门狗：每 30s 探活 /api/health，宕则以 DETACHED_PROCESS 拉起 uvicorn。
uvicorn 以 DETACHED_PROCESS|CREATE_NO_WINDOW 脱钩——看门狗死了它也活着。
与 llama-server 的 start-server-35b 机制对齐；Startup 里由 Backend-8770-Watchdog.vbs 自启。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8770
# 用「当前解释器」启动 uvicorn，而非硬编码机器路径——换机/换虚拟环境都能跑。
# 若需指定解释器，用环境变量 COCKPIT_PYTHON 覆盖。
PY = os.environ.get("COCKPIT_PYTHON") or sys.executable or "python"
PROBE_URL = f"http://127.0.0.1:{PORT}/api/health"

# 本机 HTTP_PROXY 会把回环地址请求误转发 → 探活失败/假死误判。强制直连。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def healthy() -> bool:
    """真实健康探测：必须拿到 200 + JSON status=ok。

    不能只看端口 LISTENING——uvicorn 卡死时端口仍在，但请求超时；
    那样看门狗会误判健康、永不重启卡死进程。
    """
    try:
        with _OPENER.open(PROBE_URL, timeout=5) as r:
            if r.status != 200:
                return False
            body = r.read(4096)
            try:
                return json.loads(body).get("status") == "ok"
            except Exception:
                return True  # 拿到 200 但非 JSON，仍算活
    except Exception:
        return False


def launch() -> None:
    creationflags = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
    with open(os.path.join(BACKEND_DIR, "server.log"), "ab") as logf:
        subprocess.Popen(
            [PY, "-m", "uvicorn", "server:app",
             "--host", "0.0.0.0", "--port", str(PORT)],
            cwd=BACKEND_DIR,
            stdout=logf, stderr=logf,
            creationflags=creationflags,
            close_fds=True,
        )


def main() -> None:
    print(f"[backend-watchdog] start, probing {PROBE_URL} every 30s", flush=True)
    while True:
        try:
            if not healthy():
                print("[backend-watchdog] port down -> launching uvicorn", flush=True)
                launch()
                time.sleep(8)  # 给新进程一点启动时间，避免 30s 后又探到半起状态
        except Exception as e:  # 看门狗自身绝不因单次异常退出
            print(f"[backend-watchdog] error: {e}", flush=True)
        time.sleep(30)


if __name__ == "__main__":
    main()
