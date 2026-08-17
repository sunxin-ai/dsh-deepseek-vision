/**
 * 注入校验（RUBRIC §3「注入纪律」的程序化实现）。三层断言，任何一条不过即退出码 1：
 *
 * 1. 字符串锚点：每处缺陷的 v1 锚点必须在 v1.html 恰好出现 1 次、在 v2.html 出现 0 次，
 *    v2 锚点反之。证明「改动确实写进去了」。
 * 2. 像素生效：在该缺陷声明的每个区块内，v1.png 与 v2.png 必须有差异像素。
 *    证明「改动确实渲染出来了」——字符串改了但视觉无变化（例如字重落在同一字面上）会被这层抓住。
 * 3. 不越界：v1↔v2 实际发生变化的区块集合，必须等于全部缺陷声明区块的并集。
 *    证明「一处缺陷只影响一个区域，不重叠」，以及没有意外改动。
 *
 * 附带输出 design.png↔v1.png 的差异比例：v1 是误报率对照组，这个数字是它「确实忠实」的证据。
 *
 * 用法：node assert.mjs [group...]
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { GROUPS, DEFECTS } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCALE = 2
const TOL = 8 // 单通道差值阈值，滤掉抗锯齿噪声

const failures = []
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok }

/** 在浏览器里把两张同尺寸 PNG 逐像素比对，返回全图差异数与每个区块内的差异数。 */
async function diffByBlock(page, aPath, bPath, blocks) {
  const url = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64')
  return page.evaluate(async ([ua, ub, bl, scale, tol]) => {
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u })
    const [ia, ib] = await Promise.all([load(ua), load(ub)])
    if (ia.width !== ib.width || ia.height !== ib.height) throw new Error('两图尺寸不一致，无法比对')
    const W = ia.width, H = ia.height
    const px = (img) => {
      const c = new OffscreenCanvas(W, H); const x = c.getContext('2d')
      x.drawImage(img, 0, 0); return x.getImageData(0, 0, W, H).data
    }
    const da = px(ia), db = px(ib)
    const changed = new Uint8Array(W * H)
    let total = 0
    for (let i = 0, p = 0; p < W * H; p++, i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]))
      if (d > tol) { changed[p] = 1; total++ }
    }
    const per = {}
    for (const [name, [bx, by, bw, bh]] of Object.entries(bl)) {
      const x0 = bx * scale, y0 = by * scale, x1 = (bx + bw) * scale, y1 = (by + bh) * scale
      let n = 0
      for (let y = y0; y < y1 && y < H; y++) for (let x = x0; x < x1 && x < W; x++) if (changed[y * W + x]) n++
      per[name] = n
    }
    return { total, pixels: W * H, per }
  }, [url(aPath), url(bPath), blocks, SCALE, TOL])
}

const only = process.argv.slice(2)
const groups = only.length ? only : Object.keys(GROUPS)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
const summary = []

for (const group of groups) {
  const { blocks } = GROUPS[group]
  const defects = DEFECTS[group]
  const dir = join(here, group)
  const v1 = readFileSync(join(dir, 'v1.html'), 'utf-8')
  const v2 = readFileSync(join(dir, 'v2.html'), 'utf-8')
  console.log(`\n=== ${group} — ${defects.length} 处注入 ===`)

  // 1. 字符串锚点
  for (const d of defects) {
    const a = (v1.split(d.v1).length - 1), b = (v2.split(d.v1).length - 1)
    const c = (v2.split(d.v2).length - 1), e = (v1.split(d.v2).length - 1)
    check(a === 1, `${group}/${d.id}: v1 锚点在 v1.html 出现 ${a} 次（应为 1）`)
    check(b === 0, `${group}/${d.id}: v1 锚点在 v2.html 出现 ${b} 次（应为 0）`)
    check(c === 1, `${group}/${d.id}: v2 锚点在 v2.html 出现 ${c} 次（应为 1）`)
    check(e === 0, `${group}/${d.id}: v2 锚点在 v1.html 出现 ${e} 次（应为 0）`)
  }

  // 2 + 3. 像素层
  const dv = await diffByBlock(page, join(dir, 'v1.png'), join(dir, 'v2.png'), blocks)
  const declared = new Set(defects.flatMap((d) => d.blocks))
  const actual = new Set(Object.entries(dv.per).filter(([, n]) => n > 0).map(([k]) => k))

  for (const d of defects) {
    const dead = d.blocks.filter((b) => (dv.per[b] ?? 0) === 0)
    check(dead.length === 0, `${group}/${d.id}: 声明区块 ${dead.join(',')} 内无像素变化（注入未生效）`)
  }
  const stray = [...actual].filter((b) => !declared.has(b))
  check(stray.length === 0, `${group}: 未声明区块发生变化 -> ${stray.join(', ')}`)
  const silent = [...declared].filter((b) => !actual.has(b))
  check(silent.length === 0, `${group}: 声明了但无变化的区块 -> ${silent.join(', ')}`)

  // v1 忠实度
  const fv = await diffByBlock(page, join(dir, 'design.png'), join(dir, 'v1.png'), blocks)
  const fidelity = (fv.total / fv.pixels * 100)

  // diff 有差异时退出码为 1，execFileSync 会抛错；差异内容在 err.stdout 上。
  let raw
  try { raw = execFileSync('diff', [join(dir, 'v1.html'), join(dir, 'v2.html')], { encoding: 'utf-8' }) }
  catch (err) { raw = err.stdout ?? '' }
  const diffLines = raw.split('\n').filter((l) => /^[<>]/.test(l)).length

  for (const d of defects) {
    const marks = d.blocks.map((b) => `${b}=${dv.per[b]}`).join(' ')
    console.log(`  [${d.tier}] ${d.id.padEnd(3)} ${d.facet.padEnd(4)} 变化像素 ${marks}`)
  }
  console.log(`  v1↔v2 变化 ${dv.total} px (${(dv.total / dv.pixels * 100).toFixed(2)}%)，` +
              `HTML diff ${diffLines} 行（含 2 行 title/注释标记 ×2 侧）`)
  console.log(`  design↔v1 残余 ${fv.total} px (${fidelity.toFixed(3)}%) — 忠实实现对照组`)
  summary.push({ group, n: defects.length, diffLines, fidelity, changed: dv.total })
}

await page.close()
await browser.close()

console.log('\n=== 汇总 ===')
for (const s of summary) {
  console.log(`  ${s.group.padEnd(10)} 缺陷 ${s.n}  HTML diff ${String(s.diffLines).padStart(3)} 行  ` +
              `v1↔v2 变化 ${String(s.changed).padStart(7)} px  design↔v1 残余 ${s.fidelity.toFixed(3)}%`)
}
if (failures.length) {
  console.error(`\n断言失败 ${failures.length} 条：`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('\n全部断言通过 ✓')
