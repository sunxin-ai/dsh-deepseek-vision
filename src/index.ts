/**
 * dsh-design-qa —— 给纯文本模型接上「义眼」，用于设计稿与前端实现的保真度判定。
 *
 * **主模型始终是纯文本的，图片从不进入它的上下文。**
 *
 * DeepSeek 的 chat-completions 适配器在序列化时就会拒绝图片内容
 * （`llm-deepseek/src/serialize.ts` 的 `assertTextOnly`），所以「让图片进上下文」在物理上不可行，
 * 各层门禁只是把这个必然的失败提前告知。硬把图片放行的后果不是变宽松，而是会话从此接不下去。
 *
 * 因此本插件的做法是：图片块在**序列化前的最后一刻**换成一行文字指针（由 `llm-deepseek`
 * 的本地补丁完成），模型看到「有这么一张图，在这里」，需要看时自己调 `deepseek_vision`。
 *
 * 替换点必须放在最后一站：此前每一站 —— 持久化、会话日志、界面渲染 —— 看到的都还是真正的
 * 图片块，所以**用户在气泡里看到的仍是一张图**。放在更早的位置（准入检查、`agent/pre-step`）
 * 会让用户看到一串路径。本插件在 `agent/pre-step` 只做一件事：把图片落盘，不动任何内容块。
 *
 * 识图成本只在模型真的要看时才产生；问什么问题由模型自己决定 ——
 * 读数式提问的完整纪律写在 skill 里，不写死在工具里；工具描述只保留两条硬约束：
 * 一次问完（每次调用都要重送整张图，按像素计费），以及结果与印象冲突时以工具为准
 * （否则模型会把图下下来自己数像素，实测一次这样的自查要 14 步、24 万输入 token）。
 *
 * 图片本身仍走 `ctx.attachments` 内容寻址落库，与用户上传的图同一生命周期，证据可从会话日志回放。
 * 生态里的同类插件（modlens、dsh-vision-toolkit 等）都自管图片流并替模型看完再注入描述；
 * 本插件把「要不要看、看什么」交还给模型。
 *
 * 提问一律是**读数式**，不是「有区别吗」，也不是「哪个更大」。这不是风格偏好，是实测结论：
 *
 * | 提问形式 | 零差异对照的幻觉 | 难档缺陷召回 |
 * |---|---|---|
 * | 「你自己找差异」        | 0/30 | 0/2 |
 * | 「这个方面有区别吗」    | 0/30 | 0/2 —— 判定题，默认答否 |
 * | 「哪个更大」            | 0/36 | 1/2 —— 留白类被系统性答反 3/3 |
 * | **「各自是多少」**      | 0/12 | **2/2** |
 *
 * 三条伪影的细节见 `skills/design-qa/SKILL.md`。
 *
 * 读数的**方向**可信，**量级**不可信：实测字重真值 800/500 读作 800/700，
 * 间距 80/25 读作 72/38 —— B 侧被拉向 A 侧。因此本插件只判定「是否存在差异」，
 * 绝不把读数当测量值上报；实现侧的精确值应由调用方用 `getComputedStyle` 或像素测量取得。
 *
 * @module dsh-design-qa
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-design-qa'

/** `tools` 注册工具，`llm` 发起识图调用，`attachments` 提供图片的持久化通路。 */
export const inject = ['tools', 'llm', 'attachments'] as const

/** `read_image` 接受的扩展名到媒体类型；字节层校验仍由 attachment 服务负责。 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 插件配置：识图走哪条路由，以及数值型度量判定「有差异」的阈值。 */
export interface Config {
  /** 识图供应商路由名，须在 `llm-pi-ai` 的 providers 里声明且 `input` 含 `image`。 */
  provider: string
  /** 识图模型 id。 */
  model: string
  /**
   * 单次识图的输出上限。读数式提问的回答只有十几个 token，而「描述整张截图」动辄上千，
   * 所以按最长的那类留余量；问得越具体，回答越短也越可靠。
   */
  maxTokens: number
  /**
   * 识图调用使用的 reasoning effort。读数式提问不需要思维链：
   * 实测同一次读数，思维开启产生 5165 字推理（1582 输出 token），关闭后仅 14 token —— 113 倍差距，
   * 而两者的读数完全相同。路由须把该档位声明在模型的 `reasoningEfforts` 里，否则调用会被拒绝。
   */
  reasoningEffort: string
}

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().default('bailian').description('识图供应商路由名'),
  model: Schema.string().default('qwen3.8-max').description('识图模型 id'),
  maxTokens: Schema.natural().default(4000).description('单次识图的输出上限'),
  reasoningEffort: Schema.string().default('off').description('识图调用的 reasoning effort；读数式提问用 off'),
})

/**
 * 断言目标路由声明了 image 输入。与 `read_image` 的门禁同源：查的是
 * `resolveModelInfo(provider, model).inputModalities`。
 * @param ctx - 提供 `llm` 服务的上下文。
 * @param config - 识图路由配置。
 * @param signal - 可选取消信号。
 * @throws 路由未声明 image 输入时抛出，错误信息给出可直接照抄的配置片段。
 */
async function assertVisionRoute(ctx: Context, config: Config, signal?: AbortSignal): Promise<void> {
  const info = await ctx.llm.resolveModelInfo(config.provider, config.model, signal)
  if (info.inputModalities?.includes('image') !== true) {
    throw new Error(
      `dsh-design-qa: 路由 "${config.provider}/${config.model}" 未声明 image 输入。`
      + ` 在 $DSH_HOME/settings.yaml 的 llm-pi-ai.providers 下补上该路由，并在其 models 条目里写 input: [text, image]；`
      + ' 未声明 image 的路由会被图像通路的门禁拒绝，这与 read_image 的行为一致。',
    )
  }
}

/**
 * 把一张本地图片存入 attachment 服务，换回可进模型上下文的引用。
 * @param ctx - 提供 `attachments` 服务的上下文。
 * @param path - 图片的绝对路径。
 * @returns 持久化后的图像引用。
 * @throws 扩展名不是受支持的图片格式，或部署的 attachment 策略不接受该媒体类型。
 */
async function commitImage(ctx: Context, path: string) {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
  if (mediaType === undefined) {
    throw new Error(
      `dsh-design-qa: "${path}" 不是 PNG/JPEG/WebP/GIF。`
      + ' image_path 接受三种形式：文件绝对路径、http(s) 图片地址、'
      + '或上下文里 `[图片 …]` 提示中的附件 id（带不带 attachment= 前缀都可以）。',
    )
  }
  if (!ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`dsh-design-qa: 本部署不接受 ${mediaType} 图片`)
  }
  let data
  try {
    data = await readFile(path)
  } catch (error: unknown) {
    // 裸 ENOENT 不说明该怎么办，而其它失败路径都给了三种入参形式的提示。
    throw new Error(
      `dsh-design-qa: 读不到 "${path}"：${error instanceof Error ? error.message : String(error)}。`
      + ' image_path 接受三种形式：文件绝对路径、http(s) 图片地址、'
      + '或上下文 `[图片 …]` 提示中的附件 id（带不带 attachment= 前缀都可以）。',
      { cause: error },
    )
  }
  return ctx.attachments.saveImage({ data, mediaType, name: basename(path) })
}

/**
 * 向识图路由发一次带图请求，返回纯文本输出。
 * @param ctx - 提供 `llm` 与 `attachments` 服务的上下文。
 * @param config - 识图路由配置。
 * @param imagePath - 图片的绝对路径。
 * @param prompt - 提问。
 * @param signal - 可选取消信号。
 * @returns 模型输出的文本。
 * @throws 调用失败或输出被 `maxTokens` 截断时抛出。
 */
async function askVision(
  ctx: Context,
  config: Config,
  imagePath: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const ref = await commitImage(ctx, imagePath)
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    reasoningEffort: config.reasoningEffort,
    messages: [createUserMessage({
      content: [{ type: 'image', attachment: ref }, { type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: name },
    })],
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  // 必须检查终止原因：失败时 blocks() 返回空数组而不抛错，
  // 不看 finish 就会把「调用失败」读成「模型没说话」。
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`dsh-design-qa: 识图调用失败（${finish.failure.code}）：${finish.failure.message}`)
  }
  if (finish.kind === 'max-tokens') {
    throw new Error(
      `dsh-design-qa: 识图输出被 maxTokens=${config.maxTokens} 截断。`
      + '请调高插件配置的 maxTokens，或把问题问得更具体 —— 具体问题的回答本来也更短、更可靠。',
    )
  }
  return assembler.blocks()
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * 图片落盘目录。命名规则完整地留在本文件 —— `llm-deepseek` 的本地补丁只打印附件 id，
 * 不推算路径，因此改这里不会与本体失配 —— 两边各写一份规则的话，改一边就会静默失配。
 *
 * 附件 id 形如 `sha256:<hex>`，冒号在 APFS 上合法但在别处不是，统一替换。
 */
const SPILL_DIR = join(tmpdir(), 'dsh-design-qa')

/** 附件 id → 落盘路径，由 {@link spillImages} 填充，{@link resolveImageArg} 查询。 */
const spilled = new Map<string, string>()

/** 由附件 id 与媒体类型推出落盘路径。 */
function spillPath(attachmentId: string, mediaType: string): string {
  const extension = Object.entries(IMAGE_MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? '.png'
  return join(SPILL_DIR, `${attachmentId.replace(/[^a-zA-Z0-9._-]/g, '-')}${extension}`)
}

/**
 * 远程图片的下载上限。识图按像素计费，超大图既贵又会被降采样。
 * 先看 `Content-Length`，没有那个头就边收边数，收满上限即断开 ——
 * 不把一张几百 MB 的图整个拉完再判。
 */
const MAX_REMOTE_BYTES = 20 * 1024 * 1024

/** 取图的超时。图站慢是常态，但吊死一个工具调用更糟。 */
const REMOTE_TIMEOUT_MS = 20_000

/** 环境变量取值，大小写两种写法都认（POSIX 下 `http_proxy` 与 `HTTP_PROXY` 都有人用）。 */
function envValue(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name] ?? process.env[name.toLowerCase()]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * 该地址要不要走代理，走哪个。
 * @param target - 目标地址。
 * @returns 代理地址；`NO_PROXY` 命中或没配代理时返回 undefined。
 */
function proxyFor(target: URL): URL | undefined {
  for (const rule of (envValue('NO_PROXY') ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    if (rule === '*') return undefined
    const bare = rule.replace(/^\./, '')
    if (target.hostname === bare || target.hostname.endsWith(`.${bare}`)) return undefined
  }
  const raw = target.protocol === 'https:'
    ? envValue('HTTPS_PROXY', 'ALL_PROXY')
    : envValue('HTTP_PROXY', 'ALL_PROXY')
  if (raw === undefined) return undefined
  try {
    return new URL(/^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    return undefined
  }
}

/** 代理的 Basic 认证头；代理地址里没带用户名就没有这个头。 */
function proxyAuth(proxy: URL): Record<string, string> {
  if (proxy.username === '') return {}
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)
  return { 'proxy-authorization': `Basic ${token.toString('base64')}` }
}

/** 一次 GET 的结果。 */
interface RemoteResponse {
  status: number
  contentType: string
  data: Buffer
}

/** 超限时抛这个，让调用方能给出带具体字节数的提示。 */
class TooLargeError extends Error {
  constructor(readonly bytes: number) { super('too large') }
}

/**
 * 取一个 http(s) 地址的字节，**按系统代理走**。
 *
 * 不用内置 `fetch`：Node 的 fetch（undici）默认不认 `HTTP_PROXY` / `HTTPS_PROXY`，
 * 那要靠**启动时**的 `NODE_USE_ENV_PROXY=1`，而 DSH 怎么启动不归本插件管。
 * 于是在代理后面的机器上，每个外网图片地址都会以一句没有线索的 `fetch failed` 收场 ——
 * 而「文档里的图直接传 URL」正是本工具的主用法之一。
 *
 * 两种代理情形分开处理：http 目标把绝对 URL 交给代理即可；
 * https 目标要先 `CONNECT` 打隧道，再在隧道上做 TLS。
 * @param rawUrl - 目标地址。
 * @param hops - 已跟随的重定向次数，防止环。
 */
function getRemote(rawUrl: string, hops = 0): Promise<RemoteResponse> {
  return new Promise((resolveWith, rejectWith) => {
    const target = new URL(rawUrl)
    const secure = target.protocol === 'https:'
    const port = Number(target.port) || (secure ? 443 : 80)
    const proxy = proxyFor(target)
    const headers = { host: target.host, accept: 'image/*,*/*;q=0.8', 'user-agent': 'dsh-design-qa' }
    const path = `${target.pathname}${target.search}`

    // 挂钟兜底。socket 级的 setTimeout 只对「连上之后不动」有效，
    // 而握手阶段卡住时它未必触发 —— 工具调用吊死比取图失败糟得多，所以再加一道硬闸。
    const open: { destroy: () => void }[] = []
    let done = false
    const guard = setTimeout(() => {
      for (const handle of open) { try { handle.destroy() } catch { /* 已经关了 */ } }
      fail(new Error('ETIMEDOUT'))
    }, REMOTE_TIMEOUT_MS)
    function settle(value: RemoteResponse): void {
      if (done) return
      done = true
      clearTimeout(guard)
      resolveWith(value)
    }
    function fail(error: unknown): void {
      if (done) return
      done = true
      clearTimeout(guard)
      rejectWith(error)
    }

    const onResponse = (response: import('node:http').IncomingMessage): void => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume()
        if (hops >= 5) { fail(new Error('重定向次数过多')); return }
        getRemote(new URL(location, target).href, hops + 1).then(settle, fail)
        return
      }
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) {
        response.destroy()
        fail(new TooLargeError(declared))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_REMOTE_BYTES) { response.destroy(); fail(new TooLargeError(size)); return }
        chunks.push(chunk)
      })
      response.on('end', () => settle({
        status,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0].trim(),
        data: Buffer.concat(chunks),
      }))
      response.on('error', fail)
    }

    const onError = (error: unknown): void => {
      const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? '未知错误'
      fail(new Error(
        `dsh-design-qa: 连不上 ${target.origin}（${code}）`
        + (proxy === undefined
          ? '。'
          // 走代理时拿不到真正的 DNS 错误：代理先回 200 建好隧道、再把隧道 reset，
          // 于是「域名拼错」和「网络不通」在这一层看起来一模一样，只能都提一句。
          : `，用的代理是 ${proxy.origin}（经代理时域名拼错也会报成连接被重置，先核对地址）。`)
        + ' 网络不通或该站点需要登录态时，最省事的办法是**先把图下载到本地，再把本地路径传给本工具**，'
        + '例如 `curl -L -o /tmp/x.png <地址>`。'
        + ' 不要改用读源码、猜内容或自己做像素分析来代替看图 —— 那既慢又不可靠。',
      ))
    }

    const arm = (request: import('node:http').ClientRequest): void => {
      open.push(request)
      request.on('error', onError)
      request.setTimeout(REMOTE_TIMEOUT_MS, () => request.destroy(new Error('ETIMEDOUT')))
      request.end()
    }

    if (proxy === undefined) {
      arm((secure ? httpsRequest : httpRequest)({ hostname: target.hostname, port, path, headers }, onResponse))
      return
    }
    const proxyPort = Number(proxy.port) || 80
    if (!secure) {
      // http 目标：绝对 URL 直接交给代理。
      arm(httpRequest({ hostname: proxy.hostname, port: proxyPort, path: target.href, headers: { ...headers, ...proxyAuth(proxy) } }, onResponse))
      return
    }
    // https 目标：CONNECT 建隧道，拿到裸 socket 后在其上做 TLS。
    const tunnel = httpRequest({
      method: 'CONNECT',
      hostname: proxy.hostname,
      port: proxyPort,
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, ...proxyAuth(proxy) },
    })
    open.push(tunnel)
    tunnel.on('connect', (proxyResponse, socket) => {
      open.push(socket)
      if (proxyResponse.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`dsh-design-qa: 代理 ${proxy.origin} 拒绝了 CONNECT（HTTP ${proxyResponse.statusCode}）。请检查代理设置或改用本地文件路径。`))
        return
      }
      // ALPNProtocols 不能省。走 https.Agent 的常规请求会自带它，而这里是在隧道的
      // 裸 socket 上手动做 TLS —— 不声明的话，部分服务端（实测 www.baidu.com）
      // 的握手会**永久挂住**：没有报错、没有 RST，就是不回 ServerHello。
      arm(httpsRequest({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
        hostname: target.hostname,
        port,
        path,
        headers,
        agent: false,
      }, onResponse))
    })
    tunnel.on('error', onError)
    tunnel.setTimeout(REMOTE_TIMEOUT_MS, () => tunnel.destroy(new Error('ETIMEDOUT')))
    tunnel.end()
  })
}

/**
 * 下载一张远程图片到落盘目录。
 *
 * 文档（飞书、Notion、网页）里的图片是 URL，既不是本地文件也不是 DSH 附件，
 * 没有这条路径时模型只能看到一个 `<img>` 标签而无从下手。
 *
 * 只接受 `Content-Type: image/*`：URL 来自文档正文，属于外部内容，
 * 拿回来的若不是图片就直接拒绝，不猜也不落盘。
 * @param url - http/https 图片地址。
 * @returns 落盘后的绝对路径。
 * @throws 请求失败、类型不是图片、或超过 {@link MAX_REMOTE_BYTES} 时抛出。
 */
async function fetchRemoteImage(url: string): Promise<string> {
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  const response = await getRemote(url).catch((error: unknown) => {
    if (error instanceof TooLargeError) {
      throw new Error(
        `dsh-design-qa: 图片 ${mb(error.bytes)}，超过上限 ${mb(MAX_REMOTE_BYTES)}。`
        + ' 识图按像素计费，超大图既贵又会被降采样。请先裁剪或压缩到上限以内再传，'
        + '或只截取你真正要看的那一块 —— 局部图的判定精度本来也更高。',
      )
    }
    throw error
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `dsh-design-qa: 下载图片失败 HTTP ${response.status}。`
      + ' 若该图需要登录态（飞书、Notion 等私有文档），请先用对应的 skill 或带凭据的命令把它下载到本地，再把本地路径传给本工具。',
    )
  }
  const contentType = response.contentType
  // 必须在受支持的类型表里，不能只判 image/*：SVG 之类会被下面的扩展名反查兜底成 .png，
  // 于是 attachment 服务报「声明类型与字节不符」，而真正的原因是「不支持这个格式」。
  const mediaType = Object.values(IMAGE_MEDIA_TYPES).includes(contentType as ImageMediaType)
    ? contentType as ImageMediaType
    : undefined
  if (mediaType === undefined) {
    throw new Error(
      `dsh-design-qa: ${url} 返回的是 ${contentType || '未知类型'}，`
      + '只支持 PNG / JPEG / WebP / GIF。'
      + (contentType.includes('svg') ? ' SVG 等矢量格式请先转成位图再传。' : ' 请确认该地址直接指向图片文件，而不是包含图片的网页。'),
    )
  }
  const data = response.data
  await mkdir(SPILL_DIR, { recursive: true })
  // 用 URL 的哈希命名，同一张图重复取只写一次。
  const name = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const extension = Object.entries(IMAGE_MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? '.png'
  const path = join(SPILL_DIR, `remote-${name}${extension}`)
  await writeFile(path, data)
  return path
}

/**
 * 解析工具收到的图片参数：文件路径、`attachment=<id>`、或 http(s) 图片地址。
 * @param raw - 工具参数原值。
 * @returns 可读取的绝对路径。
 * @throws 该 id 没有落盘记录时抛出，并说明它只在图片出现过的会话里有效。
 */
async function resolveImageArg(raw: string): Promise<string> {
  const trimmed = raw.trim()
  if (/^https?:\/\//i.test(trimmed)) return fetchRemoteImage(trimmed)
  // 附件 id 三种写法都收：`attachment=<id>`、`attachment:<id>`、以及裸 id。
  // 模型第一次往往传裸 id —— 那本来就毫无歧义（不含路径分隔符、格式固定 `sha256:…`），
  // 强制它记住前缀只会白白浪费一次往返。工具该宽进，把「猜语法」的负担从模型这边拿掉。
  const id = /^attachment[=:]\s*(\S+)$/.exec(trimmed)?.[1] ?? trimmed
  const hit = spilled.get(id)
  if (hit !== undefined) return hit
  // 长得像附件 id 却查不到 → 按附件报错；否则当作文件路径继续往下走。
  if (!id.includes('/') && !id.includes('\\') && /^[a-z0-9]+:/i.test(id)) {
    throw new Error(
      `dsh-design-qa: 附件 ${id} 没有落盘记录。`
      + ' 该形式只在本次进程内、图片出现过的会话里有效；否则请给文件路径或 http(s) 地址。',
    )
  }
  return trimmed
}

/**
 * 把消息里的图片落到磁盘，**不改动任何内容块**。
 *
 * 不改内容是关键：界面渲染的就是这些块，替换掉图片块会让用户看到一串路径而不是一张图。
 * 纯文本模型看不到图这件事，由 `llm-deepseek` 的本地补丁在序列化前的最后一刻处理 ——
 * 那时消息已经写进会话日志、界面也已渲染完毕。
 *
 * 内容寻址意味着同一张图重复出现只写一次，重复写入是幂等的。
 * @param ctx - 提供 `attachments` 服务的上下文。
 * @param blocks - 内容块。
 */
async function spillImages(ctx: Context, blocks: readonly ContentBlock[]): Promise<void> {
  const images = blocks.filter(block => block.type === 'image')
  if (images.length === 0) return
  await mkdir(SPILL_DIR, { recursive: true })
  for (const block of images) {
    const ref = block.attachment
    // 已落过盘就跳过。attachmentId 是内容寻址的（`sha256:…`），同一个 id 必然是同一份字节，
    // 落盘路径也由它推出 —— 重写一遍不会得到不同结果。不跳过的话每个 pre-step 都会把
    // 整段历史里的图片重新读出来再写一遍，长循环里就是几十 MB 的白做功。
    if (spilled.has(ref.attachmentId)) continue
    const path = spillPath(ref.attachmentId, ref.mediaType)
    try {
      const stored = await ctx.attachments.readImage(ref)
      await writeFile(path, stored.data)
      spilled.set(ref.attachmentId, path)
    } catch {
      // 落盘失败不影响本轮对话：图片仍在附件库里，只是 deepseek_vision 取不到这条路径。
      // 静默是刻意的 —— 这里抛错会中断一次与图片无关的正常提问。
    }
  }
}

/**
 * 判断当前请求所走的路由是否接受图片输入。
 *
 * 判据与 `read_image` 门禁、`api-proxy` 的图片准入完全一致：`inputModalities` 明确含 `image` 才算接受。
 *
 * 唯一用途是让 `deepseek_vision` 在调用方本身就是多模态模型时自我拒绝 —— 它直接看更准也更省。
 * 这同时是官方多模态上线时的自动让位机制：DeepSeek 声明 `image` 那天，本工具自己退出。
 * 解析不出路由时返回 false，即**不拒绝**：宁可多转一手，也好过让一次正常提问失败。
 * @param ctx - 提供 `llm` 服务的上下文。
 * @param agent - 当前 agent，用于解析实际生效的路由。
 * @param signal - 可选取消信号。
 * @returns 路由明确声明接受图片时为 true。
 */
async function routeAcceptsImages(ctx: Context, agent: unknown, signal?: AbortSignal): Promise<boolean> {
  const owner = agent as { session?: { requestHeader?: () => { config?: { provider?: string, model?: string } } | undefined }, options?: { provider?: string, model?: string } } | undefined
  const routed = owner?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? owner?.options?.provider
  const model = routed?.model ?? owner?.options?.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    // 解析不出来就当纯文本，让工具照常服务；拒绝一次能用的调用比多转一手代价大。
    return false
  }
}

/**
 * 注册 `deepseek_vision` 工具，并在 `agent/pre-step` 上把出现过的图片落盘。
 * @param ctx - 注册作用域；执行期使用其 `llm` 与 `attachments` 服务。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  // 把出现过的图片落到磁盘，供 deepseek_vision 按路径读取。只落盘，不改内容块 ——
  // 界面渲染的就是这些块，改了用户就看不到图了。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    for (const message of decision.messages) {
      if (Array.isArray(message.content)) await spillImages(ctx, message.content)
    }
    return decision
  })

  ctx.tools.register(defineTool({
    name: 'deepseek_vision',
    description:
      '看一张图并回答关于它的问题。图片不进入本模型的上下文 —— 它被转交给配置的多模态模型，'
      + '只有回答的文字回到这里。用户粘贴图片时，你看到的是一行 `[图片 …]` 提示；'
      + '想知道图上是什么，把提示里的附件 id 传给本工具。'
      + '\n\n一次把要读的点**一起问完**（"标题是什么？按钮文案是什么？右上角图标是什么？"），'
      + '不要一个问题调一次 —— 每次调用都要重新把整张图送进识图模型，按像素计费。'
      + '\n\n返回的内容与你的记忆或常识冲突时，**以本工具看到的为准**：图可能被改过、可能不是你以为的那个版本。'
      + '需要确认就带着更具体的问题再调一次本工具。'
      + '不要改用读源码、下载图片自己做像素分析、或凭印象作答来代替看图 —— 那既慢又不可靠。',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: '三选一：图片的绝对路径；http(s) 图片地址（文档、网页里的图直接传 URL）；或上下文 `[图片 …]` 提示里的附件 id（`attachment=<id>` 或裸 id 都行）。',
      },
      question: {
        type: 'string',
        required: true,
        description: '要问的问题。问得越具体，回答越可靠；「这是什么」这类开放问题只会得到概览。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_path: { type: 'string', required: true },
          question: { type: 'string', required: true },
          answer: { type: 'string', required: true },
        },
      },
      render: (_args, value: { answer: string }) => [{ type: 'text', text: value.answer }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // 调用方自己就是多模态模型时拒绝服务：它直接看图更准也更省，
      // 绕一圈交给另一个模型转述反而丢信息。这条同时保证官方多模态上线后本工具自动让位。
      if (await routeAcceptsImages(ctx, exec.agent, exec.signal)) {
        throw new Error(
          'dsh-design-qa: 当前模型本身就能看图，请直接看，不要用 deepseek_vision 转一手。'
          + ' 本工具只服务于看不到图片内容的纯文本模型。',
        )
      }
      await assertVisionRoute(ctx, config, exec.signal)
      const resolved = await resolveImageArg(args.image_path)
      const answer = await askVision(
        ctx,
        config,
        resolved,
        args.question,
        exec.signal,
      )
      if (answer.trim().length === 0) throw new Error('dsh-design-qa: 识图返回空内容')
      return { image_path: resolved, question: args.question, answer: answer.trim() }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Look: ${args.question}`, kind: 'read', locations: [{ path: args.image_path }] }
    },
  }))
}
