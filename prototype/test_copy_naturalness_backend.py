"""v0.9.39 路牌文案去机械化 · 后端纯函数测试

验证 naturalize_copy()：
  ① 套话 sub/rationale（贴合主题/更准确/直接相关…）被换成带真实对象的自然句
  ② 裸动词 steps（检索,整理,校验）补成带对象的动作
  ③ 模型给出的好文案一字不动（不过度改写）
  ④ 按索引轮换模板：四条路替换后仍是四种说法，不出现新的整齐划一
  ⑤ 业务对象只取真实来源（topic/anchor/用户短语/label），不编造

不依赖网络与模型，确定性可复算。
"""
import sys
sys.path.insert(0, "forecaster")
from llm_forecaster import naturalize_copy, _is_cliche  # noqa: E402

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))


# ── ① 套话识别 ──
check('识别「贴合主题」为套话', _is_cliche('贴合主题'))
check('识别「更准确」为套话', _is_cliche('更准确'))
check('识别「直接相关」为套话', _is_cliche('直接相关'))
check('识别空串为套话', _is_cliche(''))
check('自然句不误判为套话', not _is_cliche('风电功率对天气敏感，得看是不是环境触发的'))

# ── ②③④ 主场景：四条全是套话 + 裸动词 ──
cands = [
    {"label": "查实模型版本差异", "sub": "贴合主题", "rationale": "更准确",
     "steps": ["检索", "比对", "整理"], "topic": "模型版本"},
    {"label": "对比极端天气表现", "sub": "结论要有依据", "rationale": "直接相关",
     "steps": ["清洗", "验证"], "anchor": "极端天气"},
    {"label": "追溯上游数据质量", "sub": "更稳定", "rationale": "贴合主题",
     "steps": ["提取", "归因"], "topic": "SCADA数据"},
    {"label": "分析测风设备位置", "sub": "紧扣主题", "rationale": "更准确",
     "steps": ["模拟", "量化"], "topic": "测风塔"},
]
out = naturalize_copy([dict(c) for c in cands], ["模型版本", "极端天气", "SCADA数据", "测风塔"])

subs = [c["sub"] for c in out]
rats = [c["rationale"] for c in out]
all_text = " ".join(subs + rats)
check('套话 sub 全部被替换', all(not _is_cliche(s) for s in subs), subs)
check('套话 rationale 全部被替换', all(not _is_cliche(r) for r in rats), rats)
check('替换后的 sub 各不相同', len(set(subs)) == 4, subs)
check('替换后的 rationale 各不相同', len(set(rats)) == 4, rats)
check('替换文案带真实业务对象',
      any(w in all_text for w in ["模型版本", "极端天气", "SCADA数据", "测风塔"]), all_text)

# 裸动词补对象
steps0 = out[0]["steps"]
check('裸动词 steps 补成带对象动作',
      steps0[0] != "检索" and "模型版本" in steps0[0], steps0)
check('多个裸动词步骤补出不同对象',
      len(set(s for s in steps0 if s)) >= 2, steps0)
check('后续候选 steps 也被补全',
      all(any(s and s not in ("清洗", "验证", "提取", "归因", "模拟", "量化") for s in c["steps"])
          for c in out[1:]), [c["steps"] for c in out[1:]])

# ── ③ 好文案原样保留 ──
good = [
    {"label": "追溯数据质量", "sub": "原始测风数据有缺失或漂移，预测输入就歪了",
     "rationale": "省事，但误差源头可能被掩盖", "steps": ["检查SCADA数据缺失率"], "topic": "SCADA"},
]
gout = naturalize_copy([dict(good[0])], ["SCADA"])
check('好文案 sub 一字不动', gout[0]["sub"] == good[0]["sub"], gout[0]["sub"])
check('好文案 rationale 一字不动', gout[0]["rationale"] == good[0]["rationale"], gout[0]["rationale"])
check('已带对象的 step 不改写', gout[0]["steps"] == good[0]["steps"], gout[0]["steps"])

# ── ⑤ 无真实对象时退回 label，不编造 ──
bare = [{"label": "查实预测模型差异", "sub": "贴合主题", "rationale": "更准确", "steps": ["检索"]}]
bout = naturalize_copy([dict(bare[0])], [])
check('无 topic/短语时退回 label 去动作词',
      "预测模型差异" in bout[0]["sub"], bout[0]["sub"])
check('无对象也不产生占位符', "undefined" not in bout[0]["sub"] and "{}" not in bout[0]["sub"], bout[0]["sub"])

passed = sum(1 for _, ok, _ in results if ok)
for name, ok, detail in results:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -> {detail}" if detail and not ok else ""))
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
