# dsh-deepseek-vision

给纯文本 DSH 模型接上「义眼」——**一个短期方案，等 DeepSeek 官方多模态上线就该退休。**

## 一句话：DSH 早就支持，只是没有一条能看图的路由

DSH 的图像通路是**完整的**，不是待填的桩：

| 件 | 位置 | 状态 |
|---|---|---|
| `read_image` 工具 | `packages/fs/tool-fs/src/read-image.ts` | 完整实现，含 schema / render / 门禁 |
| `ImageBlock` | `packages/llm/llm/src/types.ts` | 完整，JSDoc 明说是 role-neutral、为前向兼容而设 |
| `AttachmentStore` | `packages/attachment/attachment/` | 完整服务：`saveImage` / `readImage` / `imageLimits` |
| 能力门禁 | `read-image.ts` 的 `assertImageCapableRoute` | 查 `resolveModelInfo(...).inputModalities` |

**唯一缺的是一条声明了 `input: [text, image]` 的供应商路由。** DeepSeek 自己的模型没声明
（`llm-deepseek/src/adapter.ts` 里 `inputModalities: ['text']` 是硬编码的），所以整条通路空转。

本插件做的就是**把这条路由配上，引擎换成 Qwen**。图片仍然走 DSH 原生的
`ctx.attachments` 内容寻址存储与 `ImageBlock`，与用户上传的图同一生命周期，
判定可从会话日志完整回放 —— 不自建任何图片通道。

> 生态里同类插件（modlens、dsh-vision-toolkit 等，都是数百到上千星的项目）都自建通道、并替模型看完再注入描述。
> 本插件反过来：走官方通路，并把「要不要看、看什么」交还给模型 —— 不看就不产生任何识图成本。

## 引擎为什么是 Qwen：它通过了基准测试

不是随手挑的。[`eval/`](eval/README.md) 下有完整的基准规范与 4 组夹具（23 处缺陷），横评结论：

| 模型 | 定向探针 | 难档（字重 800 vs 500） |
|---|---|---|
| **`qwen3.8-max`** | **24/24** | **12/12 方向全对** |
| `qwen3-vl-plus` | 21/24 | 1/4 |
| `moonshot-v1-128k-vision` | 18/24 | 8/15 ≈ 随机 |

零差异对照（把设计稿和它自己配对，报出任何差异都是幻觉）：**`qwen3.8-max` 6/6 全报一致，0 条幻觉。**

`qwen3.8-max` 是唯一在难档上稳定的 —— 另外两家在字重方向上等同掷硬币，
而**方向错的判断比漏检更危险**，它会让修复朝反方向走。

## 换成别的模型

**默认值只是默认值。** 插件对模型没有任何硬编码假设，换供应商只改两处：

```yaml
# 1) $DSH_HOME/settings.yaml —— 加一条你自己的路由
llm-pi-ai:
  providers:
    my-vision:
      api: openai-completions
      baseURL: https://your-endpoint/v1
      apiKeyEnv: MY_VISION_API_KEY
      models:
        - id: your-model-id
          input: [text, image]      # ← 必须有，否则被门禁拒绝
```

```yaml
# 2) profile 的 cordis.patch.yml —— 指过去
- insert:
    - id: deepseek-vision
      name: '<本目录>/src/index.ts'
      config:
        provider: my-vision
        model: your-model-id
```

**唯一的硬性要求：那个模型必须真的支持多模态输入，且路由声明了 `input: [text, image]`。**
这是「对端点的声明，不是对端点的检查」（上游 JSDoc 原话）——
声明了但端点实际不收图，会在调用时被供应商拒绝，而不是在配置时报错。

换模型后建议用 [`eval/`](eval/README.md) 重跑一遍基准，尤其看难档与零差异对照那两项：
**能看见 ≠ 可用**，一个召回高但幻觉多、或每次结论都漂移的模型会让判定循环发散。

## 它什么时候该退休

DeepSeek 官方声明 `inputModalities` 含 `image` 的那天。

届时不需要改任何东西：`deepseek_vision` 查到调用方本身就能看图，会**自我拒绝并让位**，
图片直接进入模型上下文走官方原生通路。补丁与插件都可以原样留着，也可以直接卸载。

## 什么时候别用这个

只是想「随手看张图」——**用 modlens 更省事**，零配置、不改本体。

本插件的定位是**设计稿保真度判定**：要求每条结论可回溯到证据，
因此不惜多配一条路由、多打两处本体补丁，换取图片走原生通路、判定可回放。
如果你不需要这个保证，这些成本就是纯负担。

## 安装

分两步：**装插件**（DSH 原生的 `dsh plugin`），**补配套**（路由 / skill / 可选补丁）。

### 第一步：装插件

```sh
dsh plugin --profile web add github:sunxin-ai/dsh-deepseek-vision
```

建议钉住 commit，避免上游变动打断你的环境：

```sh
dsh plugin --profile web add github:sunxin-ai/dsh-deepseek-vision#<commit-sha>
```

`dsh plugin` 会读本包 `package.json` 的 `dsh.bundle.patch`，自动把本包追加进 profile 的
`dsh.profile.bundles`，插件行由包内 `cordis.patch.yml` 提供。验证：

```sh
dsh --profile web --dump-config | grep deepseek-vision
```

### 卸载

`dsh plugin remove` 只摘插件行，另外三样要手工清：

```sh
dsh plugin --profile web remove dsh-deepseek-vision   # 1. 插件行
rm -f ~/.agents/skills/deepseek-vision                # 2. skill 软链（不删会变悬空链，DSH 会忽略但脏）
# 3. 从 $DSH_HOME/settings.yaml 里删掉 llm-pi-ai.providers.bailian 整段
git -C <DSH 源码仓库根> apply -R <包目录>/patches/dsh-local.patch   # 4. 若装过本体补丁
```

**第 4 步不能漏。** 只留序列化那处补丁的话，粘图后模型会被告知去调一个已经不存在的工具。

### 第二步：补配套

`dsh plugin add` 只装插件行，**不会**帮你配识图路由、装 skill、打本体补丁。这三样用：

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-deepseek-vision"
export BAILIAN_API_KEY=<你的百炼 key>
node install.mjs --route-only                      # 路由 + skill
DSH_REPO=<DSH 源码仓库根> node install.mjs --route-only --with-patches   # 再加上「粘贴图片」所需的本体补丁
```

**`--route-only` 不能省。** 不加它会往 profile 的 `cordis.patch.yml` 再写一条同 id 的行，
与 bundle 提供的那条撞车，DSH 启动时直接抛 `duplicate loader entry id: deepseek-vision`，
**整个 profile 起不来** —— 不是插件加载失败，是 dsh 根本启动不了。
（脚本已内置防护：检测到本包已作为 bundle 装入就会跳过写入。）

### 从本地目录装（开发时）

不走 GitHub 的话，clone 下来直接跑完整安装：

```sh
export BAILIAN_API_KEY=<你的百炼 key>
node install.mjs [profile]                    # 五步全做，含写插件行
DSH_REPO=<DSH 源码仓库> node install.mjs --with-patches
```

它做五件事，全部幂等、改动前自动备份：软链 `node_modules` → 软链 skill →
写识图路由 → 写插件行 → 自检。**不代经手密钥**（只写 `apiKeyEnv` 变量名）。

> ### ⚠️ 安装后必须冷启动
>
> **HMR 是关闭的**，插件、skill、profile 补丁都不热加载，**刷新浏览器不算**。用这条：
>
> ```sh
> node install.mjs --restart
> ```
>
> 它从运行中的进程读出原本的启动命令与工作目录再拉起，不会丢掉你启动时带的 `--patch` 参数；
> 并且**立即返回** —— 所以跑在 dsh 里的 agent 也能安全调用，自己 `pkill` 会把自己一起杀掉。

### 识图路由长什么样

`install.mjs` 会写进 `$DSH_HOME/settings.yaml`；手工配的话：

```yaml
llm-pi-ai:
  providers:
    bailian:
      displayName: 阿里百炼
      apiKeyEnv: BAILIAN_API_KEY      # 只写变量名，密钥不落盘
      api: openai-completions
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      compat:
        thinkingFormat: qwen          # 不能省，见下
      models:
        - id: qwen3.8-max
          input: [text, image]        # ← 打开图像门禁的那一行
          contextWindow: 262144
          maxTokens: 8192
          reasoningEfforts:
            off:
            high: high
```

`input: [text, image]` 会成为 `LlmModel.inputModalities`，DSH 的图像门禁查的正是它。

**`thinkingFormat: qwen` 不能省。** 不关思维时一次读数会产生 5000+ 字推理
（1582 输出 token，关掉后只要 14），读数结果完全相同 —— 113 倍的无谓开销。

### 关于粘贴图片（可选）

只用「文件路径 / URL / 附件 id」的话跳过。要让**对话框里粘贴的图**能用，
需要给 DSH 本体打两处补丁，见 [`patches/README.md`](patches/README.md)。上游片段的归属见 [NOTICE](NOTICE)。
**两处必须同时存在或同时还原。**

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `bailian` | 识图路由名，须声明 `input: [text, image]` |
| `model` | `qwen3.8-max` | 识图模型 |
| `maxTokens` | `4000` | 单次识图输出上限 |
| `reasoningEffort` | `off` | 读数式提问不需要思维链 |

## 工具

### `deepseek_vision(image_path, question)`

看一张图并回答问题。`image_path` 三选一：

- 文件绝对路径
- **http(s) 图片地址** —— 文档、网页里的图直接传 URL
- 上下文 `[图片 …]` 提示里的附件 id（`attachment=<id>` 或裸 id 都行）

调用方**自己就是多模态模型时会被拒绝** —— 它直接看更准也更省，绕一手转述反而丢信息。
这同时是官方多模态上线时的自动让位机制：DeepSeek 声明 `image` 那天，本工具自己退出。

## 提问方式决定成败

以下是实测结论，不是风格偏好。完整版在 `skills/deepseek-vision/SKILL.md`。

| 提问形式 | 零差异对照的幻觉 | 难档缺陷召回 |
|---|---|---|
| 「你自己找差异」 | 0/30 | 0/2 |
| 「这个方面有区别吗」 | 0/30 | 0/2 —— 判定题，模型默认答否 |
| 「哪个更大」 | 0/36 | 1/2 —— 留白类被系统性答反 3/3 |
| **「各自是多少」** | **0/12** | **2/2** |

同一个模型、同一批图，**召回从 0/2 走到 2/2，幻觉全程为 0**。换的只是问法。

**读数方向可信，量级不可信**：字重真值 800/500 读作 800/700，间距 80/25 读作 72/38 ——
被测侧总被拉向参照侧。用它判断「有没有差异、往哪个方向」，不要当测量值；
实现侧的精确值用 `getComputedStyle` 或像素测量取得。

## 成本

图像 token ≈ 像素数 / 1024（实测 1023–1127 px/token，与长宽比无关）。

| | 均值 | 区间 |
|---|---|---|
| 单次判定 | 0.037 元 | 0.027 – 0.051 元 |
| 延迟 | 9.0s | 6.6 – 11.6s |

**看一次图约 4 分钱。** 单价按 12 元/百万输入、36 元/百万输出估算，上线前请在控制台核对。

## Known Limitations and Deferred Work

- **本体补丁不能自失效。** 曾尝试让插件注册渲染器、补丁查表，从而在插件卸载后自动退回原行为。
  行不通：插件在仓库外，通过 profile 的 `node_modules` 解析 `@deepseek-ai/dsh-llm`（构建产物），
  而源码运行的 DSH 用的是仓库里那份 —— **两份是不同的模块实例，模块级状态不共享**。
  要做到需把本插件搬进仓库 workspace 当一个包。
- **`attachment=<id>` 形式只在进程内有效**：id → 路径的索引是内存态，重启后失效，需改用文件路径。
- **未覆盖多图对比**：`deepseek_vision` 一次只看一张图。设计稿与实现的并排对比图需调用方自己拼。
- **私有文档的图取不到**：飞书、Notion 这类需要登录态的图片，直传 URL 会 401/403。
  需先用对应 skill 下载到本地再传路径。工具会在报错里指明这条路，但没有内建凭据通路。
- **`install.mjs` 的自检是宽松匹配**：`settings.yaml` 由 DSH 的设置写入器维护并会规范化格式
  （实测 `[text, image]` 被重写成 `[ text, image ]`），因此自检只做模糊匹配，
  不保证路由字段语义正确 —— 它查的是「像不像配过」，不是「配得对不对」。
