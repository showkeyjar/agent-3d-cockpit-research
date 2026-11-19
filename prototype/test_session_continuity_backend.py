# -*- coding: utf-8 -*-
"""v0.9.37 会话脉络连续性 —— 后端门控回归。

核心断言：会话摘要（历史背景）随新问题一起下发，但任务类型门控必须只看本轮原话。
否则「上一轮分析过 ERA5 数据，这一轮起草一份报告」会被摘要里的数据词污染成 analysis
→ 误触发 clarify（上下文污染在「会话连续性」这条新路径上的复现）。

纯逻辑单测：直接 import task_tracker，不依赖运行中的服务。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "backend"))
import task_tracker as tt

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))

B = tt.SESSION_DIGEST_BEGIN
E = tt.SESSION_DIGEST_END

# 1) 无摘要：行为与旧版完全一致（向后兼容）
check("无摘要-起草", tt.classify_task_kind("帮我写一份项目报告") == "compose",
      tt.classify_task_kind("帮我写一份项目报告"))
check("无摘要-分析", tt.classify_task_kind("根据观测数据分析趋势") == "analysis",
      tt.classify_task_kind("根据观测数据分析趋势"))
check("无摘要-通用", tt.classify_task_kind("你好") == "general")

# 2) 关键铁证：起草任务 + 摘要里全是历史数据词 → 仍必须判 compose
digest = (f"\n\n{B}\n· 第2轮沿「数据清洗」：用 ERA5 观测站数据做了回归拟合（目标达成）\n"
          f"· 第3轮沿「趋势预测」：Sentinel 影像时间序列分析（部分达成）\n{E}")
ctx = "帮我写一份森林火险报告" + digest
check("起草+数据词摘要-门控仍compose(不被污染)",
      tt.classify_task_kind(ctx) == "compose", tt.classify_task_kind(ctx))

# 3) 分析任务 + 摘要 → 仍判 analysis（本轮真的是数据依赖）
ctx2 = "根据 ERA5 数据分析作风预测" + digest
check("分析+摘要-门控仍analysis",
      tt.classify_task_kind(ctx2) == "analysis", tt.classify_task_kind(ctx2))

# 4) strip_session_digest 精确性：只剥标记段，保留本轮原话（含标记后若有语句）
s = "本轮原话" + B + "\n历史一堆数据 ERA5\n" + E + "\n补充一句"
stripped = tt.strip_session_digest(s)
check("剥离-保留本轮原话", stripped.startswith("本轮原话"), stripped)
check("剥离-不含历史数据词", "ERA5" not in stripped, stripped)
check("剥离-保留标记后续句", "补充一句" in stripped, stripped)

# 5) 未闭合标记：保守当普通文本，不误删本轮真实诉求（复核发现曾整段丢弃）
ctx3 = "写一份通知\n" + B + "\nERA5 数据分析历史……"
s3 = tt.strip_session_digest(ctx3)
check("未闭合标记-保守保留原文", s3 == ctx3.strip(), s3)
check("未闭合标记-分析诉求仍在(不误删)",
      tt.classify_task_kind("根据数据回归 " + B + "\n历史") == "analysis",
      tt.classify_task_kind("根据数据回归 " + B + "\n历史"))

# 5b) 标记出现在任务中间且闭合：只剥标记段，前后本轮原话都保留
ctx4 = "写一份报告 " + B + "\n历史 ERA5\n" + E + " 基于 ERA5 数据回归"
s4 = tt.strip_session_digest(ctx4)
check("中间闭合标记-保留前段", "写一份报告" in s4, s4)
check("中间闭合标记-保留后段诉求", "基于 ERA5 数据回归" in s4, s4)
check("中间闭合标记-剥掉历史", "历史 ERA5" not in s4, s4)
check("中间闭合标记-门控判analysis", tt.classify_task_kind(ctx4) == "analysis",
      tt.classify_task_kind(ctx4))

# 6) prompt 拆分：execute prompt 用自然语言呈现历史，不透传内部标记（复核问题6）
full = "帮我写一份火险报告" + "\n\n" + B + "\n· 第2轮：ERA5 火险分析（目标达成）\n" + E
clean, body = tt.split_session_digest_for_prompt(full)
check("prompt拆分-本轮问题干净", clean == "帮我写一份火险报告", clean)
check("prompt拆分-无内部标记", "<<<" not in clean and "会话摘要" not in clean, clean)
check("prompt拆分-历史正文保留", "ERA5 火险分析" in body, body)
check("prompt拆分-无摘要时不拆", tt.split_session_digest_for_prompt("普通问题") == ("普通问题", ""),
      tt.split_session_digest_for_prompt("普通问题"))

# 7) 标记常量稳定（前后端共用，前端测试会对齐）
check("标记常量-begin", "会话摘要" in B, B)
check("标记常量-end", "END" in E, E)

ok = sum(1 for _, c, _ in results if c)
for name, cond, detail in results:
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f"  -> {detail}" if not cond else ""))
print(f"\n{ok}/{len(results)} passed")
sys.exit(0 if ok == len(results) else 1)
