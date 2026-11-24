#!/usr/bin/env bash
# run_regression.sh — prototype 常驻回归一键跑（顺序执行，便于单槽串行）
# 用法： bash run_regression.sh   （在 prototype/ 目录下）
set -u
cd "$(dirname "$0")"

echo "== 后端健康检查 =="
curl -s -o /dev/null -w "8770 health=%{http_code}\n" http://127.0.0.1:8770/api/health || {
  echo "后端未启动，请先: cd backend && uvicorn server:app --port 8770"; exit 1; }

JS_TESTS=(
  # 实验操纵完整性门禁（M2 四组对照，操纵必须同等锁死）
  verify_opaque.js            # A 组（执行不透明）
  test_decorative.js          # C 组（镜像欺骗，本地伪执行）
  test_transparent_nolink.js  # B0（3D 联动关闭单归因）
  test_no_fingerprint.js      # B2（指纹环隐藏单变量）
  test_honesty.js
  test_practical.js
  test_keyboard.js
  test_scenery.js
  test_compare.js
  test_context_pull.js
  test_cancel.js
  test_timeline.js
  test_sign_topics.js
  test_rail_camera.js
  # F3 联动/视野体验回归（v0.9.28 相关）
  test_f32_link.js
  test_f36_speedlines.js
  test_f37_density.js
  test_f38_sequence.js
  # 模型设置面板（不消耗推理槽，仅探 /health）
  test_model_settings.js
  # v0.9.47–49 用户实测修复回归
  test_fp_arrival_rebuild.js  # v0.9.47 指纹环时序/放大
  test_terminal_task.js       # v0.9.48 类型分流+终态（断死循环）
  test_arrival_persist.js     # v0.9.49 到达结果牌保留+拉近下限
  # v0.9.50–54 FI 修复 + 体验回归（GPT 评审 #5：默认入口此前漏跑）
  test_exec_drive.js          # FI-01 事件驱动行驶（含 A0 无事件静止）
  test_future_refine.js       # FI-03 探索环异步精修
  test_fi09.js                # FI-09 触屏长按 + 单槽等待
  test_i18n.js                # FI-08 多语言
  test_calm_motion.js         # v0.9.53/54 静默动效 + 分界环静态化
  test_link_tint_pixel.js     # v0.9.55 B0/B1 联动判据【像素层】有效性
  # v0.9.56 新定位落点：思考辅助 / 思维导图生成（只读投影，不改账本）
  test_cross_turn_metrics.js  # 跨轮三层不同步探针（Q-b 的数据前提）
  test_view_horizon.js        # Q-b 语义视野边界可视化（20 项）
  test_mindmap_export.js      # 分叉树 → 思考地图 .md 导出（19 项）
)

fail=0
for t in "${JS_TESTS[@]}"; do
  echo "===== $t ====="
  if node "$t"; then
    echo "  ✓ $t"
  else
    echo "  ✗ $t FAILED"
    fail=$((fail+1))
  fi
done

echo ""
echo "== 后端 Python 单测（pytest 收集纯函数）=="
if command -v pytest >/dev/null 2>&1; then
  pytest -q forecaster/tests/ || fail=$((fail+1))   # cancel_backend 由下方 __main__ 直跑段负责
else
  echo "（未装 pytest，跳过；进入 prototype 目录用 python -m pytest forecaster/tests/ backend/ 手动跑）"
fi

# GPT 评审 #5：以下后端契约脚本通过 if __name__=='__main__' 自行运行，pytest 不收集其 main 逻辑。
#   此前默认回归漏跑，导致"29 项通过"覆盖不到取消/断线/截断/专家状态等真实契约。
#   全部是纯本地（假推理服务/纯函数），不占 8083 模型槽。
#   test_cancel_e2e.py 依赖真实 35B，是可选冒烟，不进默认回归。
# 选一个装了 aiohttp 的解释器：这些契约脚本用本地假推理服务（aiohttp），系统 python 可能没装。
#   优先 PYTHON 环境变量 → 常见 Windows 开发路径 → python3/python；逐个探测 import aiohttp。
PY=""
for cand in "${PYTHON:-}" "D:/tools/Python312/python" "python3" "python"; do
  [ -z "$cand" ] && continue
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import aiohttp" >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [ -z "$PY" ]; then
  echo "（未找到装 aiohttp 的 Python 解释器，跳过 __main__ 契约脚本；请设 PYTHON=路径重跑）"
fi
echo ""
echo "== 后端契约脚本（__main__ 直跑，pytest 不收集；PY=$PY）=="
PY_SCRIPTS=(
  backend/test_cancel_backend.py   # v0.9.16 cancel/abort 契约
  backend/test_ws_lifecycle.py     # v0.9.49.2 WS 断开收尾
  backend/test_truncation.py       # FI-02 上限截断如实标注
  backend/test_expert_state.py     # 专家状态采集纯函数
)
if [ -n "$PY" ]; then
  for s in "${PY_SCRIPTS[@]}"; do
    echo "===== $s ====="
    if "$PY" "$s"; then
      echo "  ✓ $s"
    else
      echo "  ✗ $s FAILED"
      fail=$((fail+1))
    fi
  done
fi

echo ""
if [ "$fail" -eq 0 ]; then echo "全部回归通过 ✅"; else echo "有 $fail 项失败 ❌"; fi
exit $fail
