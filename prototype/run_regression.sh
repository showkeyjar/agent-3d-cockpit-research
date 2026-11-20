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
echo "== 后端 Python 单测 =="
if command -v pytest >/dev/null 2>&1; then
  pytest -q forecaster/tests/ backend/test_cancel_backend.py || fail=$((fail+1))
else
  echo "（未装 pytest，跳过；进入 prototype 目录用 python -m pytest forecaster/tests/ backend/ 手动跑）"
fi

echo ""
if [ "$fail" -eq 0 ]; then echo "全部回归通过 ✅"; else echo "有 $fail 项失败 ❌"; fi
exit $fail
