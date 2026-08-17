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
 *   node install.mjs --with-patches       连同 DSH 本体的两处补丁一起装（需 DSH_REPO）
 *   node install.mjs --restart            只重启，可从 dsh 自己的进程内部调用
 *
 * 平台差异只剩「列出进程」一处需要分支，其余用 Node 原生 API 抹平。
 * @module dsh-deepseek-vision/install
 */
import { execFile, spawn } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, symlinkSync, copyFileSync } from 'node:fs'
import net from 'node:net'
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
 * 那样会删掉用户手工留的备份。曾经就是这么删掉过 5 份用户自己的 `.bak-*`，无法找回。
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

/** 端口是否有人监听。用 net.connect 探测，不依赖 lsof / netstat。 */
function portOpen(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const socket = net.connect({ port, host })
    const finish = (open) => { socket.destroy(); done(open) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
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
 * 实测踩过：用安装脚本的 cwd 去拉起，命令里的相对路径（如 `--patch ./some.cordis.yml`）全部失效，
 * 旧进程被杀了、新进程起不来。
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

/**
 * 重启 dsh。**可以从 dsh 自己的进程内部调用** —— 这是本命令存在的理由：
 * 装完必须冷启动（HMR 关闭），而 agent 往往正跑在要被重启的那个进程里，
 * 直接杀等于自杀，调用方拿不到结果，只能猜自己成功了没有。
 *
 * 做法：把「杀 + 等 + 拉起」交给一个 `detached` 的子进程再 `unref()`，父进程立刻返回。
 * 这是 Node 的跨平台原语，替掉了 shell 版里 setsid + nohup + 临时脚本那一整套变通，
 * 也顺带消掉了「helper 的命令行含 pkill 匹配串因而杀死自己」那个坑 —— 这里按 pid 杀，不匹配命令行。
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
  // 试过两条更"聪明"的路，都不行，记下来免得再走：
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

  console.log(bold('将重启'))
  console.log(`  pid   = ${target.pid}（匹配 "${target.pattern}"）`)
  console.log(`  cmd   = ${target.command}`)
  console.log(`  cwd   = ${cwd}`)

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
  console.log('约 2 秒后旧进程停止，随后新进程拉起。')
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
  // shell: true 让整条命令行（含参数与引号）按原样解析；环境由本进程继承而来。
  spawn(command, { cwd, detached: true, stdio: 'ignore', shell: true }).unref()
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

/** 应用 DSH 本体的两处补丁。幂等：已打过会跳过，冲突会报错而不是硬来。 */
async function applyPatches() {
  const repo = process.env.DSH_REPO
  const patch = join(HERE, 'patches', 'dsh-local.patch')
  if (repo === undefined) return '需要 DSH_REPO=<DSH 源码仓库根> 才能打补丁，已跳过'
  const git = (args) => run('git', ['-C', repo, ...args])
  try { await git(['rev-parse', '--is-inside-work-tree']) } catch { return `${repo} 不是 git 仓库，已跳过` }
  try { await git(['apply', '--reverse', '--check', patch]); return '已打过，跳过' } catch { /* 未打过，继续 */ }
  try { await git(['apply', '--check', patch]) } catch { return '补丁与当前源码冲突，需手工重做，见 patches/README.md' }
  await git(['apply', patch])
  return `已应用（还原：git -C "${repo}" apply -R "${patch}"）`
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--relaunch-worker')) return relaunchWorker().then(() => 0)
  if (argv.includes('--restart')) return restart()

  const withPatches = argv.includes('--with-patches')
  // 从 GitHub 用 `dsh plugin add` 装的用户，插件行已由 bundle 层提供。
  // 此时不能再写 profile 的 cordis.patch.yml —— 那条行 id 相同且带绝对路径，
  // 后层胜，会盖掉 bundle 层并指向 node_modules 里的 .ts 源码（装出来的 dsh 无 tsx，加载即失败）。
  const routeOnly = argv.includes('--route-only')
  const profile = argv.find((arg) => !arg.startsWith('--')) ?? 'web'
  if (!existsSync(join(DSH_HOME, 'profiles', profile))) {
    console.error(`找不到 profile：${join(DSH_HOME, 'profiles', profile)}`)
    console.error('用法：node install.mjs [profile] [--with-patches]')
    return 1
  }

  console.log(bold('1/5 解析依赖'))
  const how = linkOrCopy(join(DSH_HOME, 'profiles', 'node_modules'), join(HERE, 'node_modules'))
  console.log(`     node_modules ${how === 'link' ? '已软链' : '已复制（本平台不允许软链）'}`)

  console.log(bold('2/5 安装 skill'))
  mkdirSync(join(homedir(), '.agents', 'skills'), { recursive: true })
  const skill = linkOrCopy(join(HERE, 'skills', 'deepseek-vision'), join(homedir(), '.agents', 'skills', 'deepseek-vision'))
  console.log(`     ~/.agents/skills/deepseek-vision ${skill === 'link' ? '已软链' : '已复制 —— 注意：改包内那份不会同步，需重跑本脚本'}`)

  console.log(bold('3/5 写入识图路由'))
  console.log(`     ${writeRoute()}`)

  console.log(bold(`4/5 挂到 profile：${profile}`))
  console.log(`     ${routeOnly ? '--route-only：跳过（插件行由 bundle 层提供）' : mountPlugin(profile)}`)

  if (withPatches) {
    console.log(bold('本体补丁'))
    console.log(`     ${await applyPatches()}`)
  }

  console.log(bold('5/5 自检'))
  const settings = existsSync(join(DSH_HOME, 'settings.yaml')) ? readFileSync(join(DSH_HOME, 'settings.yaml'), 'utf8') : ''
  const missing = []
  // settings.yaml 由 DSH 的设置写入器维护并会规范化格式（实测 `[text, image]` 被重写成
  // `[ text, image ]`），所以一律宽松匹配 —— 查的是「像不像配过」，不是「配得对不对」。
  if (!/^ *bailian:/m.test(settings)) missing.push('settings.yaml 里没有 bailian 路由')
  if (!/input:.*\btext\b.*\bimage\b/.test(settings)) missing.push('路由没声明 input: [text, image] —— 这一行是打开图像门禁的开关')
  if (!/thinkingFormat: *qwen/.test(settings)) missing.push('路由没有 compat.thinkingFormat: qwen —— 不关思维会白烧 113 倍 token')
  if (!process.env.BAILIAN_API_KEY) missing.push('当前环境没有 BAILIAN_API_KEY（也可在 Web 的 设置→模型 页存进凭据服务）')
  if (missing.length === 0) console.log('     全部就绪')
  else {
    warn('     还差以下几项，见 README「安装」：')
    for (const item of missing) warn(`       - ${item}`)
  }

  console.log(`\n${bold('⚠️  必须冷启动才生效')}`)
  console.log('   HMR 是关闭的，插件、skill、profile 补丁都不热加载，刷新浏览器不算。执行：\n')
  console.log(`     node ${JSON.stringify(join(HERE, 'install.mjs'))} --restart\n`)
  console.log('   如果你是跑在 dsh 里的 agent，就用上面这条，不要自己杀进程 ——')
  console.log('   杀了你自己就拿不到结果，也无法确认是否成功。这条会立即返回，重启在你身后完成。')
  return 0
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
