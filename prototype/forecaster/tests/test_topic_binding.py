"""
v0.9.24 回归：本地兜底路牌必须锚定真实业务词，不得退回空洞通用词。

背景：v0.9.22 把「下一方向」牌全切到 fast=1（force_local），于是 100% 走
_local_forecast。旧版 intent_map 是一套硬编码万金油动作（写代码 / 查文档 /
对比分析 / 总结），主题词只在「没匹配到任何关键词」的兜底分支使用，且正则
抽不到「电力市场交易」这类裸主题时退化成「你关注的这件事」占位符。
本测试锁死该回归点。

不依赖 pytest：直接 `python test_topic_binding.py` 运行。
Run: cd forecaster/tests && python test_topic_binding.py   （解释器可用 COCKPIT_PYTHON 覆盖）
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core import SpeculativeForecaster
from llm_forecaster import LLMCandidateSampler

FAILS = []


def check(cond, label, extra=""):
    if cond:
        print("  PASS", label)
    else:
        print("  FAIL", label, (" -> " + str(extra)) if extra else "")
        FAILS.append(label)


# 旧版空洞词黑名单：这些词与用户会话主题无关，本地兜底不得再出现
GENERIC = ("写代码", "查文档", "给示例", "查资料", "对比分析", "查数据",
           "总结", "先问清楚", "分步推理", "直接回答", "针对「", "围绕「",
           "你关注的这件事", "聊起来", "看能力", "识别图片", "直接翻译")

CASES = [
    "电力市场交易",
    "帮我分析风电场超短期功率预测的误差来源",
    "白洋淀机载高光谱数据怎么做碳汇反演",
    "ERA5 数据聚合到 1km 产生网格残影，怎么在输入端解决",
    "帮我写一个 Python 爬虫采集 S2 影像",
]


def main():
    print("\n[A] 业务短语抽取：元数据尾巴 / 标记不污染主题")
    enriched = (
        "电力市场交易 [prev] 电力市场由中长期交易与现货市场构成，主体为发电侧与用户侧，"
        "价格由供需与输电阻塞共同决定。。（旅程已走过：检索电力市场交易 → 对照电力市场交易；"
        "刚完成：对照电力市场交易（列维度、逐项对照、标差异）） "
        "—— 已经沿这条路走了一段，结合用户本来的问题，下一步还可能做什么？"
    )
    ph = LLMCandidateSampler._extract_business_phrases(enriched)
    check("电力市场交易" in ph, "原问题主题被抽出", ph)
    check("中长期交易" in ph, "「中长期交易」不被削成「长期交易」", ph)
    check("现货市场" in ph, "真实产出里的新概念能进候选", ph)
    check("用户侧" in ph, "「用户侧」的「用」不被当介词剥掉", ph)
    check(not any("prev" in p.lower() for p in ph), "[prev] 标记不进短语", ph)
    check(not any("旅程" in p or "下一步" in p for p in ph),
          "前端元数据尾巴不进短语", ph)
    check(not any(p in ("主体", "户侧", "电力市场由", "怎么在输入端解决") for p in ph),
          "疑问/连接残片被过滤", ph)

    print("\n[B] 长句与英文缩写不再丢主题")
    check("白洋淀机载高光谱数据" in LLMCandidateSampler._extract_business_phrases(
        "白洋淀机载高光谱数据怎么做碳汇反演"), "长业务对象整体保留（旧版丢弃）")
    era = LLMCandidateSampler._extract_business_phrases(
        "ERA5 数据聚合到 1km 产生网格残影，怎么在输入端解决")
    check("ERA5" in era, "英文缩写 ERA5 保留", era)
    check("km" not in era, "单位 km 不混进业务短语", era)

    print("\n[C] 每个候选都锚定真实业务词，且无空洞词 / 占位符")
    for c in CASES:
        phrases = LLMCandidateSampler._extract_business_phrases(c)
        out = LLMCandidateSampler._local_forecast(c, 5)
        labels = [d["label"] for d in out]
        check(len(out) >= 3, f"候选数 ≥3：{c[:14]}", labels)
        check(all(any(p in d["label"] for p in phrases) for d in out),
              f"每个 label 含真实业务短语：{c[:14]}", labels)
        check(not any(g in " ".join(labels) for g in GENERIC),
              f"不含万金油动作/占位符：{c[:14]}", labels)
        check(all(d.get("topic_bound") for d in out),
              f"topic_bound 全为 True：{c[:14]}", out)
        check(all(d.get("anchor") in phrases for d in out),
              f"anchor 均来自抽出短语：{c[:14]}", [d.get("anchor") for d in out])
        check(all(d["label"].startswith(("检索", "拆解", "对照", "核算", "落地", "汇总"))
                  for d in out), f"label 为动作+业务对象：{c[:14]}", labels)

    print("\n[D] 抽不到主题时如实说明，不编造")
    out = LLMCandidateSampler._local_forecast("???", 5)
    labels = [d["label"] for d in out]
    check(len(out) >= 1, "无业务词时仍给出可用牌", labels)
    check(all(not d.get("topic_bound") for d in out), "topic_bound 全为 False", out)
    check("你关注的这件事" not in " ".join(labels + [d["sub"] for d in out]),
          "不含「你关注的这件事」占位符", labels)
    check(not any(g in " ".join(labels) for g in ("写代码", "查资料", "总结")),
          "不铺万金油动作", labels)

    print("\n[E] 意图适配仍生效（只重排方向，不再决定空洞模板）")
    build = [d["label"] for d in LLMCandidateSampler._local_forecast(
        "帮我写一个 Python 爬虫采集 S2 影像", 5)]
    search = [d["label"] for d in LLMCandidateSampler._local_forecast(
        "帮我查文献资料，检索相关论文", 5)]
    compare = [d["label"] for d in LLMCandidateSampler._local_forecast(
        "对比评估两个模型的误差区别", 5)]
    check(build and build[0].startswith("落地"), "造东西类：落地优先", build)
    check(search and search[0].startswith("检索"), "检索类：检索优先", search)
    check(compare and compare[0].startswith("对照"), "分析类：对照优先", compare)

    print("\n[F] 完整推演链路：source / 路形 / 候选数不退化")
    for c in CASES[:3]:
        s = LLMCandidateSampler()
        s.force_local = True
        r = SpeculativeForecaster(sampler=s).forecast(c, 5)
        check(s.last_source == "local", f"source=local 如实标注：{c[:12]}", s.last_source)
        check(len(r.candidates) >= 4, f"候选 ≥4（未被同义簇折叠）：{c[:12]}",
              len(r.candidates))
        check(0 < r.divergence < 1, f"分歧度正常：{c[:12]}", r.divergence)
        check(all(x.label for x in r.candidates), f"label 非空：{c[:12]}")

    print("\n[G] 简单问候仍是 direct 直道")
    g = LLMCandidateSampler._local_forecast("你好", 5)
    check(len(g) == 1 and g[0].get("_type") == "direct", "问候不铺岔路", g)

    print("\n[H] 只有元数据、没有用户原话时不把系统话术当主题")
    meta_only = ("（旅程已走过：检索电力市场交易 → 对照电力市场交易） "
                 "—— 已经沿这条路走了一段，结合用户本来的问题，下一步还可能做什么？")
    mph = LLMCandidateSampler._extract_business_phrases(meta_only)
    check(mph == [], "元数据尾巴抽不出业务短语", mph)
    mout = LLMCandidateSampler._local_forecast(meta_only, 5)
    check(all(not d.get("topic_bound") for d in mout),
          "落到诚实分支，不假装理解了业务", [d["label"] for d in mout])

    print("\n[I] FI-04 长指令句：数量词残片 / 动宾半句 / 指令壳词不上牌")
    long_cases = [
        "写一段150字左右的产品说明：包含实时天气、逐小时预报、生活指数三个模块，说明各自展示什么信息，用中文",
        "为一个天气应用首页写一段150字左右的产品说明，介绍页面包含哪些模块、如何显示实时天气和未来预报，用中文回答",
        "帮我做一个天气应用首页：先出可运行页面，再补数据接入",
    ]
    FRAG = ("字左右", "一段", "些模块", "用中文", "用英文", "左右")
    for c in long_cases:
        ph = LLMCandidateSampler._extract_business_phrases(c)
        check(not any(f in p for p in ph for f in FRAG),
              f"短语无数量词/壳词残片：{c[:14]}", ph)
        check(not any("生活指" in p and "生活指数" not in p for p in ph),
              f"「指数」不被计数尾剥成「生活指」：{c[:14]}", ph)
        labels = [d["label"] for d in LLMCandidateSampler._local_forecast(c, 5)]
        check(not any(f in l for l in labels for f in FRAG),
              f"路牌无碎片词：{c[:14]}", labels)
    # 业务对象保留断言（质量门不能把真主题也滤掉）
    ph1 = LLMCandidateSampler._extract_business_phrases(long_cases[0])
    check("实时天气" in ph1 and "逐小时预报" in ph1 and "生活指数" in ph1,
          "三个真实模块名全部保留", ph1)
    ph2 = LLMCandidateSampler._extract_business_phrases(long_cases[1])
    check("天气应用首页" in ph2, "计数头剥离后业务对象保留", ph2)
    # 既有边界不回归
    check(LLMCandidateSampler._extract_business_phrases("中长期交易与用户侧结算规则")
          == ["中长期交易", "用户侧结算规则"], "「中长期/用户侧」边界不回归")

    print("\n" + "=" * 56)
    if FAILS:
        print(f"v0.9.24 主题绑定回归：{len(FAILS)} 项失败")
        for f in FAILS:
            print("   -", f)
        sys.exit(1)
    print("v0.9.24 主题绑定回归：全部通过")


if __name__ == "__main__":
    main()
