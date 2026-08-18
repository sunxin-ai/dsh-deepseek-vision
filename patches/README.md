# 本体补丁

`install.mjs` **默认就打这两处补丁**，不需要单独操作，也不需要告诉它 DSH 装在哪。
本文档说明它改了什么、为什么、以及自动打不上时怎么手工重做。

```sh
node install.mjs --route-only        # 打（幂等，已打过会跳过）
node install.mjs --revert-patches    # 还原
node install.mjs --no-patches ...    # 这次不打
```

**只有需要「在对话框里直接粘贴图片」时才需要这两处补丁。**
只用「文件路径 / URL / 附件 id + `deepseek_vision`」的话，加 `--no-patches`，插件独立可用。

两处改动**必须同时存在或同时还原**。只还原准入那一处是安全的（粘图回到被拒绝的原样）；
只还原序列化那一处会让图片撞上 `UNSUPPORTED_CONTENT`，那条会话再也走不下去。

## 一、`@deepseek-ai/dsh-host-apiproxy`：去掉图片准入拒绝

改 `src/api-proxy.ts`（源码运行）与 `lib/index.js`（npm 安装）里的同一段：删掉
`if (hasImage) { … MODEL_DOES_NOT_SUPPORT_IMAGES … }` 整块。

原逻辑在消息准入处直接拒绝，用户粘贴的图片连会话都进不去。移除后图片保留在持久消息里，
界面照常显示一张图。

## 二、`@deepseek-ai/dsh-llm-deepseek`：抛错换成文字指针

`assertTextOnly()` 换成 `replaceImagesWithPointers()`：图片块在序列化前的最后一刻变成一行

```
[图片 image/png 2940x1912 attachment=sha256:…]（本模型看不到图片内容。…）
```

调用点相应地从 `assertTextOnly(message.content)` 改成拷贝一份重写过的 message ——
**拷贝而不是就地改**：那个数组属于会话里的持久消息对象，就地改会让界面与后续压缩看到的
也变成文字，图就从气泡里消失了。

**为什么放在这一站**：这是消息通往 DeepSeek 的最后一步。此前每一站 —— 持久化、会话日志、
界面渲染 —— 看到的都还是真正的图片块，所以**用户在气泡里看到的是一张图**，证据也完整留档。
放在更早的位置（准入检查、`agent/pre-step`）替换，用户看到的就会变成一串路径而不是图。
对照组是 Kimi K3 这类多模态路由：那边不做任何替换、界面正常显示缩略图 —— 说明问题出在替换的位置，不在界面。

**补丁只打印附件 id，不推算任何文件路径。** 路径命名规则完整地留在插件一侧
（`src/index.ts` 的 `spillPath`），由 `deepseek_vision` 按 id 解析。早期两边各写一份规则，
改一边就静默失配（指针指向不存在的文件）；现在本体侧压根不知道有路径这回事。

文件由插件在 `agent/pre-step` 落盘 —— 那一步**只落盘，不改动任何内容块**。

## 脚本怎么找到 DSH

按 profile 的 `node_modules` 解析 `@deepseek-ai/dsh-host-apiproxy` 与
`@deepseek-ai/dsh-llm-deepseek`，`realpath` 之后就是包根目录。拿到的正是运行中的 dsh
实际加载的那份：npm 安装时是真实目录，源码运行时那里是指向仓库 workspace 的软链。
依次尝试的基点：`$DSH_HOME/profiles/<profile>`、`$DSH_HOME/profiles`、本包目录、PATH 上的 `dsh`。

**`DSH_REPO` 只是覆盖开关**，自动定位不对时才需要：

```sh
DSH_REPO=<DSH 源码仓库根> node install.mjs --route-only
```

一个包下 `src/*.ts` 与 `lib/index.js` 都存在时**两份都改**。无法可靠判断哪份是活的
（源码运行走 tsx + tsconfig paths → `src/`；npm 安装走 exports → `lib/index.js`），
而半打状态正是要消灭的失败模式。

## 匹配与备份

不用 `git apply`：那需要仓库、需要精确的上下文行，npm 装的 DSH 两样都没有。
改成按代码形态定位锚点 —— 以 `if (hasImage) {` 的缩进为界、以那句
`Reject core image content` 注释为界 —— 同一条正则同时命中 TS 源码与构建产物。

- **幂等**：改过的文件里留有 `DSH-DESIGN-QA-PATCH` 标记，见到就跳过。
- **备份**：改动前原文另存为 `<原文件名>.dsh-design-qa-orig`，`--revert-patches` 按字节拷回。
- **失败要响**：锚点找不到就打印 `✗` 并以非零码退出，绝不静默跳过 ——
  「装完粘图被拒、脚本却显示一切正常」是最难查的一类失败。

## 手工重做

自动打不上（上游改了那两处的写法）时照着上面两节改即可，改动本身很小：
一处是删掉一个 `if` 块，一处是把抛错换成返回文字指针。

要注入的完整代码就在 `install.mjs` 里 —— `ADMISSION`、`POINTER_FN`、`POINTER_CALL`
三个常量各自带着 TS 与构建产物两种形态的原文，直接抄。

改完想让脚本认账（后续能幂等跳过、能 `--revert-patches`），在改动处留一行含
`DSH-DESIGN-QA-PATCH` 的注释，并把改动前的原文另存为
`<原文件名>.dsh-design-qa-orig`。

## 升级 DSH 之后

被改的文件被新版覆盖，标记随之消失，表现是「粘图又被拒了」。重跑一次即可：

```sh
node install.mjs --route-only
```

## 官方发布多模态那天

补丁与插件都不需要改动，也不必移除：`routeAcceptsImages` 届时会判定路由接受图片，
`deepseek_vision` 自我拒绝并让位，图片直接进入模型上下文走官方原生通路。
