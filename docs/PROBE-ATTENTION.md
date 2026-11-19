# Attention 图信号探针：注意力权重能否成为下一个真实指纹

> 状态：**查证 + 隔离实测完成（2026-11-19），结论「负面——不编码进 3D」**。本文回答：
> 方向③（专家指纹）收官后，用户选的下一探针——能否用 transformer 的 attention 权重分布
> 做类似 MoE 路由那样的真实 prompt 指纹，进而编码进 cockpit？
> 数据分级：**[实测]** 本机隔离小模型真实 attention 张量采集 + 判决实验；
> **[查证]** 实际读取 llama.cpp 源码；**[推断]** 对主线的外推；**[未验证]** 大模型/其它模型族。

## 0. 一句话结论

**Attention 聚合分布不是 prompt 指纹，且换了聚合量也不成立。** 距离直方图：同 prompt r=1.000、异 prompt mean=0.985；换三类"内容相关"先验的统计量（熵/participation ratio/max prob）：异 prompt mean 反而更高（0.990~0.998）。四类量全部无区分力——attention 聚合分布编码的是模型结构属性，不是输入语义。**按 P4 纪律（可感知模式必须有判别力证据），不编码进 3D**——贴上去就是新剧场。（§4 距离直方图，§4.5 换聚合量复测。）

附带两个查证结论：**llama.cpp 无官方 attention 输出 API**；**主力当前 `-fa on`（flash attention）下注意力矩阵物理上不落地、拿不到**，只有 `-fa off` 才能从 `kq_soft_max-<il>` 张量读出。

## 1. 为什么先做查证，而不是直接照搬专家指纹的路径

方向③的 MoE 专家指纹成功，关键在于路由是**内容依赖**的（同样的话激活同样专家，不同任务激活不同专家）。attention 是否也有这个性质，不能假设——两个根本差异：

1. **可观测性**：专家路由有现成的 `--expert-stats` + `GET /experts`（我们自己打的补丁）；attention 在 llama.cpp 里没有对应端点，且主力开着 flash attention。
2. **位置依赖**：attention 权重是 query-key 逐对的值，天然随 token 位置变化；"逐 token 是噪声、聚合是信号"在专家侧成立，在 attention 侧未必——聚合掉位置后可能也聚合掉了内容信息。

所以先查证能采什么，再用判决实验验区分力，最后才谈编码。

## 2. 查证：llama.cpp 能采到什么信号 [查证]

实际读 `D:/tools/llama.cpp-src` 源码（版本含 Vulkan flash-attn，与 8083 同源）：

- **无官方 API**：`include/llama.h` 只有 `attention_type`/`flash_attn_type` 配置字段（380-381 行），无任何 dump/输出函数；`tools/`、`common/` 下 grep `attention_output`/`dump_attn`/`llama_get_attn`/`attn_logits` 均无匹配（`src/` 命中全是权重名 `blk.%d.attn_output`）。唯一可挂接点是通用回调 `cb_eval`（`llama.h:393`）。
- **`-fa on` 拿不到矩阵**：`src/llama-graph.cpp:2883` 判 `use_flash_attn`，`2900` 调 `ggml_flash_attn_ext` 直接产出 O，kernel 内部 online softmax，P 矩阵不是独立张量。**主力 8083 当前正是 `-fa on`**。
- **`-fa off` 可读**：非 flash 路径 `2928` kq logits、`2962` `ggml_soft_max_ext`、`2964` `cb(kq,"kq_soft_max",il)`，经 `llama-context.cpp:2845` 命名为 `kq_soft_max-<il>`，可用 `ggml_backend_tensor_get` 读出。

**可观测量的选择**：完整 attention 矩阵是 `[n_ctx, n_ctx, n_head]`，随位置变、维度爆炸。照专家侧"聚合出稳定量"的思路，选**注意力距离直方图**——对每个 (query, head) 行，把注意力概率按 `相对距离 = 行内最末有效 key − key` 分到 9 个 log 桶（0/1/2/3/4-7/8-15/16-31/32-63/64+），每层一个 9 维分布。这是位置相对无关的量，理论上可跨 prompt 比较。

## 3. 补丁与隔离采集 [实测]

照已有 expert-stats 补丁模式，写了 attention 补丁（**完整 diff 存 `D:/tools/attention.patch`，475 行，可复现**）：

- `common/common.h`/`arg.cpp`：加 `endpoint_attention` 标志 + `--attention-stats` 参数；
- `tools/server/server-context.cpp`：加 `attention_stats_state`（每层 9 维累计直方图）+ `attention_stats_cb`（cb_eval 匹配 `kq_soft_max-`）+ `stats_eval_cb` wrapper（与 expert 回调分流，互不干扰）；
- `tools/server/server-context.h`/`server.cpp`：加 `GET /attention?total=1` 端点，返回每层归一化直方图 + 拼接的 252 维 fingerprint（28 层 × 9 桶）+ 元数据。

编译进独立二进制 `build-server3/bin/llama-server.exe`（**全程未碰 8083 主力用的 `build-server/bin/llama-server-stats.exe`，8083 health 始终 200**）。

**踩坑与修正（留痕，勿重蹈）**：
1. 张量维度：实际 `ne=[256, 2, 16]`/`nb=[4,1024,2048]`——`ne[0]` 是 **KV 容量 256（含 padding）不是实际 token 数**，`ne[1]`=query，`ne[2]`=head。最初按 `ne[0]` 当实际长度算距离，结果全落 bin8（假信号）。改为按"行内最末有效 key（prob>1e-6）"作相对距离基准后正常。
2. json 构造：`common_json` 不接受裸 `{...}` 初始化 list，必须 `json::array({...})`。
3. wrapper 大括号：文本替换误删 `if` 的 `{}`，导致编译失败——已在 patch 里修正。

修正后分布合理：L0 `[0.514,0.179,0.059,...]` 偏局部，L3/L20 `[0.11,...,0.32]` 偏中距——符合 transformer 已知规律，确认采到的是真信号。

## 4. 判决实验：它不是 prompt 指纹 [实测]

方法（`D:/tools/verdict_attention.py`，数据 `D:/tools/verdict_attention.json`）：6 个 prompt，每个用独立服务进程（重启清空统计），temperature=0（prefill 确定性），`max_tokens=24` 固定，跑完读 252 维 fingerprint 算余弦。A1/A2 是同一个 prompt（测稳定性），B/C/D/E 是四个截然不同的任务（写短文 / ERA5 风电 / 卡尔曼同化 / 竹林反演）。

| 对比 | 相关系数 |
|---|---|
| 同 prompt（A1 vs A2） | **1.0000** |
| 异 prompt 两两（14 对） | 0.954 ~ 0.999，**mean 0.985** |

**判读**：
- 同 prompt r=1.000 → 测量完全确定，不是噪声（与专家侧结论一致）。
- 异 prompt r≈0.985 → **几乎没有区分力**。数值直观看，写秋天短文 vs 卡尔曼方程：L0 `[0.514,...]` vs `[0.508,...]`、L3 `[0.107,...]` vs `[0.090,...]`——形态几乎一致；仅远端 bin7 有小差（0.081 vs 0.17），那是 prompt 长度/生成 token 数不同所致，不是语义。

**根因**：距离直方图把"关注哪个 token"的内容信息聚合掉了，只剩"看多远"——这是模型结构属性（每层 head 的功能特化），对任何输入都差不多。专家路由是内容依赖的，所以能当指纹；注意力距离分布是结构依赖的，所以不能。

## 4.5 换三类"内容相关"聚合量复测：更彻底的负面 [实测]

用户追问"换 attention 聚合量再探"——距离直方图可能只是选错了量。于是给补丁增加三个**先验上更可能内容依赖**的注意力统计量，按每层每 head 计算（28×16=448 个位置）：

- **归一化熵** `H/log(n)`：注意力是集中还是分散；
- **participation ratio** `(Σp)²/Σp²`：有效参与的 token 数；
- **max prob**：峰值注意力。

三项 × 448 = 1344 维 fingerprint。用同一套 6 prompt 判决框架重跑（`D:/tools/verdict_attention_stats.py` → `verdict_attention_stats.json`）：

| 聚合量 | 维度 | 同 prompt | 异 prompt 两两 mean | 判定 |
|---|---|---|---|---|
| 距离直方图（旧） | 252 | 1.0000 | 0.9849 | 负面 |
| 熵+PR+max（合并） | 1344 | 1.0000 | 0.9902 | 负面 |
| 仅归一化熵 | 448 | 1.0000 | **0.9957** | 负面 |
| 仅 participation ratio | 448 | 1.0000 | 0.9898 | 负面 |
| 仅 max prob | 448 | 1.0000 | **0.9981** | 负面 |

**结论更强，不是更弱**：三类"内容相关"先验的量，异 prompt 相关比距离直方图**更高**（0.99~0.998 vs 0.985）。即换了聚合量不但没救回区分力，反而更接近"任何 prompt 都一样的常数"。这说明问题不在选哪个统计量——**attention 的聚合分布整体就是模型结构属性**（每层每 head 的注意力形态由权重决定，输入只造成微小扰动），不像 MoE 路由那样被内容强驱动。至此"attention 做 prompt 指纹"的假设在四种聚合量上被系统否定，可以收口。

补丁增量存于 `D:/tools/add_attention_stats.py`；当前源码树已含熵统计版（距离统计保留作对照），expert-only 回滚点 `server-context.cpp.bak-dist-only`。

## 5. 与主线的关系：什么该写进论文/报告

- **[已验证] 负面结果本身有价值**：它排除了"attention 距离分布"这条看似合理的路，避免了几轮无效工程 + 把无判别力信号贴进 3D 的新剧场。这与项目反复强调的 P1（真实性）纪律一致。
- **[已验证] 与专家指纹互补性判断**：不能互补——专家指纹有判别力（异任务 max 0.079），attention 距离无判别力（异任务 mean 0.985），两者不在同一层级。
- **[推断] 为什么不继续试别的 attention 聚合**：完整 attention 矩阵 `[n_ctx,n_ctx,n_head]` 是位置敏感的，聚合掉位置就没内容、保留位置就没法跨 prompt 比较——这是结构性张力，不是调参能解决的。若要试，应换思路（如 attention 的熵/集中度、特定 head 的路由模式），但先验较低。
- **[未验证] 大模型/其它模型族**：本结论基于 dense 小模型 Qwen3-1.7B（20→28 层实测）；不排除某些模型/微调出现内容依赖的 attention 模式，但无证据支持为此投入。

## 6. P1–P4 定位与决策

| 维度 | 判断 |
|---|---|
| P1 真实性 | attention 张量是真采的、补丁是真编译的、判决是真跑的——但**真实≠可用** |
| P2 可核对 | 补丁/脚本/数据全部留痕可复现 |
| P3 可追溯 | 距离归因明确（结构属性，非内容） |
| P4 可感知 | **不成立**：无判别力 → 人无法从中读出"这次和上次有什么不同" |

**决策建议（供拍板）**：
1. **不编码进 3D**（推荐）：四类聚合量全部判决负面，贴上就是新剧场。把精力放回已完成的方向③（专家指纹，已收官）或其它真实信号。
2. ~~换一个 attention 聚合量再探（熵/集中度/head 路由）~~ **已执行并证伪（§4.5）**：熵/PR/max 三类全部异 prompt r≥0.99，比距离直方图更差。此路已收口，不建议再投入。
3. 转向"用已验证的真信号做点什么"：例如把专家指纹接进 M2 真人实验，看它是否提升主观 P1–P4 分——这才是从"信号可行"走向"被验证有效"的关键缺口。

## 7. 复现

```bash
# 补丁（在当前 expert-stats 基础上）
D:/tools/llama.cpp-src 已含改动；完整 diff = D:/tools/attention.patch
编译：powershell -ExecutionPolicy Bypass -File D:/tools/build-attention.ps1
# 隔离服务（8096，dense 小模型，-fa off）
D:/tools/Python312/python D:/tools/attn_probe_server.py
# 判决实验（6 prompt × 独立进程）
D:/tools/Python312/python D:/tools/verdict_attention.py          # 距离直方图
D:/tools/Python312/python D:/tools/verdict_attention_stats.py    # 熵/PR/max 四类对照
# 数据：verdict_attention.json / verdict_attention_stats.json
```

**资产**：`D:/tools/attention.patch`（基础补丁）、`add_attention_stats.py`（熵统计增量）、`attn_probe_server.py`（隔离服务）、`verdict_attention.py`/`verdict_attention_stats.py` + 两份 json（判决）、`apply_attention_patch.py`/`apply_attention_core.py`（补丁生成）、`build-attention.ps1`（编译）。补丁保留在源码树中但未合入 8083 主力二进制；回滚点 `*.bak-expert-only`（仅 expert）与 `server-context.cpp.bak-dist-only`（expert+距离，无熵）均在。
