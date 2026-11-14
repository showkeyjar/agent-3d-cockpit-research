"""
LLM Forecaster — 真实 LLM 前瞻推理适配器

通过 OpenAI 兼容接口（vLLM/Ollama/OpenAI 等）生成候选走向，
再由 core.py 的分歧度引擎判定路形。

Usage:
    from llm_forecaster import LLMForecaster
    fc = LLMForecaster(base_url="http://localhost:8080/v1", model="qwen3.6-35b")
    result = fc.forecast("帮我开发一个爬虫")
"""

from __future__ import annotations

import json
import os
from typing import List, Optional

import numpy as np

from core import (
    SpeculativeForecaster,
    ForecastResult,
    Candidate,
    RoadType,
    compute_divergence,
    road_type_from_divergence,
    cluster_candidates,
    sanitize_sign_text,
)


class LLMCandidateSampler:
    """
    用 LLM 生成候选走向。

    通过 prompt 让模型列出 k 种可能的下一步，
    再用 embedding API（或内置哈希）编码为向量。

    两种 embedding 策略：
    1. 有 embedding API → 调 API 拿真实向量
    2. 无 API → 用文本哈希做伪 embedding（演示用）
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8080/v1",
        model: str = "qwen3.6-35b",
        api_key: str = "EMPTY",
        embedding_model: Optional[str] = None,
        embedding_base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        oversample_margin: int = 2,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.embedding_model = embedding_model
        self.embedding_base_url = embedding_base_url or base_url
        # 本地模型慢时，宁可快速回退到本地推演，也不让用户干等「思考中…」。
        # 可用环境变量 LLM_TIMEOUT 调整（秒）。
        self.timeout = float(timeout if timeout is not None
                             else os.environ.get("LLM_TIMEOUT", "30"))
        # 超采样边际：提示让模型给 k+margin 个候选（同义簇折叠后仍有富余回填到 k 块牌）
        self.oversample_margin = int(oversample_margin)
        self.last_question_type = "choice"  # 最近一次判断的问题类型
        self.force_local = False           # fast 通道：跳过 LLM，直接本地推演
        self.last_source = "local"         # 本次采样来源：llm | local

    def sample(self, context: str, k: int = 3) -> List[Candidate]:
        # 1. 调用 LLM 生成候选走向文本
        candidates_text = self._ask_llm(context, int(k) + self.oversample_margin)

        # 2. 提取 LLM 判断的问题类型
        qtype = "choice"
        if candidates_text:
            qtype = candidates_text[0].pop("_type", "choice")
        self.last_question_type = qtype

        # 3. 编码为向量
        vectors = self._embed(candidates_text)

        # 4. 推断模态类型
        modality = self._infer_modality(context)

        # 5. 组装 Candidate
        return [
            Candidate(
                label=c["label"],
                sub=c["sub"],
                vec=vectors[i],
                color=c.get("color", "#5ee0ff"),
                modality=modality,
                steps=c.get("steps", []),
                rationale=c.get("rationale", ""),
            )
            for i, c in enumerate(candidates_text)
        ]

    @staticmethod
    def _infer_modality(context: str) -> str:
        """根据上下文推断模态类型"""
        ctx = context.lower()
        # 视觉相关
        if any(kw in ctx for kw in ["图片", "图像", "识别", "检测", "分类", "image", "vision", "cv", "yolo", "目标检测", "分割", "ocr", "人脸"]):
            return "vision"
        # 音频相关
        if any(kw in ctx for kw in ["音频", "语音", "转录", "识别", "speech", "audio", "语音识别", "asr", "tts", "音乐", "声纹"]):
            return "audio"
        # 多模态融合
        if any(kw in ctx for kw in ["多模态", "multimodal", "图文", "video", "视频理解", "跨模态", "对比学习", "clip"]):
            return "multimodal"
        return "text"

    def _ask_llm(self, context: str, k: int) -> List[dict]:
        """让 LLM 列出 k 种可能的下一步走向"""
        import urllib.request, urllib.error, urllib.parse, re
        # 快速通道：完全不碰网络，毫秒级出牌
        if self.force_local:
            self.last_source = "local"
            return self._local_forecast(context, k)
        # Strata（本机 8080）解码约 17 tok/s，且 parallel=1：
        # 输出体积决定能否在交互时限内返回。用行格式代替 JSON，
        # 4 个候选约百来个 token，即使被截断也能解析出前几行。
        prompt = f"""任务规划。判断问题类型，给{k}个下一步做法（普通用户看得懂的话）。
类型 direct=简单问答 / sequential=必须按顺序做几件事 / choice=多种做法可选。
第一行只写类型。之后每行一个做法：做法|为什么|步骤1,步骤2|理由
每行≤30字，不要编号、不要JSON、不要解释。
做法必须是智能体自己接下来要做的事，不是让用户去做的事。
禁止出现网址、链接，禁止「建议访问/查看/搜索某网站某数据」这类把任务推回给用户的话。
候选必须围绕用户会话里的具体对象/主题（而不是那套万金油动作）。
若用户问题已有主题词，候选做法应提到该主题；若已经走过若干步，候选应沿这条线继续深入，
而不是回退到「整理结论/继续深入」这类套话（除非步骤里确有总结这一步的必要）。
每个候选之间必须是不同的方向——不要把同一个方向写成换词说法（如「检索资料」与「查资料」不要同时出现）。
对需要信息支撑的开放问题（研究、分析、评估、预测类），候选中必须包含至少一个调研检索类动作，
且该候选的「做法」一词本身就是调研检索动作（如「查资料」「检索电力交易政策」「调研市场动态」），
不要只在步骤列里写检索字样；其余候选走执行、分析等不同方向。
示例：
choice
查相关数据|结论要有依据|检索,整理|更准确
梳理政策影响|用户关注的外部环境|检索,对比,梳理|贴合主题

问题：{context}"""

        # 排队感知：Strata 只有 1 个 slot，被别的客户端长请求占住时
        # 任何新请求都会排队到超时。此时直接走本地结果，不空等。
        try:
            import urllib.parse
            u = urllib.parse.urlsplit(self.base_url)
            root = f"{u.scheme}://{u.netloc}"
            with urllib.request.urlopen(root + "/status", timeout=2) as sr:
                st = json.loads(sr.read())
            if st.get("busy") or (st.get("queued") or 0) > 0:
                self.last_source = "local"
                self.last_busy = True
                return self._local_forecast(context, k)
        except Exception:
            pass   # 云端 API 没有 /status，照常请求
        self.last_busy = False

        try:
            import urllib.request
            import urllib.error

            data = json.dumps({
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": 200,
                "chat_template_kwargs": {"enable_thinking": False},
            }).encode("utf-8")

            req = urllib.request.Request(
                f"{self.base_url}/chat/completions",
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
            )

            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read())
                text = body["choices"][0]["message"]["content"]

            # 解析类型：模型偶尔会先输出说明文字，用全文匹配更稳
            m = re.search(r'\b(direct|sequential|choice)\b', text, re.I)
            question_type = m.group(1).lower() if m else 'choice'

            # 优先行格式：做法|为什么|步骤1,步骤2|理由（短、截断安全）
            PALETTE = ['#34f5a0', '#ffb13d', '#ff5fe0', '#5ee0ff', '#ffd23f']
            candidates = []
            for line in text.splitlines():
                line = line.strip().strip('`').strip()
                if line.count('|') < 3:
                    continue
                p = [x.strip() for x in line.split('|')]
                if not p[0] or len(p[0]) > 16:
                    continue
                # 净化路牌文案：「为什么」「理由」「步骤」三列都是模型自由文本，
                # 可能写出「建议访问某网站」这类把任务推回给用户的话，
                # 命中即清空，前端用候选 label 兜底展示。
                steps = [s for s in (s.strip()[:8] for s in re.split(r'[,，、]', p[2]) if s.strip())
                         if sanitize_sign_text(s)][:3]
                candidates.append({
                    "label": p[0][:12],
                    "sub": sanitize_sign_text(p[1][:30]) or p[0][:12],
                    "steps": steps,
                    "rationale": sanitize_sign_text(p[3][:24]) or "智能体可执行",
                    "color": PALETTE[len(candidates) % len(PALETTE)],
                })
            if not candidates:
                # 兼容模型仍输出 JSON 数组的情况
                start, end = text.find("["), text.rfind("]") + 1
                if start >= 0 and end > start:
                    try:
                        candidates = json.loads(text[start:end])
                    except Exception:
                        candidates = []
            for c in candidates:
                if isinstance(c, dict):
                    if "color" not in c:
                        c["color"] = "#5ee0ff"
                    # JSON 回退路径同样净化路牌文案
                    if "sub" in c:
                        cleaned = sanitize_sign_text(str(c.get("sub", "")))
                        c["sub"] = cleaned or c.get("label", "")[:12] or "智能体可执行"
                    if "rationale" in c:
                        cleaned2 = sanitize_sign_text(str(c.get("rationale", "")))
                        c["rationale"] = cleaned2 or "智能体可执行"
                    if "label" in c:
                        cleaned3 = sanitize_sign_text(str(c.get("label", "")))
                        if cleaned3:
                            c["label"] = cleaned3[:12]

            # 存储类型到第一个候选（供上层读取）
            if candidates:
                candidates[0]["_type"] = question_type
            self.last_source = "llm" if candidates else "local"
            return candidates[:k]

        except Exception as e:
            # LLM 不可用时，走本地关键词快速推演
            print(f"[LLMForecaster] LLM 调用失败，走本地快速推演: {e}")
            self.last_source = "local"
            return self._local_forecast(context, k)

    @staticmethod
    def _extract_business_phrases(context: str, limit: int = 6) -> List[str]:
        """从会话上下文抽出「用户真实说过的业务短语」，供本地兜底锚定。

        前端 buildExploreContext 会把「（旅程已走过：…）—— 已经沿这条路…」
        这类元数据拼进 context。本地推演只读用户本人说过的内容，否则会把
        「旅程已走过」「下一步」这种系统话术当成业务主题，重新变成空洞词。
        返回按出现顺序去重的实义短语（中文连续串 / 英文缩写如 ERA5、GLCM）。
        """
        import re as _re
        txt = _re.split(r"（旅程已走过|\s*——\s*已经沿这条路", context or "")[0].strip()
        # 切完为空 = 只有元数据、没有用户原话。此时绝不 fallback 回完整 context，
        # 否则会把「旅程已走过」「下一步」这类系统话术抽成业务短语。
        # 去掉前端的结构性标记（[prev] 等），别让标记本身变成「业务短语」
        txt = _re.sub(r"\[[A-Za-z]+\]", " ", txt)
        if not txt:
            return []
        # 剥掉祈使/疑问前缀，避免「帮我」「怎么」「分析一下」混进主题
        txt = _re.sub(
            r"^(请|帮我|麻烦|我想|我要|能不能|可否|如何|怎么|怎样|为什么|"
            r"分析一下|介绍一下|讲讲|说说|问一下|看一下)[，,：:\s]*", "", txt)
        stop = {
            "的", "了", "和", "与", "及", "并", "或", "在", "对", "把", "给",
            "做", "是", "有", "这", "那", "个", "一下", "怎么", "如何", "什么",
            "哪些", "帮我", "请", "进行", "相关", "以及", "还有", "用户", "问题",
            "任务", "下一步", "结论", "整理", "继续", "深入", "可以", "需要",
            "一个", "我们", "它们", "这个", "多少", "还是", "分析", "研究",
            "了解", "介绍", "处理", "关于", "一下", "看看", "主体", "方面",
        }
        segs = _re.split(r"[\s,，。；;:：!！?？、·…—\-()（）\[\]【】]+", txt)
        phrases: List[str] = []
        # 注意：不要把裸「中」当切点——「中长期交易」会被削成「长期交易」。
        CUT = (r"的|和|与|及|并|或|由|为|是|构成|怎么做|怎么|如何|为什么|"
               r"是不是|能不能|产生|导致|用到|用于|请问|我想知道|以及|还有")
        for seg in segs:
            for m in _re.finditer(r"[一-龥]{2,}", seg):
                p = m.group(0)
                # 剥掉开头的通用动词，让「分析风电场功率预测」→「风电场功率预测」
                p = _re.sub(r"^(分析|研究|了解|介绍|讲讲|说说|写|做|看一下|查|检索|对比|评估|处理|生成)+", "", p) or p
                # 按结构性虚词 / 疑问词切开；切不动就保留整段（长业务对象本身可读，
                # 旧版在这里直接丢弃，导致「白洋淀机载高光谱数据…」抽不到任何主题）。
                for q in _re.split(CUT, p):
                    q = q.strip()
                    # 注意：不要把「用」当介词剥掉——「用户侧」会被削成「户侧」。
                    q = _re.sub(r"^(在|到|对|把|从|向|以|怎么|如何|什么|哪|吗|呢|是否|一下)+", "", q)
                    q = _re.sub(r"(到|在|用|对|把|从|向|以|由|为|是|一下|了|着|过)$", "", q)
                    if not (2 <= len(q) <= 12) or q in stop:
                        continue
                    if _re.search(r"怎么|如何|什么|哪|吗|呢|是否", q) or q.endswith(("解决", "处理", "办")):
                        continue          # 疑问残片 / 动宾尾巴不是业务对象
                    phrases.append(q)
            # 英文缩写 / 专有名词：ERA5、GLCM、S2、YOLOv8、EC、MCP、GPP…
            for m in _re.finditer(r"[A-Za-z][A-Za-z0-9\-]{1,}", seg):
                w = m.group(0)
                if w.lower() in {"the", "and", "for", "with", "how", "what",
                                 "why", "is", "are", "of", "to", "in", "on",
                                 "km", "cm", "mm", "kg", "gb", "mb"}:
                    continue
                phrases.append(w)
        seen, out = set(), []
        for p in phrases:
            key = p.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(p)
            if len(out) >= limit:
                break
        return out

    @staticmethod
    def _local_forecast(context: str, k: int) -> List[dict]:
        """本地关键词快速推演——LLM 不可用 / fast 预览通道（source=local）。

        ★ 诚实边界：这里没有任何模型参与（前端凭据条显式标「模型未参与」）。
          候选文案只能由「用户会话里真实出现过的业务短语」组合而成：
          - 不得返回与会话无关的万金油动作（写代码 / 查文档 / 对比分析 / 总结）；
          - 不得用「你关注的这件事」这类占位符假装已经理解了业务；
          - 抽不到业务短语时如实说没取到，绝不编一个主题。
        根因记录：v0.9.22 把未来牌全切到 fast=1 后，100% 走这条本地模板，
        原先 intent_map 的硬编码动作就成了「路牌空洞词」的必然来源。
        响应时间 < 50ms。
        """
        import re
        ctx = (context or "").lower().strip()
        phrases = LLMCandidateSampler._extract_business_phrases(context)
        # 主主题不取「最长」而取「最像业务对象」：长度 + 领域名词加权，
        # 避免把「怎么在输入端解决」这类疑问残片选成主题。
        DOMAIN = ("数据", "预测", "模型", "市场", "交易", "反演", "影像", "误差",
                  "指标", "平台", "系统", "方法", "算法", "特征", "样本", "报告",
                  "规则", "政策", "功率", "碳汇", "光谱", "评估", "曲线", "通量",
                  "同化", "风险", "来源", "口径", "维度", "结构", "脚本", "接口")
        def _score(p):
            return len(p) + 4 * sum(1 for h in DOMAIN if h in p)
        topic = max(phrases, key=_score) if phrases else ""
        sides = [p for p in phrases if p != topic][:4]

        # ── ① 简单问题 → direct：一条直道，没有岔路 ──
        if re.match(r'^(你好|hi|hello|嗨|在吗|谢谢|多谢|再见|bye|你是谁|1\+1|2\+2|几点了)[\s!！?？。.,，]*$', ctx):
            out = [{"label": "直接回答", "sub": "信息充分，无需选择",
                    "steps": ["理解", "回应"], "rationale": "最简单", "color": "#34f5a0"}]
            out[0]["_type"] = "direct"
            return out

        # ── ② 做事流程 → sequential：依次执行，不是分岔 ──
        SEQ_MARKERS = ["先", "再", "然后", "接着", "最后", "之后", "依次",
                       "一步步", "第一步", "第二步", "流程", "步骤", "随后"]
        STEP_LABELS = [
            ("读取", "读取数据"), ("导入", "导入数据"), ("加载", "加载数据"),
            ("采集", "采集数据"), ("爬取", "采集数据"), ("抓取", "采集数据"),
            ("清洗", "清洗数据"), ("预处理", "预处理"), ("标注", "标注数据"),
            ("整理", "整理资料"), ("筛选", "筛选样本"), ("转换", "格式转换"),
            ("统计", "统计分析"), ("计算", "计算指标"), ("分析", "分析数据"),
            ("建模", "建立模型"), ("训练", "训练模型"), ("评估", "评估效果"),
            ("验证", "验证结果"), ("对比", "对比结果"), ("可视化", "可视化展示"),
            ("出图", "绘制图表"), ("绘图", "绘制图表"),
            ("生成报告", "生成报告"), ("出报告", "输出报告"), ("写报告", "撰写报告"),
            ("报告", "输出报告"), ("导出", "导出结果"), ("汇总", "汇总结论"),
            ("测试", "测试验证"), ("部署", "部署上线"), ("上线", "部署上线"),
            ("发布", "发布交付"), ("优化", "优化调整"),
        ]
        seq_hit = any(m in ctx for m in SEQ_MARKERS)
        hits = []
        for kw, label in STEP_LABELS:
            pos = ctx.find(kw)
            if pos >= 0 and label not in [h[1] for h in hits]:
                hits.append((pos, label))
        hits.sort()                       # 按用户表述的先后顺序
        actions = [h[1] for h in hits][:5]

        if (seq_hit and len(actions) >= 2) or len(actions) >= 3:
            palette = ["#34f5a0", "#5ee0ff", "#ffd23f", "#ffb13d", "#ff5fe0"]
            out = [
                {"label": a,
                 "sub": (f"第 {i+1} 步 · 围绕{topic}依次完成" if topic
                         else f"第 {i+1} 步 · 依次完成"),
                 "steps": [a, "检查"], "rationale": "按顺序执行",
                 "color": palette[i % len(palette)],
                 "topic": topic, "topic_bound": bool(topic)}
                for i, a in enumerate(actions)
            ]
            out[0]["_type"] = "sequential"
            return out

        # ── ③ 主分支：动作族 × 真实业务短语（替代旧的硬编码 intent_map）──
        # 意图只用来「重排方向优先级」，不再决定一套与业务无关的万金油动作。
        # 每块牌的 label 都必须是「动作 + 用户原话里的真实业务对象」。
        DIRECTIONS = [
            ("检索", "补齐{t}的外部依据", ["检索{t}资料", "核对口径", "整理要点"], "结论有依据", "#ffb13d"),
            ("拆解", "把{t}拆成可查要素", ["拆{t}要素", "逐项梳理", "给结构"], "先看清结构", "#34f5a0"),
            ("对照", "比较{t}的不同口径", ["列{t}维度", "逐项对照", "标差异"], "看出差异", "#ffd23f"),
            ("核算", "用数据核{t}的结论", ["取{t}数据", "算指标", "验结果"], "可量化核对", "#5ee0ff"),
            ("落地", "产出关于{t}的成品", ["写{t}脚本", "跑一遍", "验结果"], "能直接落地", "#4fa8ff"),
            ("汇总", "收敛成{t}的结论", ["归纳{t}要点", "检查", "输出结论"], "收住这一轮", "#ff5fe0"),
        ]
        BUILD_KW = ["代码", "写", "实现", "开发", "函数", "脚本", "bug", "报错",
                    "调试", "编程", "code", "python", "java", "js", "生成", "创作"]
        SEARCH_KW = ["搜索", "查", "找", "资料", "文献", "论文", "文档",
                     "知识", "search", "find", "检索", "调研"]
        COMPARE_KW = ["分析", "对比", "评估", "review", "compare", "diff",
                      "区别", "优劣", "误差", "预测", "反演"]
        def _hits(kws):
            return sum(1 for w in kws if w in ctx)
        if _hits(SEARCH_KW) >= 2:
            order = [0, 2, 1, 3, 5, 4]
        elif _hits(BUILD_KW) >= 2:
            order = [4, 1, 3, 2, 0, 5]
        elif _hits(COMPARE_KW) >= 2:
            order = [2, 3, 1, 0, 5, 4]
        else:
            order = [0, 1, 2, 3, 4, 5]

        if not topic:
            # 抽不到任何业务短语：如实说明，绝不编一个主题、也不铺万金油动作。
            # 「你关注的这件事」这类占位符已从本地兜底中彻底移除。
            return [
                {"label": "未取到具体业务对象", "sub": "本地兜底没识别到主题词，请补充具体问题",
                 "steps": ["读原话", "标出对象", "重新推演"], "rationale": "不编造主题",
                 "color": "#ffb13d", "topic": "", "topic_bound": False, "_type": "choice"},
                {"label": "把对象写清楚", "sub": "例如「分析某业务的某指标」，本地即可锚定",
                 "steps": ["确认对象", "确认范围", "再推演"], "rationale": "避免空洞牌",
                 "color": "#5ee0ff", "topic": "", "topic_bound": False, "_type": "choice"},
                {"label": "就字面意思作答", "sub": "不假设业务对象，按现有文字直接回应",
                 "steps": ["读原话", "最短回应"], "rationale": "不作推断",
                 "color": "#34f5a0", "topic": "", "topic_bound": False, "_type": "choice"},
            ][:k]

        # 锚点轮换：主主题 + 其它真实短语，让各方向锚在不同业务侧面，
        # 分歧度引擎才不会把它们折叠成同一簇（否则路形变直道、牌数变少）。
        pool = [topic] + sides
        out = []
        for i, di in enumerate(order):
            verb, sub_tpl, steps_tpl, rationale, color = DIRECTIONS[di]
            anchor = pool[i % len(pool)]
            out.append({
                "label": f"{verb}{anchor}",   # 业务短语完整保留；makeSign 超长自动缩字号
                "sub": sub_tpl.format(t=anchor),
                "steps": [s.format(t=anchor) for s in steps_tpl],
                "rationale": rationale,
                "color": color,
                "topic": topic,
                "anchor": anchor,
                "topic_bound": True,
            })
        out[0]["_type"] = "choice"
        return out[:k]

    def _embed(self, candidates: List[dict]) -> List[np.ndarray]:
        """编码候选走向为 embedding 向量。

        把 label/sub/steps/rationale 一起编码：候选文本都很短，
        只用 label 会让分歧度和 3D 投影几乎全靠随机哈希。
        """
        texts = [
            " ".join(filter(None, [
                c.get("label", ""), c.get("sub", ""),
                " ".join(c.get("steps", []) or []), c.get("rationale", ""),
            ]))
            for c in candidates
        ]
        if self.embedding_model and self.embedding_model != self.model:
            try:
                return self._embed_api(texts)
            except Exception:
                pass
        return [self._hash_embed(t) for t in texts]

    def _embed_api(self, texts: List[str]) -> List[np.ndarray]:
        """调用 embedding API"""
        import urllib.request

        data = json.dumps({
            "model": self.embedding_model,
            "input": texts,
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.embedding_base_url}/embeddings",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )

        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
            return [np.array(d["embedding"]) for d in body["data"]]

    @staticmethod
    def _hash_embed(text: str, dim: int = 128) -> np.ndarray:
        """本地语义向量：中文单字 + 相邻二元组 + 英文词的 hashed-TF，L2 归一化。

        不依赖外部 embedding 服务，但共享表述的候选会有真实重叠特征，
        使「语义相近 → 向量相近 → 3D 中靠近」成立；
        旧的「按字符位置取模」做法让所有中文候选几乎同向，分歧度形同虚设。
        """
        import hashlib
        import re

        s = (text or "").lower().strip()
        feats: List[str] = []
        feats += re.findall(r"[a-z0-9]+", s)
        for seg in re.findall(r"[\u4e00-\u9fff]+", s):
            feats += list(seg)
            feats += [seg[i:i + 2] for i in range(len(seg) - 1)]

        vec = np.zeros(dim, dtype=float)
        for f in feats:
            h = int(hashlib.md5(f.encode("utf-8")).hexdigest()[:8], 16)
            vec[h % dim] += 1.0
        vec = np.sqrt(vec)          # 次线性 TF，抑制长文本天然占优
        n = np.linalg.norm(vec)
        if n > 0:
            vec /= n
        return vec

    @staticmethod
    def _fallback(context: str, k: int) -> List[dict]:
        """LLM 不可用时的回退"""
        return [
            {"label": "直接回答", "sub": "信息充分，直接生成", "color": "#34f5a0"},
            {"label": "检索资料", "sub": "需先 RAG 查资料", "color": "#ffb13d"},
            {"label": "澄清需求", "sub": "意图模糊，先追问", "color": "#ff5fe0"},
            {"label": "代码执行", "sub": "需写代码/跑工具", "color": "#4fa8ff"},
        ][:k]


class LLMForecaster:
    """
    便捷封装：LLMForecaster.forecast(context) → ForecastResult

    直接继承 SpeculativeForecaster 的接口，内部用 LLMCandidateSampler。
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8080/v1",
        model: str = "qwen3.6-35b",
        api_key: str = "EMPTY",
        k: int = 4,
        thresholds: Optional[dict] = None,
        embedding_model: Optional[str] = None,
        embedding_base_url: Optional[str] = None,
    ):
        self.sampler = LLMCandidateSampler(
            base_url=base_url,
            model=model,
            api_key=api_key,
            embedding_model=embedding_model,
            embedding_base_url=embedding_base_url,
        )
        self.forecaster = SpeculativeForecaster(
            sampler=self.sampler, k=k, thresholds=thresholds,
        )

    def forecast(self, context: str) -> ForecastResult:
        return self.forecaster.forecast(context)
