#!/usr/bin/env node
/**
 * dsh-deepseek-vision 的安装与重启，一份实现覆盖 macOS / Linux / Windows。
 *
 * 为什么用 Node 而不是 shell：DSH 自身要求 `node ^22.19 || >=24`，所以 Node 一定在；
 * 而 bash 在 Windows 上不一定有，`pgrep` / `pkill` / `lsof` / `setsid` 更是一个都没有。
 * 写三份平台脚本的结果是三份各自腐坏，所以只留这一份。
 *
 *   node install.mjs [profile]            安装（profile 默认 web）
 *   node install.mjs --route-only         只补路由/skill/补丁，不写插件行
 *                                         （从 GitHub 用 `dsh plugin add` 装时用这个）
 *   node install.mjs --no-patches         不给 DSH 本体打补丁（粘贴图片将仍被拒绝）
 *   node install.mjs --revert-patches     还原本体补丁并退出
 *   node install.mjs --restart            只重启，可从 dsh 自己的进程内部调用
 *                                         （加 --force 可无视「重启会丢密钥」的拦截）
 *
 * **本体补丁默认就打**，且自动定位 DSH —— 不需要源码仓库，npm 装的也认。
 * 打不上就硬报错并以非零码退出：装完粘贴图片被拒、脚本却显示成功，是最难查的一类失败。
 * `--with-patches` 作为空操作保留，写了它也不会出错。
 *
 * 平台差异只剩「列出进程」一处需要分支，其余用 Node 原生 API 抹平。
 * @module dsh-deepseek-vision/install
 */
import { execFile, spawn } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, copyFileSync, realpathSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const WIN = platform() === 'win32'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const bold = (text) => `[1m${text}[0m`
const warn = (text) => console.log(`[33m${text}[0m`)

/**
 * 备份一个文件，并只回收**本脚本自己写过**的旧备份。
 *
 * 回收的匹配串是脚本自己的完整格式 `.bak-<14位数字>-<pid>`，绝不按 `.bak-` 前缀通配 ——
 * 那样会连用户手工留的备份一起删掉，而 `rmSync` 不可撤销。
 * 排序也按 mtime 而非字典序：字母后缀在字典序里排在数字后面，会导致「保留最新」实际保留最旧。
 * @param path - 要备份的文件；不存在则跳过。
 */
function backup(path) {
  if (!existsSync(path)) return
  const dir = dirname(path)
  const own = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-\\d{14}-\\d+$`)
  const mine = readdirSync(dir)
    .filter(entry => own.test(entry))
    .map(entry => ({ entry, time: statSync(join(dir, entry)).mtimeMs }))
    .sort((a, b) => a.time - b.time)
  for (const { entry } of mine.slice(0, -2)) rmSync(join(dir, entry), { force: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '')
  copyFileSync(path, `${path}.bak-${stamp}-${process.pid}`)
}

/**
 * 建立软链；Windows 上非管理员且未开开发者模式时会失败，退化为复制。
 * 复制的代价是「包内那份不再是唯一来源」，所以只在不得已时用，并明确告知。
 */
function linkOrCopy(target, linkPath) {
  rmSync(linkPath, { recursive: true, force: true })
  try {
    symlinkSync(target, linkPath, WIN ? 'junction' : 'dir')
    return 'link'
  } catch {
    cpSync(target, linkPath, { recursive: true })
    return 'copy'
  }
}

/**
 * 列出进程的 pid 与命令行。**这是唯一需要按平台分支的地方。**
 * Node 没有可移植的进程枚举 API，只能各叫各的系统命令。
 */
async function listProcesses() {
  if (WIN) {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'])
    const rows = JSON.parse(stdout || '[]')
    return (Array.isArray(rows) ? rows : [rows])
      .filter((row) => row?.CommandLine)
      .map((row) => ({ pid: row.ProcessId, command: row.CommandLine }))
  }
  const { stdout } = await run('ps', ['-Ao', 'pid=,command='])
  return stdout.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match === null ? undefined : { pid: Number(match[1]), command: match[2] }
  }).filter((entry) => entry !== undefined)
}

/**
 * 读另一个进程的工作目录。**必须从被重启的那个进程读**，不能用本脚本自己的 ——
 * 用安装脚本自己的 cwd 去拉起，命令里的相对路径（如 `--patch ./some.cordis.yml`）会全部失效：
 * 旧进程已被杀掉，新进程却起不来。
 *
 * Node 没有可移植 API：Linux 读 /proc，macOS 用 lsof，Windows 两者都没有 —— 那里需要显式给 DSH_CWD。
 */
async function processCwd(pid) {
  if (process.env.DSH_CWD !== undefined) return process.env.DSH_CWD
  if (platform() === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`) } catch { /* 权限或已退出 */ }
  }
  if (!WIN) {
    try {
      const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      const line = stdout.split('\n').find((entry) => entry.startsWith('n'))
      if (line !== undefined) return line.slice(1)
    } catch { /* 没装 lsof */ }
  }
  return undefined
}

/** 找到正在运行的 dsh。内置候选覆盖源码运行与 npm 安装两种形态。 */
async function findDsh() {
  const candidates = [process.env.DSH_PROCESS_PATTERN, 'dsh/lib/bin.js', 'apps/cli/src/bin.ts', 'bin.js web', 'bin.ts web']
    .filter((pattern) => typeof pattern === 'string' && pattern.length > 0)
  const processes = await listProcesses()
  const self = process.pid
  for (const pattern of candidates) {
    const hit = processes.find((entry) => entry.pid !== self && entry.command.includes(pattern))
    if (hit !== undefined) return { ...hit, pattern }
  }
  return undefined
}

/** 重启的日志。进程是 detached 的，没有终端可回显；不落盘就等于失败无声。 */
const RESTART_LOG = join(DSH_HOME, 'dsh-deepseek-vision-restart.log')

/**
 * 列出另一个进程的环境变量**名**（不取值）。
 *
 * 只要名字：这里的用途是「提醒哪些变量会在重启中丢掉」，取值既没必要也不该做。
 * Linux 读 `/proc`，macOS 用 `ps eww`（它把环境接在命令行后面，含空格的值会被切碎 ——
 * 对取名字无妨）。Windows 两者都没有，返回空集，退化成不提醒。
 */
async function processEnvNames(pid) {
  const names = new Set()
  const harvest = (text, sep) => {
    for (const entry of text.split(sep)) {
      const eq = entry.indexOf('=')
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, eq))) names.add(entry.slice(0, eq))
    }
  }
  if (platform() === 'linux') {
    try { harvest(await readFile(`/proc/${pid}/environ`, 'utf8'), '\0'); return names } catch { /* 权限不足 */ }
  }
  if (!WIN) {
    try { harvest((await run('ps', ['eww', '-p', String(pid)])).stdout, /\s+/) } catch { /* 没有 ps */ }
  }
  return names
}

/**
 * 重启会丢掉哪些密钥类环境变量。
 *
 * `--restart` 让新进程**继承调用方的环境**。跑在 dsh 里的 agent 调用时这天然正确，
 * 但从别的终端调用时，只 export 在原终端里的 `BAILIAN_API_KEY` 会就此消失 ——
 * 插件还在、路由还在、界面一切正常，只有识图调用 401。这种「装好了却用不了」最难查，
 * 所以宁可在重启前把名字列出来。
 *
 * 只比对 settings.yaml 里 `apiKeyEnv` 点名的变量，以及名字像密钥的那些；
 * 全量比对会把 TERM_SESSION_ID 之类的噪音一起报出来。**只报名字，不读值。**
 */
async function lostSecrets(pid) {
  const settings = existsSync(join(DSH_HOME, 'settings.yaml')) ? readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8') : ''
  const declared = new Set([...settings.matchAll(/^\s*apiKeyEnv:\s*(\S+)/gm)].map((match) => match[1]))
  const names = await processEnvNames(pid)
  return [...names].filter((name) => (declared.has(name) || /(_API_KEY|_TOKEN|_SECRET)$/.test(name))
    && process.env[name] === undefined).sort()
}

/**
 * 拉起要用的那个 node 能不能跑 DSH。**必须在杀掉旧进程之前问**。
 *
 * 本命令继承调用方的环境。跑在 dsh 里的 agent 调用时这天然正确（它看到的就是 dsh
 * 自己的环境），但从别处调用 —— 另一个终端、另一个 agent —— PATH 上的 node 可能是
 * 系统那份旧版本。DSH 要求 `^22.19 || >=24`，旧版起不来，而旧进程此时已经被杀了，
 * 结果是「DSH 没了，且没有任何地方说为什么」。
 * @returns `{ text, ok }`；探测不到（没有 node 或命令不是 node 拉起的）返回 undefined，放行。
 */
async function relaunchNodeVersion(command) {
  // 命令不是以 node 拉起的（例如 `dsh web`）就测不了，放行 —— 猜错的代价比不查更高。
  if (!/(^|[\s/\\])node(\.exe)?["']?\s/.test(command)) return undefined
  try {
    const { stdout } = await run('node', ['-v'])
    const [major, minor] = stdout.trim().replace(/^v/, '').split('.').map(Number)
    return { text: stdout.trim(), ok: (major === 22 && minor >= 19) || major >= 24 }
  } catch { return undefined }
}

/**
 * 重启 dsh。**可以从 dsh 自己的进程内部调用** —— 这是本命令存在的理由：
 * 装完必须冷启动（HMR 关闭），而 agent 往往正跑在要被重启的那个进程里，
 * 直接杀等于自杀，调用方拿不到结果，只能猜自己成功了没有。
 *
 * 做法：把「杀 + 等 + 拉起」交给一个 `detached` 的子进程再 `unref()`，父进程立刻返回。
 * 这是 Node 的跨平台原语，省掉了 shell 版里 setsid + nohup + 临时脚本那一整套变通；
 * 按 pid 杀而不匹配命令行，helper 自己也就不会因为命令行含匹配串而杀掉自己。
 */
async function restart() {
  const target = await findDsh()
  if (target === undefined) {
    warn('找不到正在运行的 dsh 进程。')
    console.log('  若它确实在跑：DSH_PROCESS_PATTERN="<命令行里的唯一片段>" node install.mjs --restart')
    console.log('  若它没在跑：按你平时的方式启动即可，无需本命令。')
    return 1
  }

  // 新进程**继承调用方的环境**，这在主要场景下天然正确：
  // agent 跑在 dsh 进程里，它看到的环境就是 dsh 自己的环境，PATH 与当初启动时完全一致。
  //
  // 两条看似更聪明的路都不可行：
  //   1) 登录 shell（`$SHELL -lc`）—— 只加载 profile；若 Node 装在 profile 之外
  //      （如手动 export 的 ~/.local/node-24），拿到的是系统 Node，DSH 起不来；
  //   2) 从 `ps -E` 抠旧进程的 PATH —— macOS 上抠出坏值，连 pkill 都找不到。
  // 继承环境既简单又正好覆盖真实用法：人在终端里跑，用的也正是他启动 dsh 的那个环境。
  const cwd = await processCwd(target.pid)
  if (cwd === undefined) {
    warn('读不到该进程的工作目录，无法安全重启（命令里的相对路径会失效）。')
    console.log('  显式指定后重试：DSH_CWD="<dsh 的工作目录>" node install.mjs --restart')
    return 1
  }

  // 两道体检都在**杀进程之前**做，而且一次报全：分两次报的话，用户修好第一条、
  // 重跑、才发现还有第二条 —— 而这中间旧进程已经死了。
  const self = JSON.stringify(join(HERE, 'install.mjs'))
  const blockers = []
  const version = await relaunchNodeVersion(target.command)
  if (version !== undefined && !version.ok) {
    blockers.push([
      `拉起要用的 node 是 ${version.text}，DSH 要求 ^22.19 || >=24 —— 现在重启会把 DSH 杀掉且起不来。`,
      '  本命令继承你当前 shell 的环境。先把够新的 node 放上 PATH：',
      `    PATH="<node24 目录>/bin:$PATH" node ${self} --restart`,
      '  跑在 dsh 里的 agent 一般碰不到这条：它继承的就是 dsh 自己的环境。',
    ])
  }
  const lost = await lostSecrets(target.pid)
  if (lost.length > 0) {
    blockers.push([
      `旧进程有这些密钥类环境变量，而当前 shell 没有 —— 重启后会丢：${lost.join('、')}`,
      '  后果是「装好了却用不了」：插件、路由、界面都正常，只有识图调用 401。',
      `    ${lost.map((name) => `${name}=<你的 key>`).join(' ')} node ${self} --restart`,
      '  或者把 key 存进 DSH 的凭据服务（设置 → 模型），从此不受重启影响。',
    ])
  }
  if (blockers.length > 0 && !process.argv.includes('--force')) {
    warn(`重启前发现 ${blockers.length} 处问题，就此打住 —— 旧进程还活着。`)
    for (const lines of blockers) { console.log(''); warn(`  · ${lines[0]}`); for (const line of lines.slice(1)) console.log(`  ${line}`) }
    console.log(`\n  确认无妨、仍要继续：node ${self} --restart --force`)
    return 1
  }

  console.log(bold('将重启'))
  console.log(`  pid   = ${target.pid}（匹配 "${target.pattern}"）`)
  console.log(`  cmd   = ${target.command}`)
  console.log(`  cwd   = ${cwd}`)
  console.log(`  node  = ${version?.text ?? '（命令不是 node 直接拉起的，未探测）'}`)
  console.log(`  日志  = ${RESTART_LOG}`)

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--relaunch-worker'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DSH_RELAUNCH_PID: String(target.pid),
      DSH_RELAUNCH_CMD: target.command,
      DSH_RELAUNCH_CWD: cwd,
    },
  })
  child.unref()

  console.log('\n已在后台安排重启，本命令立即返回（调用方不会被连带杀掉）。')
  console.log('约 2 秒后旧进程停止，随后新进程拉起；起不来的话原因写在上面那份日志里。')
  return 0
}

/** 后台工作进程：等父进程放手、杀旧的、等它真退出、再拉起新的。 */
async function relaunchWorker() {
  const pid = Number(process.env.DSH_RELAUNCH_PID)
  const command = process.env.DSH_RELAUNCH_CMD ?? ''
  const cwd = process.env.DSH_RELAUNCH_CWD

  await new Promise((done) => setTimeout(done, 2000))
  try { process.kill(pid) } catch { /* 已经退出了 */ }
  // 等它真的走：端口没释放就起，新进程会 EADDRINUSE。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise((done) => setTimeout(done, 500))
  }
  // 新进程是 detached 的，没有终端可回显。stdio 若丢进 'ignore'，启动失败时
  // （比如 PATH 上的 node 太旧）DSH 会直接消失且**任何地方都没有原因**。
  // 追加写到日志文件，代价只有一个文件，换来失败时有据可查。
  mkdirSync(dirname(RESTART_LOG), { recursive: true })
  writeFileSync(RESTART_LOG, `\n===== ${new Date().toISOString()} 重启 =====\ncwd: ${cwd}\ncmd: ${command}\n`, { flag: 'a' })
  const log = openSync(RESTART_LOG, 'a')
  // shell: true 让整条命令行（含参数与引号）按原样解析；环境由本进程继承而来。
  spawn(command, { cwd, detached: true, stdio: ['ignore', log, log], shell: true }).unref()
}

/** 往 profile 的补丁层写 insert 块。新装的 profile 里这个文件是一句 `[]`。 */
function mountPlugin(profile) {
  // 本包已作为 bundle 装进这个 profile 时，插件行由包内 cordis.patch.yml 提供。
  // 此时再往 profile 补丁层写一条同 id 的行，Loader 会在启动时抛
  // `duplicate loader entry id: deepseek-vision`，**整个 profile 起不来**
  // （不是「后层覆盖前层」，两条都在；也与有没有 tsx 无关）。
  // 报错来自 cordis loader 内部，既不提插件名也不给修复方式，所以在这里挡住。
  const manifest = join(DSH_HOME, 'profiles', profile, 'package.json')
  if (existsSync(manifest)) {
    const bundles = JSON.parse(readFileSync(manifest, 'utf8'))?.dsh?.profile?.bundles ?? []
    if (bundles.includes('dsh-deepseek-vision')) {
      return '本包已作为 bundle 装在该 profile，跳过写入插件行（这正是 --route-only 要做的）'
    }
  }
  const patch = join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  const text = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
  if (text.includes('id: deepseek-vision')) return '已存在，跳过'
  backup(patch)
  const entry = `# dsh-deepseek-vision —— 纯文本模型的图像能力。\n`
    + `# 识图路由不在这里声明：补丁层的 config 是整体替换而非深合并，\n`
    + `# 在这里写 llm-pi-ai 会抹掉 settings.yaml 里已有的其它路由。\n`
    + `- insert:\n    - id: deepseek-vision\n      name: ${JSON.stringify(resolve(HERE, 'src/index.ts'))}\n`
    + `      config:\n        provider: bailian\n        model: qwen3.8-max\n`
  // 去掉注释与空行后只剩 `[]` 的话，必须**替换**而不是追加 ——
  // `[]` 后面再跟 `- item` 是非法 YAML，dsh 启动时直接 parse error。
  const body = text.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#')).join('\n').trim()
  const next = body === '[]' || body === ''
    ? `${text.replace(/^\s*\[\s*\]\s*$\n?/m, '').trimEnd()}\n\n${entry}`
    : `${text.trimEnd()}\n\n${entry}`
  mkdirSync(dirname(patch), { recursive: true })
  writeFileSync(patch, next.trimStart(), 'utf8')
  return '已写入（原文件已备份）'
}

/** 往 settings.yaml 写识图路由。只写结构，不写密钥 —— apiKeyEnv 指向环境变量名。 */
function writeRoute() {
  const settings = join(DSH_HOME, 'settings.yaml')
  const text = existsSync(settings) ? readFileSync(settings, 'utf8') : ''
  if (/^ {4}bailian:/m.test(text)) return '已存在，跳过'
  backup(settings)
  const route = [
    '    bailian:',
    '      displayName: 阿里百炼',
    '      apiKeyEnv: BAILIAN_API_KEY',
    '      api: openai-completions',
    '      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
    '      compat:',
    '        thinkingFormat: qwen',
    '      models:',
    '        - id: qwen3.8-max',
    '          name: Qwen3.8-Max (识图)',
    '          input: [text, image]',
    '          contextWindow: 262144',
    '          maxTokens: 8192',
    '          reasoningEfforts:',
    '            off:',
    '            high: high',
    '',
  ].join('\n')
  // 已有 llm-pi-ai 段就挂进它的 providers 下，不动其它路由；没有就整段补上。
  const next = /^llm-pi-ai:/m.test(text)
    ? text.replace(/^llm-pi-ai:\n( *providers:\n)?/m, (all) => `${all.includes('providers:') ? all : `${all}  providers:\n`}${route}`)
    : `${text.trimEnd()}\n\nllm-pi-ai:\n  providers:\n${route}`
  writeFileSync(settings, next, 'utf8')
  return '已写入（密钥仍走 BAILIAN_API_KEY 环境变量）'
}

/* ────────────────────────── DSH 本体补丁 ────────────────────────── */

/**
 * 写进被改文件里的标记，用来判断「已经打过」。
 *
 * 比另存一份状态文件可靠：升级 DSH、重装依赖会覆盖掉被改的文件，标记随之消失，
 * 于是下次安装自然会重打。状态文件则会留下「以为打过、其实没有」的假象。
 */
const MARK = 'DSH-DEEPSEEK-VISION-PATCH'

/** 还原命令，直接写进补丁注释里 —— 半年后读到这段代码的人不必去翻文档。 */
const REVERT_HINT = `node ${join(HERE, 'install.mjs')} --revert-patches`

/**
 * 落点一：`dsh-host-apiproxy` 的消息准入检查。
 *
 * 原逻辑发现纯文本路由带图就直接拒绝，用户粘贴的图连会话都进不去。整块移除后，
 * 图片照常进持久消息与会话日志，界面气泡里显示的仍是一张图。
 *
 * 正则同时匹配 TS 源码与构建产物两种形态：以 `if (hasImage) {` 的缩进为锚
 * （`\1`），块尾必然是同缩进的 `}`。两种形态的中间内容不同（构建产物把 `return err(...)`
 * 提成了单行），所以中间用惰性匹配跨过去，只对两端做强约束。
 */
const ADMISSION = {
  id: 'image-admission',
  find: /^([ \t]*)if \(hasImage\) \{[\s\S]*?MODEL_DOES_NOT_SUPPORT_IMAGES[\s\S]*?\n\1\}/m,
  build: (_ts, match) => [
    `${match[1]}// ${MARK} (image-admission)`,
    `${match[1]}// 原处：纯文本路由在消息准入处直接拒绝图片。整块移除。`,
    `${match[1]}// 图片照常入库、界面仍显示图；纯文本适配器在序列化前的最后一刻把它换成`,
    `${match[1]}// 一行 attachment= 文字指针，模型据此调用 deepseek_vision 工具。`,
    `${match[1]}// 与 dsh-llm-deepseek 的 image-pointer 补丁成对：`,
    `${match[1]}// 只还原这一处，粘图回到被拒绝的原样（安全）；只还原那一处，图片会撞上`,
    `${match[1]}// UNSUPPORTED_CONTENT 而使整条会话无法继续。`,
    `${match[1]}// 还原：${REVERT_HINT}`,
  ].join('\n'),
}

/**
 * 落点二之一：`dsh-llm-deepseek` 的 `assertTextOnly()` 换成指针映射。
 *
 * **为什么放在这一站**：这是消息通往 DeepSeek 的最后一步。此前每一站 —— 持久化、
 * 会话日志、界面渲染 —— 看到的都还是真正的图片块，所以用户在气泡里看到的是一张图，
 * 证据也完整留档。放在更早的位置替换，用户看到的就会变成一串路径而不是图。
 *
 * 替换文本按形态分两份：TS 那份带完整类型标注，免得源码仓库跑 `npm run typecheck` 报错；
 * 构建产物那份是纯 JS。查找正则是同一条。
 */
const POINTER_FN = {
  id: 'image-pointer/fn',
  find: /^\/\*\* Reject core image content[\s\S]*?\n\}$/m,
  build: (ts) => (ts ? [
    '/**',
    ` * ${MARK} (image-pointer)：图片内容不再抛错，而是在序列化前的最后一刻换成一行文字指针。`,
    ' *',
    ' * 为什么放在这里：这是消息通往 DeepSeek 的最后一站。此前每一站 —— 持久化、会话日志、',
    ' * 界面渲染 —— 看到的都还是真正的图片块，所以用户在气泡里看到的仍是一张图，证据也完整留档。',
    ' * 放在更早的位置（准入检查、agent/pre-step）替换掉图片块，用户会看到一串路径而不是图。',
    ' *',
    ' * 这里只打印附件 id，**不推算任何文件路径**：命名规则完整地留在插件一侧，由',
    ' * deepseek_vision 按 id 解析 —— 两边各写一份路径规则的话，改一边就会静默失配。',
    ' *',
    ` * 还原：${REVERT_HINT}`,
    ' */',
    'function replaceImagesWithPointers(blocks: readonly ContentBlock[]): ContentBlock[] {',
    '  if (!contentHasImage(blocks)) return [...blocks]',
    '  return blocks.map((block) => {',
    "    if (block.type !== 'image') return block",
    '    const ref = block.attachment',
    '    return {',
    "      type: 'text' as const,",
    '      text: `[图片 ${ref.mediaType} ${ref.width}x${ref.height} attachment=${ref.attachmentId}]`',
    "        + '（本模型看不到图片内容。需要知道图上是什么，把这个 attachment= 值传给 deepseek_vision 工具。）',",
    '    }',
    '  })',
    '}',
  ] : [
    '/**',
    ` * ${MARK} (image-pointer)：图片内容不再抛错，而是换成一行 attachment= 文字指针。`,
    ' * 与 dsh-host-apiproxy 的 image-admission 补丁成对，须同时存在或同时还原。',
    ` * 还原：${REVERT_HINT}`,
    ' */',
    'function replaceImagesWithPointers(blocks) {',
    '\tif (!contentHasImage(blocks)) return [...blocks];',
    '\treturn blocks.map((block) => {',
    '\t\tif (block.type !== "image") return block;',
    '\t\tconst ref = block.attachment;',
    '\t\treturn {',
    '\t\t\ttype: "text",',
    '\t\t\ttext: `[图片 ${ref.mediaType} ${ref.width}x${ref.height} attachment=${ref.attachmentId}]` + "（本模型看不到图片内容。需要知道图上是什么，把这个 attachment= 值传给 deepseek_vision 工具。）"',
    '\t\t};',
    '\t});',
    '}',
  ]).join('\n'),
}

/**
 * 落点二之二：调用点。原为 `assertTextOnly(message.content)` 直接抛错。
 *
 * 改成**拷贝**而不是就地改写 `message.content`：那个数组属于会话里的持久消息对象，
 * 就地改会让界面与后续压缩看到的也变成文字，图就从气泡里消失了。
 */
const POINTER_CALL = {
  id: 'image-pointer/call',
  find: /for \(const message of messages\) \{(\s*)assertTextOnly\(message\.content\);?/,
  build: (ts, match) => [
    'for (const original of messages) {',
    `${match[1]}// ${MARK}：原为 assertTextOnly(message.content) 直接抛错。`,
    `${match[1]}const message = { ...original, content: replaceImagesWithPointers(original.content) }${ts ? '' : ';'}`,
  ].join(''),
}

/**
 * 两个落点各自的包名、源码仓库内路径，以及两种形态下的目标文件。
 * `ts` 是源码运行时真正被加载的那份（tsx 走 tsconfig paths → `src/`）；
 * `js` 是 npm 安装时被加载的那份（package.json 的 exports → `lib/index.js`）。
 */
const PATCH_TARGETS = [
  {
    pkg: '@deepseek-ai/dsh-host-apiproxy',
    repoDir: 'packages/host/apiproxy',
    forms: { ts: 'src/api-proxy.ts', js: 'lib/index.js' },
    edits: [ADMISSION],
  },
  {
    pkg: '@deepseek-ai/dsh-llm-deepseek',
    repoDir: 'packages/llm/llm-deepseek',
    forms: { ts: 'src/serialize.ts', js: 'lib/index.js' },
    edits: [POINTER_FN, POINTER_CALL],
  },
]

/**
 * 定位 DSH 本体的包目录 —— **不需要用户知道 DSH 装在哪**，这是本次改动的要点。
 *
 * 按 profile 的 `node_modules` 去解析，拿到的正是运行中的 dsh 实际加载的那份：
 *   - npm 安装 → 解析到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/...` 里的真实目录；
 *   - 源码运行 → 那里是指向仓库 workspace 的软链，`realpathSync` 一步到位。
 * `DSH_REPO` 退化成显式覆盖，只在自动定位不对时才需要。
 * @returns 去重后的包根目录数组；解析不到返回空数组（调用方据此硬报错，不静默跳过）。
 */
function findPackageRoots(pkg, repoDir, profile) {
  const roots = new Set()
  const repo = process.env.DSH_REPO
  if (repo !== undefined && existsSync(join(resolve(repo, repoDir), 'package.json'))) {
    roots.add(realpathSync(resolve(repo, repoDir)))
  }
  for (const base of [join(DSH_HOME, 'profiles', profile), join(DSH_HOME, 'profiles'), HERE, dirname(HERE), ...dshBinBases()]) {
    try {
      // createRequire 需要一个「文件」路径，从它所在目录逐级向上找 node_modules；
      // noop.js 不必存在。exports 里有 "./package.json"，所以这条一定解析得到。
      const found = createRequire(join(base, 'noop.js')).resolve(`${pkg}/package.json`)
      roots.add(dirname(realpathSync(found)))
    } catch { /* 这个 base 解析不到，换下一个 */ }
  }
  return [...roots]
}

/**
 * 从 PATH 上的 `dsh` 可执行文件反推出的解析基点。
 *
 * 兜底用：正常情况下 profile 的 node_modules 是扁平的，前面几个基点就够了；
 * 但包管理器若选择嵌套而不提升，本体依赖就只挂在 dsh 自己的包下面。
 * 两种布局各给一个基点，让 Node 自己去 node_modules 链上找：
 *   - Unix：`dsh` 是软链 → 包内 `lib/bin.js`，上溯两级即包根；
 *   - Windows：`dsh.cmd` 是垫片脚本不是软链，它所在目录就是 npm 前缀目录（其下有 node_modules）。
 */
function dshBinBases() {
  const names = WIN ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of (process.env.PATH ?? '').split(WIN ? ';' : ':')) {
    for (const name of names) {
      const bin = join(dir, name)
      if (!existsSync(bin)) continue
      try {
        const real = realpathSync(bin)
        return [dirname(real), dirname(dirname(real))]
      } catch { /* 悬空链，换下一个 */ }
    }
  }
  return []
}

/** 一个包下所有需要改的文件。两种形态都存在就都改 —— 无法可靠判断哪份是活的，半打状态正是要消灭的失败模式。 */
function formFiles(root, forms) {
  return [forms.ts, forms.js].map((rel) => join(root, rel)).filter((path) => existsSync(path))
}

/**
 * 改一个文件。幂等（见到标记就跳过），原文另存为 `.dsh-vision-orig` 供精确还原。
 *
 * 用 `exec` + 手工拼接而不是 `String.replace`：替换文本里含 `$` 与反引号，
 * 走 replace 会被当成 `$1` 之类的替换记号吃掉。
 */
function patchFile(path, edits) {
  const before = readFileSync(path, 'utf8')
  if (before.includes(MARK)) return { path, status: 'already' }
  const ts = path.endsWith('.ts')
  let text = before
  for (const edit of edits) {
    const match = edit.find.exec(text)
    if (match === null) return { path, status: 'no-anchor', edit: edit.id }
    text = text.slice(0, match.index) + edit.build(ts, match) + text.slice(match.index + match[0].length)
  }
  writeFileSync(`${path}.dsh-vision-orig`, before, 'utf8')
  writeFileSync(path, text, 'utf8')
  return { path, status: 'patched' }
}

/** 还原一个文件：把另存的原文拷回去。原文丢了就明说，不猜着往回改。 */
function revertFile(path) {
  const orig = `${path}.dsh-vision-orig`
  const patched = existsSync(path) && readFileSync(path, 'utf8').includes(MARK)
  if (!existsSync(orig)) return { path, status: patched ? 'orig-missing' : 'clean' }
  copyFileSync(orig, path)
  rmSync(orig, { force: true })
  return { path, status: 'reverted' }
}

/**
 * 打（或还原）本体补丁。
 * @returns `{ lines, ok }` —— lines 逐条汇报，ok 为 false 时调用方应以非零码退出。
 */
function patchBody(profile, { revert = false } = {}) {
  const lines = []
  let ok = true
  for (const target of PATCH_TARGETS) {
    const roots = findPackageRoots(target.pkg, target.repoDir, profile)
    if (roots.length === 0) {
      ok = false
      // 报到「找不到」为止就停手，不去猜路径。这条信息要同时对两类用户成立：
      // npm 装的（没有源码仓库，问题多半出在 DSH_HOME）与源码跑的（需要 DSH_REPO）。
      lines.push(`✗ ${target.pkg}：定位不到，本体补丁没打。`)
      lines.push(`  已在这些位置找过：${DSH_HOME}/profiles[/${profile}]、本包目录、PATH 上的 dsh`)
      lines.push('  npm 装的 DSH：多半是 DSH_HOME 指错了，确认后重跑；')
      lines.push('  源码跑的 DSH：DSH_REPO=<仓库根> node install.mjs --route-only')
      continue
    }
    let touched = 0
    for (const root of roots) {
      // 打到哪份 DSH 上必须显式打印：万一机器上有多份，用户要能一眼看出改错了没有。
      lines.push(`${revert ? '还原' : '改'} ${target.pkg} @ ${root}`)
      const files = formFiles(root, target.forms)
      if (files.length === 0) {
        lines.push(`  · 既无 ${target.forms.ts} 也无 ${target.forms.js}，跳过`)
        continue
      }
      for (const file of files) {
        const result = revert ? revertFile(file) : patchFile(file, target.edits)
        const rel = file.slice(root.length + 1)
        if (result.status === 'patched') { touched += 1; lines.push(`  ✓ ${rel}（原文另存 ${basename(file)}.dsh-vision-orig）`) }
        else if (result.status === 'already') { touched += 1; lines.push(`  · ${rel} 已打过，跳过`) }
        else if (result.status === 'reverted') { touched += 1; lines.push(`  ✓ ${rel} 已还原`) }
        else if (result.status === 'clean') { touched += 1; lines.push(`  · ${rel} 本来就没改过`) }
        else if (result.status === 'orig-missing') { ok = false; lines.push(`  ✗ ${rel} 改过但原文已丢，需手工还原，见 patches/README.md`) }
        else { ok = false; lines.push(`  ✗ ${rel} 找不到 ${result.edit} 的锚点 —— DSH 版本可能已变，需手工重做，见 patches/README.md`) }
      }
    }
    if (touched === 0) ok = false
  }
  return { lines, ok }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--relaunch-worker')) return relaunchWorker().then(() => 0)
  if (argv.includes('--restart')) return restart()

  const profile = argv.find((arg) => !arg.startsWith('--')) ?? 'web'

  if (argv.includes('--revert-patches')) {
    console.log(bold('还原 DSH 本体补丁'))
    const { lines, ok } = patchBody(profile, { revert: true })
    for (const line of lines) console.log(`     ${line}`)
    console.log('\n还原后同样需要冷启动才生效：node install.mjs --restart')
    return ok ? 0 : 1
  }

  // 本体补丁默认就打：不打的话，用户装完在对话框里粘图仍会被拒 —— 那正是他要的功能。
  // `--with-patches` 保留为空操作，外面流传的文档与提示词里写着它。
  const patches = !argv.includes('--no-patches')
  // 从 GitHub 用 `dsh plugin add` 装的用户，插件行已由 bundle 层提供。
  // 此时不能再写 profile 的 cordis.patch.yml —— 两条同 id 的行会让 Loader 在启动时抛
  // `duplicate loader entry id`，整个 profile 起不来。
  const routeOnly = argv.includes('--route-only')
  if (!existsSync(join(DSH_HOME, 'profiles', profile))) {
    console.error(`找不到 profile：${join(DSH_HOME, 'profiles', profile)}`)
    console.error('用法：node install.mjs [profile] [--route-only] [--no-patches]')
    return 1
  }

  console.log(bold('1/6 解析依赖'))
  const how = linkOrCopy(join(DSH_HOME, 'profiles', 'node_modules'), join(HERE, 'node_modules'))
  console.log(`     node_modules ${how === 'link' ? '已软链' : '已复制（本平台不允许软链）'}`)

  console.log(bold('2/6 安装 skill'))
  mkdirSync(join(homedir(), '.agents', 'skills'), { recursive: true })
  const skill = linkOrCopy(join(HERE, 'skills', 'deepseek-vision'), join(homedir(), '.agents', 'skills', 'deepseek-vision'))
  console.log(`     ~/.agents/skills/deepseek-vision ${skill === 'link' ? '已软链' : '已复制 —— 注意：改包内那份不会同步，需重跑本脚本'}`)

  console.log(bold('3/6 写入识图路由'))
  console.log(`     ${writeRoute()}`)

  console.log(bold(`4/6 挂到 profile：${profile}`))
  console.log(`     ${routeOnly ? '--route-only：跳过（插件行由 bundle 层提供）' : mountPlugin(profile)}`)

  console.log(bold('5/6 给 DSH 本体打补丁（让「粘贴图片」能用）'))
  let patchOk = true
  if (patches) {
    const result = patchBody(profile)
    patchOk = result.ok
    for (const line of result.lines) console.log(`     ${line}`)
  } else {
    warn('     --no-patches：已跳过。在对话框里粘贴图片仍会被拒绝，')
    warn('     只能用「文件路径 / 图片 URL / 附件 id + deepseek_vision」这条路。')
  }

  console.log(bold('6/6 自检'))
  const settings = existsSync(join(DSH_HOME, 'settings.yaml')) ? readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8') : ''
  const missing = []
  // settings.yaml 由 DSH 的设置写入器维护并会规范化格式（实测 `[text, image]` 被重写成
  // `[ text, image ]`），所以一律宽松匹配 —— 查的是「像不像配过」，不是「配得对不对」。
  if (!/^ *bailian:/m.test(settings)) missing.push('settings.yaml 里没有 bailian 路由')
  if (!/input:.*\btext\b.*\bimage\b/.test(settings)) missing.push('路由没声明 input: [text, image] —— 这一行是打开图像门禁的开关')
  if (!/thinkingFormat: *qwen/.test(settings)) missing.push('路由没有 compat.thinkingFormat: qwen —— 不关思维会白烧 113 倍 token')
  if (!process.env.BAILIAN_API_KEY) missing.push('当前环境没有 BAILIAN_API_KEY（也可在 Web 的 设置→模型 页存进凭据服务）')
  if (patches && !patchOk) missing.push('本体补丁没打全 —— 粘贴图片会被拒绝，见上一步的 ✗ 行')
  if (missing.length === 0) console.log('     全部就绪')
  else {
    warn('     还差以下几项，见 README「三步装好」：')
    for (const item of missing) warn(`       - ${item}`)
  }

  console.log(`\n${bold('⚠️  必须冷启动才生效')}`)
  console.log('   HMR 是关闭的，插件、skill、profile 补丁、本体补丁都不热加载，刷新浏览器不算。执行：\n')
  console.log(`     node ${JSON.stringify(join(HERE, 'install.mjs'))} --restart\n`)
  console.log('   如果你是跑在 dsh 里的 agent，就用上面这条，不要自己杀进程 ——')
  console.log('   杀了你自己就拿不到结果，也无法确认是否成功。这条会立即返回，重启在你身后完成。')
  // 补丁没打成必须以非零码退出。静默成功的话，用户装完粘图被拒，
  // 却因为脚本显示「一切正常」而无从判断哪一步漏了。
  return patches && !patchOk ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
