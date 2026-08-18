# dsh-design-qa

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**让 DeepSeek Harness 里的纯文本模型能看图。**

- **补上 DeepSeek 的能力缺口。** DSH 的图像通路本已完整，缺的只是一条声明了多模态的路由。
  官方多模态上线那天，本插件自动让位、可原样留着。
- **把识图做成一个 tool。** 图片不进主模型上下文；它看到一行 `[图片 …]` 提示，需要时自己调
  `deepseek_vision`。不看就不产生任何成本，问什么由模型自己决定。
- **附完整 eval，可自测。** 4 组夹具、23 处注入缺陷、四条通过线。换模型后重跑一遍就知道能不能用。

---

## 三步装好

**环境要求**：一个**已经能正常对话**的 DSH —— 也就是工作区选好了、主模型的 key 配好了，
随便发一句能收到回复。npm 安装或源码运行都可以，Node `^22.19 || >=24`（与 DSH 一致）。
macOS / Linux / Windows 通用，安装脚本是一份 Node 实现。

> 刚下载 DSH 还没配过的话先把这一步做完 —— 本插件只负责识图那条链路（`BAILIAN_API_KEY`），
> 主模型的 key 是 DSH 自己的事。两者分开：主模型不通，粘图也不会有反应。

### 1. 拿一个百炼 API Key

去 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 开通并创建 API-KEY。

**新用户每款模型送 100 万输入 + 100 万输出 Token，有效期 90 天**（[官方说明](https://help.aliyun.com/zh/model-studio/new-free-quota)）。
本插件一次识图约 2000 输入 + 400 输出 token，**免费额度够看几百次图**，日常用基本不花钱。

### 2. 装插件

```sh
dsh plugin --profile web add github:sunxin-ai/dsh-design-qa
```

### 3. 补配套并重启

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-design-qa"
export BAILIAN_API_KEY=<第 1 步拿到的 key>
node install.mjs --route-only
node install.mjs --restart          # 冷启动。HMR 是关的，刷新浏览器不算
```

装好了。**在对话框里粘一张图，直接问「这是啥」即可。**

> 图片走**粘贴或拖拽**进对话框 —— DSH 的输入框没有单独的上传按钮，
> 左下那个 `+` 是命令菜单不是附件入口，别去找。
> 也可以直接把图片的**绝对路径**或 **http(s) 地址**发给模型，让它自己调 `deepseek_vision`。

不需要告诉脚本 DSH 装在哪 —— 它从 profile 的 `node_modules` 自己解析出本体位置，
npm 装的和源码跑的都认。密钥也不经它的手，只写变量名 `apiKeyEnv: BAILIAN_API_KEY`。

<details>
<summary>第 3 步顺带改了 DSH 本体两处 —— 点开看改了什么、怎么还原</summary>

「在对话框里粘贴图片」这件事插件自己做不到：拦截在 `api-proxy` 的消息准入里，
而 `resolveModelInfo` 直接返回适配器自述、没有 waterfall，插件改不了 `llm-deepseek`
硬编码的 `inputModalities: ['text']`。所以只能改本体，两处：

| 落点 | 改动 |
|---|---|
| `dsh-host-apiproxy` | 删掉纯文本路由的图片准入拒绝（一个 `if` 块） |
| `dsh-llm-deepseek` | 序列化前把图片块换成一行 `[图片 … attachment=<id>]` 文字指针，不再抛错 |

改动前原文另存为 `<原文件名>.dsh-design-qa-orig`，一条命令还原：

```sh
node install.mjs --revert-patches
```

**完全不想动本体**就加 `--no-patches`。此时粘贴仍会被拒，但**给文件路径、图片 URL
或附件 id 让模型调 `deepseek_vision` 一样可用** —— 只是多贴一次路径。

细节见 [`patches/README.md`](patches/README.md)。

</details>

### 让 DSH 自己装

不想手敲的话，把下面这段整体发给 DSH，它有 bash，会自己跑完：

```text
装 dsh-design-qa，按这五步，不要自己发挥：

1. dsh plugin --profile web add github:sunxin-ai/dsh-design-qa
2. cd "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-design-qa"
3. export BAILIAN_API_KEY=<你的 key>      # 用 export，下一条命令也要用到它
4. node install.mjs --route-only
5. node install.mjs --restart      # 不要用 pkill，那会杀掉你自己

第 4 步会顺带改 DSH 本体两处（粘贴图片必须的），原文自动备份，
node install.mjs --revert-patches 可一键还原。把第 4 步的完整输出贴回给我。
```

**「不要自己发挥」这句请保留。** 三处最容易被自由发挥搞砸：

- **漏掉 `--route-only`** —— 会写进一条与 bundle 重复的插件行，DSH 启动直接抛
  `duplicate loader entry id`，**整个 profile 起不来**。脚本内置了防护会跳过，但不是所有 agent 都读得懂提示。
- **自己 `pkill` 重启** —— agent 通常就跑在那个要被重启的进程里，杀掉等于自杀，
  它拿不到结果也无法确认是否成功。`--restart` 立即返回，重启在它身后完成。
- **自己编一个 key** —— 脚本不代经手密钥，自检会明确报缺少 `BAILIAN_API_KEY`，它应当回来向你要。

**本体补丁没打成会以非零码退出**；缺 key、路由没写这类则是自检里的黄色告警（退出码仍为 0）。
所以别只看退出码 —— 让它把输出原样贴回来，看最后那段自检有没有黄字。

> DSH 的自修改工具（`cordis_define` / `cordis_run`）**不能**用来做持久安装 ——
> 那套是内存态的：不产生插件文件、不改 `cordis.yml`、重启即消失。持久安装必须落到文件，所以走上面这条。

---

## 引擎为什么是 Qwen：它通过了基准测试

不是随手挑的。[`eval/`](https://github.com/sunxin-ai/dsh-design-qa/tree/main/eval)
下有完整的基准规范与 4 组夹具（23 处缺陷），横评结论：

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
# 2) profile 的 cordis.patch.yml —— 覆盖插件行的 config
- id: design-qa
  config:
    provider: my-vision
    model: your-model-id
```

**注意这里不能写 `- insert:`。** 插件行已经由 bundle 层插好了，再 insert 一条同 id 的
不是覆盖而是**并存**，DSH 启动时抛 `duplicate loader entry id: design-qa`。
上面这种「给出 `id` + 要改的字段」的写法才是按 id 覆盖。

**唯一的硬性要求：那个模型必须真的支持多模态输入，且路由声明了 `input: [text, image]`。**
这是「对端点的声明，不是对端点的检查」（上游 JSDoc 原话）——
声明了但端点实际不收图，会在调用时被供应商拒绝，而不是在配置时报错。

换模型后建议用 [`eval/`](https://github.com/sunxin-ai/dsh-design-qa/tree/main/eval)
重跑一遍基准（只在 GitHub 仓库里，不随包分发），尤其看难档与零差异对照那两项：
**能看见 ≠ 可用**，一个召回高但幻觉多、或每次结论都漂移的模型会让判定循环发散。

## 工具

### `deepseek_vision(image_path, question)`

看一张图并回答问题。`image_path` 三选一：

- 文件绝对路径
- **http(s) 图片地址** —— 文档、网页里的图直接传 URL。走系统代理
  （`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`），上限 20 MB，跟随重定向
- 上下文 `[图片 …]` 提示里的附件 id（`attachment=<id>` 或裸 id 都行）

调用方**自己就是多模态模型时会被拒绝** —— 它直接看更准也更省，绕一手转述反而丢信息。
这同时是官方多模态上线时的自动让位机制：DeepSeek 声明 `image` 那天，本工具自己退出。

### 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `bailian` | 识图路由名，须声明 `input: [text, image]` |
| `model` | `qwen3.8-max` | 识图模型 |
| `maxTokens` | `4000` | 单次识图输出上限 |
| `reasoningEffort` | `off` | 读数式提问不需要思维链 |

## 提问方式决定成败

以下是实测结论，不是风格偏好。完整版在 [`skills/design-qa/SKILL.md`](skills/design-qa/SKILL.md)。

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

## 它什么时候该退休

DeepSeek 官方声明 `inputModalities` 含 `image` 的那天。

届时不需要改任何东西：`deepseek_vision` 查到调用方本身就能看图，会**自我拒绝并让位**，
图片直接进入模型上下文走官方原生通路。补丁与插件都可以原样留着，也可以直接卸载。

## 什么时候别用这个

只是想「随手看张图」——**用 modlens 更省事**，零配置、不改本体。

本插件的定位是**设计稿保真度判定**：要求每条结论可回溯到证据，
因此不惜多配一条路由、多改两处本体，换取图片走原生通路、判定可回放。
如果你不需要这个保证，这些成本就是纯负担。

---

## 参考

### `install.mjs` 的全部开关

```sh
node install.mjs [profile]         # 完整安装（不走 dsh plugin add 时用这条）
```

| 开关 | 作用 |
|---|---|
| `[profile]` | 目标 profile，默认 `web` |
| `--route-only` | 不写插件行。**用 `dsh plugin add` 装过就必须加**，见下 |
| `--no-patches` | 不改 DSH 本体。粘贴图片将仍被拒绝 |
| `--revert-patches` | 还原本体补丁并退出 |
| `--restart` | 只冷启动，可从 dsh 自己的进程内部调用 |
| `--force` | 无视重启前的体检拦截 |

环境变量（都只在自动探测不成时才需要）：

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 的家目录，默认 `~/.dsh` |
| `DSH_REPO` | DSH 源码仓库根。只在本体自动定位不对时给 |
| `DSH_PROCESS_PATTERN` | 用来认出 dsh 进程的命令行片段 |
| `DSH_CWD` | dsh 的工作目录。**Windows 上必须给** —— 那里既没有 `/proc` 也没有 `lsof` |
| `DSH_RESTART_CMD` | dsh 的完整启动命令 |

完整安装做六件事，全部幂等、改动前自动备份：软链 `node_modules` → 软链 skill →
写识图路由 → 写插件行 → 改本体 → 自检。

### 用 `dsh plugin add` 装过之后，`--route-only` 不能省

不加它会往 profile 的 `cordis.patch.yml` 再写一条同 id 的行，与 bundle 提供的那条撞车，
DSH 启动时直接抛 `duplicate loader entry id: design-qa`，**整个 profile 起不来** ——
不是插件加载失败，是 dsh 根本启动不了。
（脚本已内置防护：检测到本包已作为 bundle 装入就会跳过写入。）

### 安装后必须冷启动

**HMR 是关闭的**，插件、skill、profile 补丁、本体改动都不热加载，**刷新浏览器不算**：

```sh
node install.mjs --restart
```

它从运行中的进程读出原本的启动命令与工作目录再拉起，不会丢掉你启动时带的 `--patch` 参数；
并且**立即返回** —— 所以跑在 dsh 里的 agent 也能安全调用（自己 `pkill` 会把自己一起杀掉）。

新进程**继承调用方当前的环境**。杀旧进程之前先做三项体检，任一不过就停手并保留旧进程
（确认无妨可以 `--force`）：

- 实际要用的那个 `node` 不满足 DSH 的 `^22.19 || >=24`；
- 旧进程持有、而当前 shell 没有的密钥类环境变量（例如只 export 在另一个终端里的
  `BAILIAN_API_KEY`）—— 丢掉它会让插件「装好了却用不了」。只比对变量名，不读值；
- 读到的启动命令被切碎了。Linux 上取的是 `/proc` 里的精确 argv，不受影响；
  别的平台只拿得到用空格拼起来的命令行，参数里带空格时会切错 —— 此时用
  `DSH_RESTART_CMD` 显式给出完整命令。

新进程的输出写到 `$DSH_HOME/dsh-design-qa-restart.log`。

**Windows** 上还需要显式给 `DSH_CWD`，否则读不到工作目录、会拒绝重启。

### 改插件源码

`src/index.ts` 改完要建到 `lib/index.js`（DSH 加载的是构建产物）：

```sh
npx tsdown --entry src/index.ts --format esm --out-dir lib --dts false --no-config
```

注意 `install.mjs` 第 1 步会把本目录的 `node_modules` 换成指向 profile 的软链，
而 `npm install` 又会把它换回真目录 —— 两者互相拆台。所以构建工具建议用 `npx`
或装在别处，不要 `npm install` 到本目录。

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

### 卸载

```sh
node install.mjs --revert-patches                     # 1. 先还原本体补丁
dsh plugin --profile web remove dsh-design-qa   # 2. 插件行
rm -rf ~/.agents/skills/design-qa               # 3. skill 软链（Windows 上可能是复制的目录）
# 4. 从 $DSH_HOME/settings.yaml 里删掉 llm-pi-ai.providers.bailian 整段
```

**第 1 步不能漏，而且要放在最前面。** 只留序列化那处改动的话，粘图后模型会被告知去调一个
已经不存在的工具；插件先被摘掉的话，`--revert-patches` 也就跟着没了。

## 已知限制

- **本体改动不能自失效。** 补丁是磁盘上的文件改动，而卸载插件只摘掉插件行、不会去重写那些文件。
  所以卸载必须显式 `--revert-patches`，顺序见上面的卸载一节。
- **升级 DSH 会冲掉本体改动**（文件被新版覆盖）。表现是「粘图又被拒了」，重跑一次
  `node install.mjs --route-only` 即可。这也是有意的：新版 DSH 万一自己支持了图片，补丁不该悄悄留着。
  升级后即使备份文件还在，`--revert-patches` 也只会清掉那份过期备份、不会把新版文件覆盖回旧内容。
- **按代码形态定位锚点，不按版本号。** 上游改写了那两处时，脚本会**报错并列出文件**，
  而不是打半个补丁。两种形态都会被改到（源码运行的 `src/*.ts`、npm 安装的 `lib/index.js`）——
  无法可靠判断哪份是活的，宁可都改；源码仓库里因此会多出未跟踪的 `.dsh-design-qa-orig` 备份文件。
- **`attachment=<id>` 形式只在进程内有效**：id → 路径的索引是内存态，重启后失效，需改用文件路径。
- **未覆盖多图对比**：`deepseek_vision` 一次只看一张图。设计稿与实现的并排对比图需调用方自己拼。
- **私有文档的图取不到**：飞书、Notion 这类需要登录态的图片，直传 URL 会 401/403。
  需先用对应 skill 下载到本地再传路径。工具会在报错里指明这条路，但没有内建凭据通路。
- **自检是宽松匹配**：`settings.yaml` 由 DSH 的设置写入器维护并会规范化格式，
  因此自检只做模糊匹配 —— 它查的是「像不像配过」，不是「配得对不对」。
