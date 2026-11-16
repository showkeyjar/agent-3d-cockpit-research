# agent-3d-cockpit · 实证原型

> 智能体 3D 驾驶舱原型：把人与模型的多轮探索变成一段可共同导航的旅程。
> 研究背书见仓库根目录 `README.md` 与 `docs/`。

## 端口约定（重要）

**统一端口：8770。** 后端 `server.py`、看门狗 `backend-watchdog.py`、实验工具 `m-instrument.html`、所有 `test_*.js` 与文档都默认 8770。

- 启动：`uvicorn server:app --port 8770`（在 `prototype/backend/` 目录下）
- 或直接 `python server.py`（读取 `PORT` 环境变量，默认 8770）
- 生产/长驻：用 `backend-watchdog.py`（每 30s 探活，宕则 detached 拉起）

⚠️ 旧文档里出现的 `8765`、`8899` 均已废弃，以本文与 `server.py` 为准。

## 依赖

```bash
pip install -r requirements.txt      # 后端 + 推理器（FastAPI/uvicorn/aiohttp/numpy/pydantic/websockets/pytest）

# 前端回归测试（test_*.js）需要 Node + playwright-core（见 package.json）：
npm install                          # 装 playwright-core，chrome_helper.js 自动定位本机 Chromium
# 异机/CI 可用环境变量指定浏览器：
#   PLAYWRIGHT_CHROMIUM=/path/to/chrome.exe node test_practical.js
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_BASE_URL` | `http://localhost:8083/v1` | 本地 llama-server 唯一主力模型 OpenAI 兼容端点 |
| `LLM_MODEL` | `local-primary` | 与 llama-server 启动 `-a` 注册的别名一致（2026-11-16 起本机仅此一个模型） |
| `LLM_EMBEDDING_MODEL` | 空（用哈希） | 配置后走真实 embedding API（语义档 eps 0.38）；留空用 hashed-TF（eps 0.60，诚实近似）。须与 `LLM_MODEL` 不同才生效 |
| `PORT` | `8770` | 后端监听端口 |
| `COCKPIT_PYTHON` | 当前解释器 | 看门狗用来拉起 uvicorn 的 python 路径 |
| `COCKPIT_CORS_ORIGINS` | `localhost/127.0.0.1 :8770,:8899` | CORS 白名单（逗号分隔，**不要用 `*`**） |
| `PLAYWRIGHT_CHROMIUM` | 自动探测 | 测试用 Chromium 路径覆盖 |

## Embedding 决策（学科1 向量风景，已落地为可插拔）

向量风景的分桶判据 `eps` 依赖向量是「语义」还是「词面」，该决策已从「待定注释」变为**环境变量可切换**：

- **默认（诚实近似）**：不配 `LLM_EMBEDDING_MODEL` → 本地 hashed-TF（单字 + 二元组 + 英文词哈希）编码，
  分桶 `eps = 0.60`（实测词面同义簇 0.52–0.57、方向间最小 0.68，0.60 落在间隙）。此时「语义相近→靠近」
  本质是**词面相近**，代码与凭据如实标注，不冒充语义向量。
- **语义档**：配 `LLM_EMBEDDING_MODEL`（且不同于 `LLM_MODEL`）→ 调真实 embedding API，分桶 `eps` 自动切 **0.38**。

实现：`forecaster/core.py` 定义 `DIVERSIFY_EPS_HASH=0.60 / DIVERSIFY_EPS_SEMANTIC=0.38`；`LLMForecaster`
与 `server._build_forecaster` 均按 `sampler.uses_semantic_embedding()` 自动选档；`/api/health` 的
`embed_provider`（`semantic`/`hash`）与 `embedding_model` 字段如实上报当前档位。切换只改环境变量，不动代码。

## 运行

```bash
cd prototype/backend
uvicorn server:app --port 8770
# 浏览器打开 http://127.0.0.1:8770/
```

## 实验操纵（M1/M2）

`?mode=opaque` 挂在 URL 上即启用 A 组「执行不透明」：仅隐藏 P2/P3/P4 呈现层，
**真实执行与「思考中…」指示保留**。B 组（无此参数）看到完整凭据。
组间差异单归因于「透明度」，由 `verify_opaque.js` 锁死。

## 回归测试

常驻回归套件（见 `tests/README.md`）：

```bash
node verify_opaque.js      # A 组操纵完整性
node test_honesty.js       # 诚实性护栏（路牌不回退空洞词、source 如实）
node test_practical.js     # v0.9.23 实用化三件套
node test_keyboard.js      # 键盘等价视图 + 3D 不变量
node test_scenery.js       # 语义风景可点
node test_compare.js       # P2 候选对比 + 自定义方向
node test_context_pull.js  # v0.9.25 风景→上下文闭环
node test_cancel.js        # 中断态
node test_timeline.js      # 多轮时间线
```

后端（Python）单测：`pytest forecaster/tests/ backend/test_cancel_backend.py`

## 目录

```
prototype/
├── index.html              # 前端单体（含测试钩子区 / opaque 操纵区，见代码横幅注释）
├── backend/                # FastAPI 服务 + 记忆 + 任务追踪 + 看门狗
├── forecaster/             # 前瞻推演采样器（LLM / 本地兜底）、分歧度、净化规则
├── requirements.txt
├── chrome_helper.js        # 测试用 Chromium 路径解析（去硬编码）
├── test_*.js               # 前端回归
└── verify_opaque.js        # A 组操纵完整性回归
```
