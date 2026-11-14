# 回归测试清单 · prototype/tests

> 原型根目录平铺了大量 `test_*.js`。本文件把它们分成**常驻回归**与**临时诊断**两类，
> 避免「诊断脚本混在回归里、分不清哪些该常驻」的工程化薄弱点（专家评审第 8 条）。

## 常驻回归（每次改动必跑，CI 准入）

运行前确保后端在 8770（`uvicorn server:app --port 8770`），然后用根目录
`run_regression.sh`（自动解析本机 Chromium）或逐个 `node xxx.js`。

| 脚本 | 覆盖 | 不变量 |
|------|------|--------|
| `verify_opaque.js` | A 组 `?mode=opaque` 操纵完整性（呈现层隐藏 + 真实执行未动） | 实验单归因 |
| `test_honesty.js` | 诚实性护栏：路牌不回退空洞词、`source` 如实标 `local` | P1 |
| `test_practical.js` | v0.9.23 实用化三件套（HUD / 里程碑 / 决策链） | P1–P4 |
| `test_keyboard.js` | 键盘等价视图 + 3D 机位公式 | `camOffRail≈0` |
| `test_scenery.js` | 语义风景可点回看（P3 可核对 / P4 可感知） | 机位不动 |
| `test_compare.js` | P2 候选并排对比 + 自定义方向 | 不碰 3D |
| `test_context_pull.js` | v0.9.25 风景→上下文闭环 | 不碰中断态 |
| `test_cancel.js` | 中断态（第三态）全链路 | 不回退 |
| `test_timeline.js` | 多轮时间线 + 分叉重走 + 导出 | 只读 |
| `test_sign_topics.js` | 路牌业务词绑定（fast 通道） | P1 |
| `forecaster/tests/test_topic_binding.py` | 业务短语抽取 / 诚实分支 | P1 |
| `forecaster/test_e2e_diversify.py` | 采样池→分桶→5 候选语义分散 | — |
| `backend/test_cancel_backend.py` | 取消协议后端契约 | — |

**后端 Python 单测**：`pytest forecaster/tests/ backend/test_cancel_backend.py`

## 临时 / 诊断脚本（不参与准入，按需运行）

以下脚本是开发中排障用，**不在常驻回归内**，重命名时建议加 `_diag`/`_tmp` 前缀以便区分：

- `test_camera_diag.js`、`test_click.js`、`test_click_det.js` — 相机/点击探针
- `test_clarify.js`、`test_clarify_verify.js` — 澄清分支探针
- `test_flaky*.js`、`test_race*.js`、`test_repro_*.js` — 复现特定 flaky/竞态

> 约定：新加的常驻回归放进上面的表格并加进 `run_regression.sh`；一次性排障脚本
> 用 `_diag`/`_tmp` 前缀，避免污染常驻套件。

## 浏览器解析

所有 `test_*.js` 通过 `chrome_helper.js` 解析 Chromium 路径：
1. 环境变量 `PLAYWRIGHT_CHROMIUM` 显式指定；
2. 否则自动探测 `$LOCALAPPDATA/ms-playwright/chromium-<ver>/chrome-win64/chrome.exe`；
3. 仍找不到则交回 `playwright-core` 自带浏览器。

异机/CI 只需 `npm i playwright-core` + 设 `PLAYWRIGHT_CHROMIUM` 即可，无需硬编码本机路径。
