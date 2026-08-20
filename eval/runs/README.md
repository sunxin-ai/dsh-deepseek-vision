# runs —— 基准数字的原始出处

这里是产生 README 基准结论的**未经编辑的模型输出**。

**不是每个数字都有原文。** 哪些没有、为什么没有，见文末「这批证据覆盖不到的地方」；
`../README.md` 里那张「提问方式」表另有说明，四种问法只有一种在脚本里实现过。

收进仓库的理由：这个项目的主张是「认真研究了裁判何时可信」。别人无法复核，主张就是空的。

跑于 2026-08-17。

## 两批实验，两组夹具

README 的结论来自两批实验，它们**用的不是同一组夹具**。读数时必须分开看。

| 目录 | 夹具 | 产出的结论 |
|---|---|---|
| `probe-mobile/` | mobile dashboard 393×852，随附于 `probe-mobile/fixture/` | 三模型横评表 24/24 · 21/24 · 18/24；难档 D1 稳定性 12/12 · 1/4 · 8/15 |
| `facets-landing/` | `../evalset/landing` 桌面落地页 1280×800 | 零差异对照 0 幻觉；逐保真面 30 格表态分布 |

**`probe-mobile/` 那组夹具不属于 `evalset/`。** 它是横评当时用的那一组，随附在
`probe-mobile/fixture/` 下（`prototype.png` 设计稿 + `v1.html` 忠实实现 + `v2.html` 注入版，
5 处注入 D1–D5，清单见 `SCORE.md`）。`evalset/` 下那 4 组是另一批夹具，
**横评表不是在 `evalset/` 上跑出来的** —— 拿 `evalset/` 复现不出那张表，这是夹具不同，不是结论不稳。

## 逐文件对照

`probe-mobile/` —— `tilebench.py` 的 `probe` 与 `judge` 两条命令，它们的区块常量
`REGIONS = ["header", "ring", "stats", "chart", "tabbar"]` 就是这组夹具的语义区块：

| 文件 | 出自 | 内容 |
|---|---|---|
| `_probe-bailian.txt` | `probe bailian qwen3.8-max` | 6 探针 × 5 模式 = 30 行。**横评表 qwen 一行的 24/24 = 6 探针 × 4 个真实模式**，第 5 个模式「空白图对照」是负对照，不计分 |
| `_probe-kimi.txt` | `probe kimi moonshot-v1-128k-vision-preview` | 同样 6 探针 × 4 个计分模式，**18/24**。这一轮的第 5 个模式是「整页拼图带标注」而非「空白图对照」，同样不计分 |
| `_judge-kimi.txt` + `moonshot-…__{v1,v2}__*.md` | `judge kimi` | 5 区块 × v1/v2 两 arm 的开放式判定逐格原文 |
| `tile.mjs` | —— | 把设计稿与实现切成分区对比图的生成器，区块选择器与上面的 `REGIONS` 一一对应 |

`facets-landing/` —— `facets` 与 `pairs` 两条命令。**这两条不硬编码夹具**：
它们遍历 `pairs/*.png`，从文件名 `{fixture}__{arm}__{region}.png` 解析，
区块描述查 `tilebench.py` 的 `REGION_NAMES`：

| 文件 | 出自 | 内容 |
|---|---|---|
| `_facets-bailian.txt` | `facets bailian qwen3.8-max` | 6 区块 × 5 保真面 × 3 arm = 90 行。`design` arm 30 格全报「一致」，**这就是零差异对照 0 幻觉的原始记录** |
| `_pairs-bailian.txt` + `qwen3.8-max__landing__*.md` | `pairs bailian qwen3.8-max` | 18 格开放式判定的逐格原文 |

`_models-bailian.txt` 是 `models bailian` 的输出，即选型当时账号上可用的模型池。

## 这批证据覆盖不到的地方

**`qwen3-vl-plus` 那一行（21/24、1/4）没有原始输出。** 它只以聚合数字的形式存在于
`SCORE.md` 第 208 行。横评表三行里，qwen3.8-max 与 moonshot 两行可逐格复核，这一行不能。

**通过线 2「幻觉 ≤ 1 条」在 `probe-mobile` 那组夹具上测不了。** 原因写在 `SCORE.md` 的
通过线复核表里：那组的 `v1.html` 本身就不忠实（图标画错、柱状图多了设计稿没有的标注），
模型报的「差异」大多为真，测不出幻觉率。零差异对照因此只在 `facets-landing` 上跑过，
**也就只有 qwen3.8-max 一个模型有幻觉率数据**，横评表另外两个模型没有。

**`judge` 那轮的文件名格式已经变了。** 这里的 `moonshot-…__v1__chart.md` 是三段式，
当前 `cmd_judge` 写的是 `{model}__{mode}__{arm}__{region}.md` 四段式，汇总文件也从
`_judge-{provider}.txt` 变成了 `_judge-{provider}-{mode}.txt`。重跑得到的是同样的
5 区块 × 2 arm，但文件名对不上，不要按名字做逐字节比对。

## 怎么重跑

分区对比图（`pairs/` `tiles/` `composite/`）是可再生的大体积中间产物，不随包分发。

`facets-landing`：

```sh
cd eval && npm i && npx playwright install chromium
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright"
node evalset/shoot.mjs --crops
node pair.mjs --left <design裁剪> --right <impl裁剪> --out pairs/landing__design__nav.png   # 逐区块
export BAILIAN_API_KEY=<key>
python3 tilebench.py facets bailian qwen3.8-max
python3 score_facets.py results3/_facets-bailian.txt
```

`probe-mobile`：先用 `runs/probe-mobile/tile.mjs` 从该目录下的夹具生成 `tiles/`，
再 `python3 tilebench.py probe bailian qwen3.8-max`。

## 为什么 SCORE.md 保留了作废的两轮

`SCORE.md` 顶部标着「第一、二轮结论已作废」，原文照样留着。

那两轮跑在空白图上（旧 `shoot.mjs` 的 `setContent` 没能加载 `file://` 子资源），
由此得出的「模型幻觉」「整页不可用」全是误读。留着它是因为**归因错误的过程本身是结论**：
`../README.md` 里「夹具会静默损坏」那条陷阱就是从这里来的，
而且当时被记成「编造分析」的那次，模型其实如实报告了图是空白的。

评测记录是实验日志，不是产品文档 —— 它的价值恰恰在于没有被事后修饰。
