#!/usr/bin/env python3
"""给逐保真面定向发问的结果打分。

三个 arm 的口径不同：
  design（零差异对照）—— A 与 B 是同一张设计稿，任何「不一致」都是幻觉，无解释空间
  v1（忠实实现）      —— 「不一致」需人工核对是否为真实残余差异，本脚本只列出待核对项
  v2（注入版）        —— 按 evalset/landing/defects.md 的 6 处缺陷逐条判召回

脚本不做关键词猜测式的自动判分：只统计三选一的表态分布，并把需要人工核对的原文列出来。
把「提到了颜色」自动判成「抓到了颜色缺陷」，是这类基准最常见的虚高来源。
"""
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# defects.md 的 6 处注入 → (应命中的区块, 应命中的保真面)
LANDING_DEFECTS = {
    "L1 主标题字重 800→500 [难]": ("hero-head", "字体排印"),
    "L2 CTA 上边距 40→12px [难]": ("seam-features-cta", "间距节奏"),
    "L3 放大镜→CSS 方块 [中]": ("features", "素材保真"),
    "L4 特性卡 1↔3 对调 [中]": ("features", "素材保真"),
    "L5 按钮靛蓝→绿 [易]": ("nav", "颜色"),
    "L6 12,000+→21,000+ [易]": ("hero-actions", "文案"),
}


def verdict(text: str) -> str:
    """把一行回答归到三选一。开头即结论，格式在提示词里已规定。"""
    head = text.lstrip("`* ")
    if head.startswith("不一致"):
        return "不一致"
    if head.startswith("无法判断"):
        return "无法判断"
    if head.startswith("一致"):
        return "一致"
    return "格式外"


def main() -> int:
    log = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/facets.log")
    rows = []
    for line in log.read_text(encoding="utf-8").splitlines():
        m = re.match(r"(\S+)\s+(\S+)\s+(\S+)\s+in=\s*(\d+)\s+out=\s*(\d+)\s+([\d.]+)s\s+(.*)", line)
        if m:
            rows.append(dict(arm=m.group(1), region=m.group(2), facet=m.group(3),
                             tin=int(m.group(4)), tout=int(m.group(5)),
                             secs=float(m.group(6)), text=m.group(7)))
    print(f"共 {len(rows)} 格\n")

    by_arm = defaultdict(list)
    for r in rows:
        by_arm[r["arm"]].append(r)

    for arm in ("design", "v1", "v2"):
        rs = by_arm.get(arm, [])
        if not rs:
            continue
        counts = Counter(verdict(r["text"]) for r in rs)
        label = {"design": "零差异对照", "v1": "忠实实现", "v2": "注入版"}[arm]
        print(f"── {label} ({arm})  {len(rs)} 格")
        for k in ("一致", "不一致", "无法判断", "格式外"):
            if counts[k]:
                print(f"     {k:5s} {counts[k]:3d}")
        if arm in ("design", "v1"):
            flagged = [r for r in rs if verdict(r["text"]) == "不一致"]
            tag = "幻觉（无解释空间）" if arm == "design" else "待人工核对"
            print(f"     → {tag}: {len(flagged)} 条")
            for r in flagged:
                print(f"        {r['region']}/{r['facet']}: {r['text'][:88]}")
        print()

    print("── 注入版逐缺陷召回")
    v2 = {(r["region"], r["facet"]): r for r in by_arm.get("v2", [])}
    hit = 0
    for name, key in LANDING_DEFECTS.items():
        r = v2.get(key)
        if r is None:
            print(f"  {name:34s} 该格未跑")
            continue
        v = verdict(r["text"])
        mark = {"不一致": "✅", "无法判断": "⚠️", "一致": "❌"}.get(v, "?")
        hit += v == "不一致"
        print(f"  {mark} {name:34s} [{key[0]}/{key[1]}]  {r['text'][:76]}")
    print(f"\n  召回 {hit}/{len(LANDING_DEFECTS)}")

    tin = sum(r["tin"] for r in rows)
    tout = sum(r["tout"] for r in rows)
    secs = sum(r["secs"] for r in rows)
    cost = tin * 12 / 1e6 + tout * 36 / 1e6
    print(f"\n── 成本  {len(rows)} 格  输入 {tin} / 输出 {tout} tokens  {secs:.0f}s")
    print(f"   合计 {cost:.3f} 元   单格均值 {cost/max(len(rows),1):.4f} 元 / {secs/max(len(rows),1):.1f}s")
    print(f"   一个 6 区块页面单轮（30 格） {cost/max(len(rows),1)*30:.2f} 元")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
