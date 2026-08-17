#!/usr/bin/env python3
"""分区送检基准 —— 跨厂商通用，走 OpenAI 兼容端点。

三个子命令：

    models   <provider>                 列出账号可用模型
    probe    <provider> <model>...      判别性探针：同一问题分别用整页和分区问一遍
    judge    <provider> <model>...      完整判定：5 个分区 × v1/v2 两个 arm

probe 是关键一步。Kimi 那轮已证明「整页失败、分区成功」，
这里用逐字相同的问题换厂商复现，才能把「模型不行」和「送检粒度不对」分开。

判定提示词**不复用** bench.py 那段。为跨轮可比而逐字沿用整页提示词，正是第一次分区判定
失败的原因：那段里写死了整页的五区扫描清单，套到单区块图上会让模型把「本图里没有柱状图」
报成 P0 差异。粒度换了，提示词必须跟着换；可比性靠 ground truth 与评分口径保证，不靠提示词字面相同。

关思维的开关各家不同，且不接受的字段多数是**静默忽略**而非报错
（实测：Kimi 无视 enable_thinking 与 chat_template_kwargs）。因此各家开关写在
PROVIDERS 里显式声明，并对 400 做一次有界自适应重试 —— 厂商的报错本身
就写明了唯一允许值，照着改一次比事先猜参数可靠。
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

REGIONS = ["header", "ring", "stats", "chart", "tabbar"]

PROVIDERS = {
    # thinking 关闭方式：Kimi 只认 thinking:{type:disabled}；百炼认 enable_thinking:false。
    "kimi": {
        "key_env": "VISION_API_KEY",
        "base_env": "VISION_BASE_URL",
        "base_default": "https://api.moonshot.cn/v1",
        "extra": {"thinking": {"type": "disabled"}, "temperature": 0.6},
    },
    "bailian": {
        "key_env": "BAILIAN_API_KEY",
        "base_env": "BAILIAN_BASE_URL",
        "base_default": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "extra": {"enable_thinking": False, "temperature": 0.2},
    },
}

# 送检方式的 2×2 因子：粒度（整页 / 分区）× 输入方式（拼成一张 / 直接给两张）。
# 两个因子必须分开测 —— 否则「分区拼图比整页拼图强」这个结论里，
# 分不清有多少来自粒度、有多少来自拼图本身。
#
# 注意一个固有差异，它不是混杂而是双图方案的本质优势：图像按张收固定 token 预算，
# 双图 = 2 张 × 预算，拼图 = 1 张 × 预算。双图天然拿到两倍像素额度。
MODES = {
    "整页拼图": ("full", "single"),
    "整页双图": ("full", "dual"),
    "分区拼图": (None, "single"),
    "分区双图": (None, "dual"),
    # 空白图对照组：第一轮基准实际用的那张图。旧 shoot.mjs 的 setContent 没能加载 file:// 图片，
    # 产出的是两个空白框加两行英文标注，页面内容一个像素都没有。
    # 保留它作为**夹具损坏的探针**：任何一次评测都该顺带跑一次这一格，
    # 锚点若在这里也「答得出」，说明评分口径本身在放水。
    "空白图对照": ("__blank__", "single"),
}

PREAMBLE = {
    "single": "下面是一张并排对比图：左边是设计稿 A，右边是前端实现 B。",
    "dual": "下面给你两张图：第一张是设计稿 A，第二张是前端实现 B。",
}

# 判别性探针：答案已知且在图上真实存在，用来区分「看不见」与「判断不出」。
# 措辞一律用 A/B，不用「左/右」—— 双图那一路没有左右。
PROBES = [
    ("锚点·标题", "header", "A 顶部的大标题写的是什么？逐字抄出来，不要解释。"),
    ("锚点·数字", "ring", "A 的圆环正中间那个数字是多少？逐字抄出来，不要解释。"),
    ("D1 字重", "header", "A 和 B 的大标题「Good morning Alex」，字重一样吗？如果不一样，哪个更粗？只回答一句话。"),
    ("D3 颜色", "ring", "A 和 B 的圆形进度环，颜色一样吗？如果不一样，分别是什么颜色？只回答一句话。"),
    ("D5 文案", "stats", "A 和 B 里带 kcal 的那个卡路里数字分别是多少？逐字抄出来。"),
    ("D4 素材", "tabbar", "A 和 B 底部标签栏的第一个图标，形状一样吗？分别像什么？只回答一句话。"),
]

# 分区判定提示词。
#
# 不能直接复用 bench.py 的整页提示词：那段里写死了「① 顶部标题 ② 圆环卡片 ③ 统计小卡
# ④ 柱状图 ⑤ 标签栏」的扫描清单，套到只含一个区块的分区图上，模型会把「本图里没有柱状图」
# 当成 P0 差异报出来 —— 实测五个分区共报出 11 条这类结构性幻觉。
#
# 区块名一律不含数量（写「统计小卡区」不写「三个统计小卡」）：数量本身可能就是被注入的缺陷，
# 写进提示词等于泄题。
REGION_NAMES = {
    "header": "页面顶部的问候语大标题与日期副标题",
    "ring": "圆形进度环卡片",
    "stats": "并排的统计小卡区",
    "chart": "柱状图",
    "tabbar": "底部标签栏",
    # evalset/landing —— 桌面落地页
    "nav": "顶部导航栏",
    "hero-head": "首屏主标题",
    "hero-actions": "首屏按钮与其下方的说明小字",
    "features": "并排的特性卡区",
    "cta": "底部的深色行动号召条",
    "seam-features-cta": "特性卡区与其下方深色条之间的衔接部位",
}

# 幻觉测量的三个 arm。identical 是零差异对照：A 与 B 是同一张图，
# 报出的任何差异按定义都是幻觉，不依赖任何「实现有多忠实」的假设。
HALLUC_ARMS = {
    "identical": "设计稿 vs 设计稿自己（真值：零差异）",
    "v1": "设计稿 vs 忠实实现（真值：仅亚像素笔画差异，残余 0.185%）",
    "v2": "设计稿 vs 注入版（真值：6 处已知缺陷）",
}

REGION_PROMPT = """A 与 B 的像素尺寸完全相同，已经对齐，不存在缩放差异，请不要报告尺寸或清晰度类的问题。

**这是整页的一个横向切片，只包含「{region}」这一个区块，上下相邻的其它区块已被裁掉。**
不要把「看不到页面的其它部分」当作差异 —— 那是裁切造成的，不是实现的问题。

请只针对本区块，对以下五个方面逐项表态，每一项都必须给出结论，不能跳过：
1. 字体排印（字重是否变粗变细、字号、行高、字间距）
2. 间距与布局节奏（元素之间的间隔、内外边距、对齐、圆角）
3. 颜色（主色调、强调色、文字色、背景色）
4. 图形素材保真（图标/图形是否被简化、替换成粗糙形状，或用基本几何形代替原本的线性图标）
5. 文案内容（所有可见文字逐字核对，包括数字）

输出格式，每条差异一段：

【差异】具体元素
A：（设计稿里是什么样）
B：（实现里是什么样）
严重度：P0 阻断 / P1 明显不匹配 / P2 中度漂移 / P3 微调

最后给出五项结论：
1. 字体排印：一致 / 不一致（说明） / 无法判断
2. 间距节奏：...
3. 颜色：...
4. 素材保真：...
5. 文案：...

重要：只报告你在这张图上确实看到的差异。若某处看不清，写"无法判断"，不要推测。宁可少报，不要编造。"""

TRUTH = {
    "锚点·标题": "Good morning Alex",
    "锚点·数字": "8,420",
    "D1 字重": "不一样，左(设计稿)更粗 —— 800 vs 500",
    "D3 颜色": "不一样，左珊瑚橙 #F26B45 / 右芥末黄 #E8A33D",
    "D5 文案": "左 412，右 421",
    "D4 素材": "不一样，左是线性房子图标，右是空心方块",
}

OUT = HERE / "results3"


def creds(provider: str) -> tuple[str, str]:
    spec = PROVIDERS[provider]
    value = os.environ.get(spec["key_env"])
    if not value:
        raise SystemExit(f"缺少 {spec['key_env']}")
    return value, os.environ.get(spec["base_env"]) or spec["base_default"]


def post(url: str, body: dict, api_key: str, timeout: int):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def adapt(body: dict, message: str) -> bool:
    """照着厂商 400 的报错改一次请求体。改动了返回 True，改不动返回 False。

    两种已实测的报错形态：
      invalid temperature: only 0.6 is allowed for this model
      invalid thinking: only type=enabled is allowed for this model
    后者意味着这个模型关不掉思维，只能放弃关闭并如实记录。
    """
    match = re.search(r"invalid temperature: only ([\d.]+) is allowed", message)
    if match:
        body["temperature"] = float(match.group(1))
        return True
    if "invalid thinking" in message and "type=enabled" in message:
        body.pop("thinking", None)  # 关不掉，退回默认（思维开启），结果里标注
        return True
    return False


def ask(provider: str, model: str, images: list[Path], prompt: str, max_tokens: int):
    api_key, base = creds(provider)
    parts = [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64.b64encode(image.read_bytes()).decode()}"}}
        for image in images
    ]
    body = {
        "model": model,
        "max_tokens": max_tokens,
        **PROVIDERS[provider]["extra"],
        "messages": [{"role": "user", "content": [*parts, {"type": "text", "text": prompt}]}],
    }
    notes = []
    for _ in range(3):
        started = time.time()
        try:
            payload = post(f"{base}/chat/completions", body, api_key, 300)
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:300]
            if error.code == 400 and adapt(body, detail):
                notes.append(detail.split('"message":"')[-1].split('"')[0][:70])
                continue
            return f"__HTTP {error.code}__ {detail}", {}, 0.0, notes
        except Exception as error:  # noqa: BLE001 - 基准要记录任何失败并跑完剩余格子
            return f"__{type(error).__name__}__ {str(error)[:200]}", {}, 0.0, notes
        message = payload["choices"][0]["message"]
        return message.get("content") or "", payload.get("usage", {}), time.time() - started, notes
    return "__自适应重试仍失败__", {}, 0.0, notes


def cmd_models(provider: str) -> int:
    api_key, base = creds(provider)
    request = urllib.request.Request(f"{base}/models", headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response).get("data", [])
    names = sorted(item["id"] for item in data)
    OUT.mkdir(exist_ok=True)
    (OUT / f"_models-{provider}.txt").write_text("\n".join(names), encoding="utf-8")
    print(f"共 {len(names)} 个模型；含 vl/omni/max/qwen3 的：")
    for name in names:
        if any(tag in name for tag in ("vl", "omni", "max", "qwen3")):
            print(" ", name)
    return 0


def images_for(mode: str, tile: str, arm: str = "v2") -> list[Path]:
    """按送检方式取图。single 取并排拼图一张，dual 取 A/B 两张独立裁剪。"""
    override, kind = MODES[mode]
    if override == "__blank__":
        return [HERE / "composite" / f"{arm}-vs-design.png"]
    region = override or tile
    stem = HERE / "tiles" / f"{arm}__{region}"
    if kind == "single":
        return [stem.with_name(f"{stem.name}.png")]
    return [stem.with_name(f"{stem.name}__A.png"), stem.with_name(f"{stem.name}__B.png")]


def cmd_probe(provider: str, models: list[str]) -> int:
    OUT.mkdir(exist_ok=True)
    lines = []
    for model in models:
        for label, tile, question in PROBES:
            for mode in MODES:
                kind = MODES[mode][1]
                prompt = f"{PREAMBLE[kind]}\n\n{question}"
                text, usage, elapsed, notes = ask(provider, model, images_for(mode, tile), prompt, 300)
                answer = " ".join(text.split())[:100]
                tag = f" [{'; '.join(notes)}]" if notes else ""
                lines.append(f"{model:22s} {mode} {label:10s} in={usage.get('prompt_tokens', '-'):>6} {elapsed:5.1f}s  {answer}{tag}")
                print(lines[-1], flush=True)
            lines.append(f"{'':22s} 真值 {label:10s} {TRUTH[label]}")
            print(lines[-1], flush=True)
    (OUT / f"_probe-{provider}.txt").write_text("\n".join(lines), encoding="utf-8")
    return 0


def cmd_judge(provider: str, models: list[str], mode: str = "分区拼图") -> int:
    OUT.mkdir(exist_ok=True)
    kind = MODES[mode][1]
    lines = []
    for model in models:
        for arm in ("v1", "v2"):
            for region in REGIONS:
                prompt = PREAMBLE[kind] + "\n\n" + REGION_PROMPT.format(region=REGION_NAMES[region])
                images = images_for(mode, region, arm)
                text, usage, elapsed, notes = ask(provider, model, images, prompt, 2000)
                (OUT / f"{model}__{mode}__{arm}__{region}.md").write_text(text, encoding="utf-8")
                tag = f" [{'; '.join(notes)}]" if notes else ""
                lines.append(f"{model:22s} {mode} {arm} {region:8s} in={usage.get('prompt_tokens', '-'):>6} out={usage.get('completion_tokens', '-'):>5} {elapsed:5.1f}s{tag}")
                print(lines[-1], flush=True)
    (OUT / f"_judge-{provider}-{mode}.txt").write_text("\n".join(lines), encoding="utf-8")
    return 0


# 逐保真面定向发问。开放式提问下模型漏掉了难档缺陷（字重 800→500 肉眼可见却全报「一致」），
# 而同一缺陷被定向问到时 12/12 命中 —— 它问到就看得见，不问不会主动看。
#
# 这里把「自己找」换成 30 个格子（6 区块 × 5 保真面）逐格必答。
# 被测的是这个交换划不划算：堵死「一致」这条退路之后，省下的话会被真判断填上，还是被编造填上。
FACETS = {
    "字体排印": "只看文字的**字重、字号、行高、字间距**。A 与 B 有区别吗？",
    "间距节奏": "只看**元素之间的间隔、内外边距、对齐、圆角半径**。A 与 B 有区别吗？",
    "颜色": "只看**颜色**（背景色、文字色、强调色、边框色）。A 与 B 有区别吗？",
    "素材保真": "只看**图标与图形素材的形状**——是否被简化、替换成基本几何形（方块/圆/直线）。A 与 B 有区别吗？",
    "文案": "只看**文字内容**，逐字逐数字核对。A 与 B 有区别吗？",
}

FACET_PROMPT = """{preamble}

这是整页的一个横向切片，只包含「{region}」这一个区块，上下相邻的区块已被裁掉。
不要把「看不到页面的其它部分」当作差异。A 与 B 像素尺寸完全相同、已对齐，不存在缩放差异。

**本次只检查一个方面，其它方面一律不要提。**

{facet}

回答格式，严格三选一，第一行只写结论：
- `一致` —— 该方面 A 与 B 没有区别
- `不一致：<哪个元素> / A 是<什么> / B 是<什么>` —— 有区别，必须指名元素并说清两边各是什么
- `无法判断：<原因>` —— 看不清

第一行之后可以补一句依据，不超过 30 字。**不确定就写「一致」或「无法判断」，不要猜。**"""


def cmd_facets(provider: str, models: list[str]) -> int:
    """6 区块 × 5 保真面逐格定向发问，三个 arm 并列。

    identical arm（A 与 B 是同一张设计稿）上任何一句「不一致」都是幻觉，
    这是整套实验里唯一不依赖「实现有多忠实」的一格。
    """
    OUT.mkdir(exist_ok=True)
    pairs = sorted((HERE / "pairs").glob("*.png"))
    lines = []
    for model in models:
        for image in pairs:
            fixture, arm, region = image.stem.split("__")
            for facet, question in FACETS.items():
                prompt = FACET_PROMPT.format(preamble=PREAMBLE["single"],
                                             region=REGION_NAMES[region], facet=question)
                text, usage, elapsed, notes = ask(provider, model, [image], prompt, 300)
                head = " ".join(text.split())[:96]
                lines.append(f"{arm:7s} {region:18s} {facet:6s} in={usage.get('prompt_tokens', '-'):>5} out={usage.get('completion_tokens', '-'):>4} {elapsed:4.1f}s  {head}")
                print(lines[-1], flush=True)
    (OUT / f"_facets-{provider}.txt").write_text("\n".join(lines), encoding="utf-8")
    return 0


def cmd_pairs(provider: str, models: list[str]) -> int:
    """对 pairs/ 下的成对送检图跑开放式判定，三个 arm 并列，用于测幻觉率。

    文件名约定 `{fixture}__{arm}__{region}.png`，其中 arm=design 即零差异对照
    （A 与 B 是同一张设计稿），它报出的每一条差异都是幻觉，无需任何忠实度假设。
    """
    OUT.mkdir(exist_ok=True)
    pairs = sorted((HERE / "pairs").glob("*.png"))
    lines = []
    for model in models:
        for image in pairs:
            fixture, arm, region = image.stem.split("__")
            prompt = PREAMBLE["single"] + "\n\n" + REGION_PROMPT.format(region=REGION_NAMES[region])
            text, usage, elapsed, notes = ask(provider, model, [image], prompt, 2000)
            (OUT / f"{model}__{fixture}__{arm}__{region}.md").write_text(text, encoding="utf-8")
            tag = f" [{'; '.join(notes)}]" if notes else ""
            lines.append(f"{model:22s} {fixture} {arm:7s} {region:18s} in={usage.get('prompt_tokens', '-'):>6} out={usage.get('completion_tokens', '-'):>5} {elapsed:5.1f}s{tag}")
            print(lines[-1], flush=True)
    (OUT / f"_pairs-{provider}.txt").write_text("\n".join(lines), encoding="utf-8")
    return 0


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[2] not in PROVIDERS:
        print(__doc__)
        print(f"provider 取值：{' | '.join(PROVIDERS)}")
        return 1
    command, provider, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    mode = rest.pop(0) if rest and rest[0] in MODES else "分区拼图"
    if command == "models":
        return cmd_models(provider)
    if command == "probe":
        return cmd_probe(provider, rest)
    if command == "judge":
        return cmd_judge(provider, rest, mode)
    if command == "pairs":
        return cmd_pairs(provider, rest)
    if command == "facets":
        return cmd_facets(provider, rest)
    print(f"未知子命令: {command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
