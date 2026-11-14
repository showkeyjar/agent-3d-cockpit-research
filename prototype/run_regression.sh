#!/usr/bin/env bash
# run_regression.sh — prototype 常驻回归一键跑（顺序执行，便于单槽串行）
# 用法： bash run_regression.sh   （在 prototype/ 目录下）
set -u
cd "$(dirname "$0")"

echo "== 后端健康检查 =="
curl -s -o /dev/null -w "8770 health=%{http_code}\n" http://127.0.0.1:8770/api/health || {
  echo "后端未启动，请先: cd backend && uvicorn server:app --port 8770"; exit 1; }

JS_TESTS=(
  verify_opaque.js
  test_honesty.js
  test_practical.js
  test_keyboard.js
  test_scenery.js
  test_compare.js
  test_context_pull.js
  test_cancel.js
  test_timeline.js
  test_sign_topics.js
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
  echo "（未装 pytest，跳过；用 /d/tools/Python312/python -m pytest 手动跑）"
fi

echo ""
if [ "$fail" -eq 0 ]; then echo "全部回归通过 ✅"; else echo "有 $fail 项失败 ❌"; fi
exit $fail
