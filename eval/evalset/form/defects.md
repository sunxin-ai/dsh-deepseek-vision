# form — 注入清单（ground truth）

移动端表单页，393×852 CSS @2x = 786×1704。**6 处注入：3 难 / 2 中 / 1 易。**

`v1.html` 是忠实实现（误报率对照组），`v2.html` = v1 + 下列 6 处。
本文件是人读版，机器可读版在 `../fixtures.mjs` 的 `DEFECTS.form`，两者数值必须一致。

## 清单

| ID | 保真面 | 难度 | 具体改动 | 预期可见位置（语义区块 / CSS px 框） |
|---|---|---|---|---|
| **F1** | 圆角 | **难** | 主按钮「Continue to payment」`border-radius: 12px → 18px`（+6px），经新增规则 `.actions .go` 定向；次按钮保持 12px | `actions` `[0,664,393,188]` — 靛蓝主按钮四角明显更圆，与紧邻其下、仍为 12px 的白色次按钮「Back to cart」形成可直接对照的不一致 |
| **F2** | 间距节奏 | **难** | 复选框组 `.options` `margin-top: 24px → 50px`（Δ26px） | **跨区块** `seam-fields-checks` `[0,498,393,172]` — 「Postal code」输入框底边与第一个复选框之间的留白由 24px 拉到 50px；复选框组整体下移 26px（底部按钮组由 `margin-top:auto` 钉在底部，不动，空白从两者之间被吃掉） |
| **F3** | 字体排印 | **难** | 页面标题 `.intro-title` `font-weight: 700 → 500`（跨一档） | `title` `[0,108,393,96]` — "Shipping details" 由粗黑变中等字重，笔画明显变细、字宽收窄；其下灰色说明文字不变，可作参照 |
| **F4** | 素材保真 | 中 | 国家下拉框的线性 chevron SVG → CSS 描边方块 `16×16 border:2px` | `field-country` `[0,336,393,92]` — 「United Kingdom」右端由向下箭头变成空心正方形 |
| **F5** | 布局 | 中 | 「Full name」与「Email address」两个字段整块对调 | `fields-top` `[0,200,393,138]` — 第一个字段变成 Email address（值 alex.moreau@northwind.io），第二个变成 Full name（值 Alex Moreau）；其下 Country / Postal code 两字段位置不变 |
| **F6** | 颜色 | 易 | 进度条已完成段 `.progress-done` `background: #4B5ED8 → #E67433`（色相 232°→22°） | `progress` `[0,96,393,22]` — 顶部进度条左侧 66% 由靛蓝变橙 |

## 注入纪律核验

`node ../assert.mjs form` 的实测输出，三层断言全通过：

| ID | 字符串锚点 | 声明区块内 v1↔v2 变化像素 |
|---|---|---|
| F1 | ✓ v1 恰 1 次 / v2 0 次 | `actions` = 826 |
| F2 | ✓ | `seam-fields-checks` = 14382，`checks` = 14304 |
| F3 | ✓ | `title` = 7643 |
| F4 | ✓ | `field-country` = 3965，`fields` = 10622 |
| F5 | ✓ | `fields-top` = 6838，`fields` = 10622 |
| F6 | ✓ | `progress` = 3724 |

- **不越界**：实际发生变化的区块集合 == 上表声明区块的并集；`bar` 区块像素零变化。
- **无重叠**：6 处缺陷分落 6 个互不相交的归因区块。F2 的位移被底部按钮组上方的弹性空白吸收，只移动复选框组本身，不触及 `fields` 与 `actions`；`fields` = 10622 是 F4+F5 在这个大区块内的合计，子区块数字才是各自的独立量。
- F1 只有 826 px 变化——±6px 圆角天然只影响四个角，分区送检时必须用 `actions` 区块图。
- **v1 ↔ v2 HTML diff：23 行**（其中 4 行是版本标记；其余 19 行为 6 处缺陷，F5 整块字段对调占 8 行）。
- **v1 忠实度**：`design.png ↔ v1.png` 残余差异 240 / 1339344 px = **0.018%**（四组里最低），只落在返回箭头与下拉 chevron 的自绘笔画上。注意 v1 用的是真实 `<input>` / `<select>` / `<input type=checkbox>` 加 `appearance:none` 重置，与设计稿的 div 模拟件是两套完全不同的实现，渲染结果仍逐像素吻合。
