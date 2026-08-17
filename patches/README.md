# 本地补丁

**只有需要「在对话框里直接粘贴图片」时才需要这两处补丁。**
只用「文件路径 / URL / 附件 id + `deepseek_vision`」的话，插件独立可用，跳过本目录。

`dsh-local.patch` 含**两处**改动，必须同时存在或同时还原。

## 一、`packages/host/apiproxy/src/api-proxy.ts`

去掉纯文本路由的图片准入拒绝。

原逻辑在消息准入处直接拒绝，用户粘贴的图片连会话都进不去。移除后图片保留在持久消息里，
界面照常显示一张图。

## 二、`packages/llm/llm-deepseek/src/serialize.ts`

`assertTextOnly()` 换成 `replaceImagesWithPointers()`：图片块在序列化前的最后一刻变成一行

```
[图片 image/png 2940x1912 attachment=sha256:…]
```

**为什么放在这一站**：这是消息通往 DeepSeek 的最后一步。此前每一站 —— 持久化、会话日志、
界面渲染 —— 看到的都还是真正的图片块，所以**用户在气泡里看到的是一张图**，证据也完整留档。
早期版本把替换放在 `agent/pre-step`，结果用户看到的是一串路径而不是图。
对照组是 Kimi K3 这类多模态路由：那边不做任何替换、界面正常显示缩略图 —— 说明问题出在替换的位置，不在界面。

**补丁只打印附件 id，不推算任何文件路径。** 路径命名规则完整地留在插件一侧
（`src/index.ts` 的 `spillPath`），由 `deepseek_vision` 按 id 解析。早期两边各写一份规则，
改一边就静默失配（指针指向不存在的文件）；现在本体侧压根不知道有路径这回事。

文件由插件在 `agent/pre-step` 落盘 —— 那一步**只落盘，不改动任何内容块**。

## 为什么不做成插件内的改动

`resolveModelInfo` 直接返回适配器自述，没有 waterfall，插件改不了 `llm-deepseek` 硬编码的
`inputModalities: ['text']`；准入检查本身也没有扩展点。

曾试过注册一条「不声明模态」的代理路由来绕开准入检查，两百行代码换来一道被绕过的安全检查，
不划算，已废弃。也试过让插件注册渲染器、补丁查表从而自失效 —— 行不通：插件在仓库外，
通过 profile 的 `node_modules` 解析 `@deepseek-ai/dsh-llm`（构建产物），而源码运行的 DSH
用的是仓库里那份，**两份是不同的模块实例，模块级状态不共享**。

## 应用与还原

```sh
# 应用（install.mjs --with-patches 会自动做，幂等）
git -C <DSH 仓库根> apply <本目录>/dsh-local.patch

# 还原
git -C <DSH 仓库根> apply -R <本目录>/dsh-local.patch
```

**移除本插件时必须一并还原**，否则图片会直达纯文本适配器的序列化拒绝
（`llm-deepseek/src/serialize.ts` 的 `assertTextOnly`），那条会话将无法继续。

只还原准入那一处是安全的（粘图回到被拒绝的原样）；只还原序列化那一处会让会话卡死。

## 升级 DSH 后重打

```sh
git -C <DSH 仓库根> apply <本目录>/dsh-local.patch
```

冲突时按上面两节的说明手工重做即可 —— 一处是删掉一个 if 块，一处是把抛错换成返回文字指针。

## 官方发布多模态那天

补丁与插件都不需要改动，也不必移除：`routeAcceptsImages` 届时会判定路由接受图片，
`deepseek_vision` 自我拒绝并让位，图片直接进入模型上下文走官方原生通路。
