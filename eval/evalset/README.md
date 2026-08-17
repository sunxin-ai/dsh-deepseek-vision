# evalset — 视觉保真判定夹具集

四组 UI 原型 × 三个版本（设计稿 / 忠实实现 / 注入版），共 **23 处已知缺陷**，按 [RUBRIC.md](../RUBRIC.md) §2 构造、§3 分档注入。
第一组夹具（`（本仓库未随包分发生成的设计稿源图）` + `（本仓库未随包分发早期实现夹具）`）用生图模型出设计稿；本目录改用 **`design.html` 渲染出 `design.png` 当设计稿**，ground truth 精确可控，任何人都能逐像素复现。

## 一、四组夹具一览

| 组 | 原型类型 | 视口（CSS @2x → px） | 缺陷数 | 难度分布 | v1 忠实度（design↔v1 残余） |
|---|---|---|---|---|---|
| `landing` | 桌面落地页：hero + 特性三栏 + CTA 深色条 | 1280×800 → 2560×1600 | 6 | **难 2** / 中 2 / 易 2 | 0.185% |
| `dashboard` | 数据看板：侧栏 + 4 指标卡 + 折线图 + 表格 | 1280×800 → 2560×1600 | 6 | **难 2** / 中 2 / 易 2 | 0.062% |
| `list` | 移动端列表页：搜索框 + 筛选条 + 7 行含头像会话 + 底部栏 | 393×852 → 786×1704 | 5 | **难 2** / 中 2 / 易 1 | 0.060% |
| `form` | 表单页：进度条 + 输入框 / 下拉 / 复选 + 主次按钮 | 393×852 → 786×1704 | 6 | **难 3** / 中 2 / 易 1 | 0.018% |
| | | | **23** | **难 9 / 中 8 / 易 6** | |

保真面覆盖：字体排印 4、颜色 5、间距节奏 3、素材保真 3、布局 3、文案 3、圆角 2。

每组目录：

```
<name>/
  design.html   设计稿的真值实现 —— 渲染它得到设计稿
  design.png    design.html 的截图，即「设计稿」
  v1.html       忠实实现（照 design.png 独立重写，非 design.html 的副本）
  v2.html       v1 + 注入缺陷
  defects.md    该组的注入清单 + 断言结果
  v1.png v2.png 实现截图，与 design.png 像素尺寸完全一致
  crops/        语义分区图（跑 --crops 生成，见第四节）
```

## 二、全部缺陷 ground truth（供评分用）

难度档口径见 RUBRIC §3；**通过线设在难档**（RUBRIC §5 第 1 条）。
「区块」列是判定该缺陷应当送检的分区图；`seam-` 开头表示**跨区块缺陷**，单个区块内看不出来，必须用缝隙图。

| ID | 组 | 保真面 | 难度 | 改动 | 区块 |
|---|---|---|---|---|---|
| L1 | landing | 字体排印 | **难** | 主标题字重 800 → 500 | `hero-head` |
| L2 | landing | 间距节奏 | **难** | CTA 条上边距 40 → 12px（Δ28） | `seam-features-cta` **跨区块** |
| L3 | landing | 素材保真 | 中 | 特性卡 2 放大镜图标 → CSS 方块 | `feature-2` |
| L4 | landing | 布局 | 中 | 特性卡 1 与卡 3 位置对调 | `features`（跨 `feature-1`↔`feature-3`） |
| L5 | landing | 颜色 | 易 | 导航按钮 #4B5ED8 → #4BD886（色相 232°→145°） | `nav` |
| L6 | landing | 文案 | 易 | 12,000+ → 21,000+ | `hero-actions` |
| D1 | dashboard | 字体排印 | **难** | 指标卡 3 数值 28 → 26px（−2px） | `metric-3` |
| D2 | dashboard | 圆角 | **难** | 折线图卡圆角 14 → 8px（−6px） | `chart` |
| D3 | dashboard | 颜色 | 中 | 指标卡 1 涨幅胶囊 #DFF6EB → #96E3BD（同色相 150°，明度 92%→74%） | `metric-1` |
| D4 | dashboard | 布局 | 中 | 表格 Status 列与 Amount 列对调 | `table` |
| D5 | dashboard | 文案 | 易 | $7,260 → $7,620 | `metric-4` |
| D6 | dashboard | 颜色 | 易 | 侧栏当前项 靛蓝 → 品红（色相 232°→330°） | `sidebar` |
| LS1 | list | 间距节奏 | **难** | 筛选条与列表间距 14 → 38px（Δ24） | `seam-chips-list` **跨区块** |
| LS2 | list | 字体排印 | **难** | 标题 Messages 字号 26 → 24px（−2px） | `header` |
| LS3 | list | 素材保真 | 中 | 搜索放大镜 → CSS 正圆 | `search` |
| LS4 | list | 颜色 | 中 | 第 2 行头像 #EA8053 → #F4BCA4（同色相 18°，明度 62%→80%） | `row-2` |
| LS5 | list | 文案 | 易 | Thursday → Tuesday | `row-1` |
| F1 | form | 圆角 | **难** | 主按钮圆角 12 → 18px（+6px） | `actions` |
| F2 | form | 间距节奏 | **难** | 字段区与复选框组间距 24 → 50px（Δ26） | `seam-fields-checks` **跨区块** |
| F3 | form | 字体排印 | **难** | 标题 Shipping details 字重 700 → 500 | `title` |
| F4 | form | 素材保真 | 中 | 下拉 chevron → CSS 方块 | `field-country` |
| F5 | form | 布局 | 中 | Full name 与 Email address 字段对调 | `fields-top` |
| F6 | form | 颜色 | 易 | 进度条 #4B5ED8 → #E67433（色相 232°→22°） | `progress` |

逐条的精确改动、区块 CSS 框坐标与实测变化像素数，见各组的 `defects.md`；机器可读版在 `fixtures.mjs`。

## 三、方法要点

**设计稿为什么是 HTML 渲染的。** 生图模型的产出不可复现、也无法精确控制 ground truth。用 `design.html` 渲染出 `design.png`，设计稿的每个 token 都是已知量，注入缺陷的方向和幅度可以精确到 px 和 HSL 度数。

**v1 为什么必须独立重写。** v1 是**误报率对照组**（RUBRIC §2.1）。若从 `design.html` 复制粘贴，v1 会与设计稿像素级相同，这条 arm 就测不出任何东西。四组的 v1 都是照着 `design.png` 用**另一套实现手法**重写的：

| 组 | design.html 的写法 | v1.html 的写法 |
|---|---|---|
| landing | grid 布局、`gap`、SVG `path` 描边图标 | flex 布局、相邻兄弟 `margin`、`<line>`/`<circle>` 自绘图标 |
| dashboard | body 级 grid 分栏、`<polyline>` 折线 | flex 分栏、`<path>` M/L 命令折线 |
| list | `<div>` 行 + 独立 `.sep` 分隔线 `<div>` | `<ul>/<li>` + `::after` 绝对定位分隔线 |
| form | `<div>` 模拟输入框 / 下拉 / 复选框 | 真实 `<input>`/`<select>`/`<input type=checkbox>` + `appearance:none` 重置 |

结果：四组的 design↔v1 残余差异均 **≤ 0.185%**，且全部落在自绘图标笔画与文字亚像素度量上，没有任何位置、尺寸、颜色层面的偏差。
换言之，**v1 arm 里模型报出的位置/尺寸/颜色类差异，一律是幻觉**；只有关于图标笔画细节的报告才可能是真实的。这是这套夹具能测幻觉率的基础。

**注入纪律。** 每处缺陷都经 `assert.mjs` 三层校验（字符串锚点唯一 / 声明区块内像素确有变化 / 变化不越界到未声明区块）。第二层专门用来抓「改了 CSS 但视觉无变化」的假注入 —— 本次构造中它确实抓到一次：

> 当前字体栈下 `font-weight` 600/700/800/900 渲染为同一字面，最初把主标题 800→600 的注入在像素上完全无效。
> 实测可区分区间是 **100–600**，故字重类缺陷统一用 800→500 / 700→500。扩展夹具时须注意这一点。

## 四、按语义区块送检（重要）

视觉模型对单张图收**固定 token 预算（约 1024 tokens，与图像尺寸无关）**，整页大图必被强制降采样，±2px 字号、±6px 圆角这类难档细节在降采样阶段即已丢失。因此判定按语义区块分区送检，不整页送检。

`fixtures.mjs` 的 `GROUPS[*].blocks` 声明了每组的语义区块（CSS px 的 `[x, y, w, h]`），`node shoot.mjs --crops` 会为 design/v1/v2 各出一套分区图到 `<name>/crops/<variant>__<block>.png`。

**`seam-` 前缀的区块是跨区块缝隙图**，专为间距类缺陷准备。L2 / LS1 / F2 三处「区块间距」缺陷在任何单个区块内都看不出来 —— 区块自身内容一字未改，变的只是它与相邻区块的相对位置。这三处必须用对应的 seam 图判定：

| 缺陷 | seam 区块 | 跨哪两个区 |
|---|---|---|
| L2 | `seam-features-cta` | 特性三栏 ↔ CTA 深色条 |
| LS1 | `seam-chips-list` | 筛选胶囊行 ↔ 会话列表 |
| F2 | `seam-fields-checks` | 表单字段区 ↔ 复选框组 |

此外 L4（跨 `feature-1`↔`feature-3`）也是跨区块缺陷，需用 `features` 整行图判定。

## 五、复现

```sh
export PATH="$HOME/.local/node-v24.19.0-darwin-arm64/bin:$PATH"
cd <包根>/eval
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.playwright"

node evalset/shoot.mjs              # 12 张整页图，带三重尺寸断言
node evalset/shoot.mjs --crops      # 追加 102 张语义分区图
node evalset/shoot.mjs landing form # 只跑指定组
node evalset/assert.mjs             # 23 处注入的三层断言 + v1 忠实度
```

`shoot.mjs` 的断言：CSS 渲染尺寸 == 视口（偏差 >1px 抛错）、内容未溢出被裁切、落盘 PNG 的 IHDR 像素尺寸 == 视口 × 2。任何一条不过即失败 —— 被缩放或被裁切的截图不能用来做保真判断（RUBRIC §2.2）。

所有 HTML 自包含：无外部字体、图片、CDN，只用系统字体栈 `-apple-system / SF Pro Text / Helvetica Neue / Arial`。

`assert.mjs` 当前输出（全部通过）：

```
landing    缺陷 6  HTML diff  41 行  v1↔v2 变化  408723 px  design↔v1 残余 0.185%
dashboard  缺陷 6  HTML diff  20 行  v1↔v2 变化   61288 px  design↔v1 残余 0.062%
list       缺陷 5  HTML diff  16 行  v1↔v2 变化  155694 px  design↔v1 残余 0.060%
form       缺陷 6  HTML diff  23 行  v1↔v2 变化   35335 px  design↔v1 残余 0.018%
```

HTML diff 行数各含 4 行版本标记（`<title>` 与顶部注释，各 2 行）；整块对调类缺陷（L4 / D4 / F5）天然占用较多行数。
