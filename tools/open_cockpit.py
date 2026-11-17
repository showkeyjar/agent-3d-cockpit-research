"""一键打开 3D 可视化驾驶舱。

双击（桌面快捷方式）或命令行运行：
    python tools/open_cockpit.py

做三件事：
  1. 探活后端 8770；不通就以脱离进程方式拉起 uvicorn（与看门狗同参数）；
  2. 轮询等待后端就绪（最多约 20 秒）；
  3. 用默认浏览器打开驾驶舱页面，并顺带报告 LLM(8083) 状态。

不改动任何项目代码；路径全部从脚本位置推导，可用环境变量覆盖：
  COCKPIT_BACKEND  如 http://127.0.0.1:8770
  COCKPIT_PY       如 D:/tools/Python312/python.exe
"""

import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

import httpx

# ---- 路径推导（不硬编码个人目录）----
TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TOOLS_DIR.parent
REPO_BACKEND = PROJECT_DIR / "prototype" / "backend"
# 实际运营副本（看门狗从这里拉起）。可用环境变量覆盖；默认探测 LIVE 是否存在。
_DEFAULT_LIVE = Path("C:/Users/smith/WorkBuddy/2026-11-03-19-18-08/agent-3d-cockpit/backend")
_live = Path(os.environ.get("COCKPIT_BACKEND_DIR", str(_DEFAULT_LIVE)))
BACKEND_DIR = _live if (_live / "server.py").exists() else REPO_BACKEND

BASE = os.environ.get("COCKPIT_BACKEND", "http://127.0.0.1:8770").rstrip("/")
PY = os.environ.get("COCKPIT_PY", sys.executable)
HEALTH = BASE + "/api/health"
# 本机 HTTP_PROXY 会把 127.0.0.1 请求错误转发，探活必须绕过代理，否则误判后端掉线
_HTTP = httpx.Client(timeout=6.0, trust_env=False)

DETACHED_PROCESS = 0x00000008
CREATE_NO_WINDOW = 0x08000000


def probe_health(timeout: float = 6.0) -> bool:
    try:
        return _HTTP.get(HEALTH, timeout=timeout).status_code == 200
    except Exception:
        return False


def launch_backend() -> None:
    """以脱离进程方式启动 uvicorn，关掉本脚本窗口后仍存活。

    先清理假死进程：端口 LISTENING 但健康探测超时（看门狗只看端口，
    会误判为健康而不重启）。这类僵尸是「页面能开但一请求就卡」的元凶。
    """
    import psutil  # 延迟导入，缺失时仍可走纯探活路径

    for conn in psutil.net_connections(kind="tcp"):
        if conn.laddr.port == 8770 and conn.status == psutil.CONN_LISTEN and conn.pid:
            try:
                proc = psutil.Process(conn.pid)
                cmdline = " ".join(proc.cmdline())
                if "uvicorn" in cmdline and "server:app" in cmdline:
                    print(f"      清理假死的后端进程 PID {conn.pid} ...")
                    proc.terminate()
                    try:
                        proc.wait(timeout=4)
                    except psutil.TimeoutExpired:
                        proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

    log_path = BACKEND_DIR / "server.log"
    with open(log_path, "ab") as logf:
        subprocess.Popen(
            [PY, "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8770"],
            cwd=str(BACKEND_DIR),
            stdout=logf,
            stderr=logf,
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            close_fds=True,
        )


def llm_status() -> str:
    try:
        r = _HTTP.get("http://127.0.0.1:8083/health", timeout=4)
        return "在线" if r.status_code == 200 else f"异常 HTTP {r.status_code}"
    except Exception:
        return "离线（执行类任务将无法得到真实模型输出）"


def main() -> int:
    print("=" * 52)
    print("  3D 可视化驾驶舱 · 一键启动")
    print("=" * 52)

    if probe_health():
        print("[1/3] 后端 8770 健康，已在运行。")
    else:
        print("[1/3] 后端 8770 未响应（未启动或假死），正在恢复 ...")
        try:
            launch_backend()
        except Exception as e:
            print(f"      启动失败: {e}")
            print(f"      可手动运行: cd {BACKEND_DIR} && {PY} -m uvicorn server:app --port 8770")
            return 1
        for i in range(20):
            time.sleep(1)
            if probe_health():
                print(f"      后端就绪（等待 {i + 1}s）。")
                break
        else:
            print("      等待超时。请查看 backend/server.log 排错。")
            return 1

    print(f"[2/3] LLM 8083 状态: {llm_status()}")
    print(f"[3/3] 打开驾驶舱: {BASE}/")
    try:
        webbrowser.open(BASE + "/")
    except Exception:
        pass  # 打开失败也把 URL 打出来，用户可手动复制
    print(f"\n若浏览器未自动打开，请手动访问: {BASE}/\n")
    time.sleep(2)  # 让双击场景下的控制台停留片刻，看清状态
    return 0


if __name__ == "__main__":
    sys.exit(main())
