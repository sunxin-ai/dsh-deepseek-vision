/**
 * pair.mjs —— 把两张已裁好的区块图并排拼成一张送检图。
 *
 * 与 tile.mjs 的分工：tile.mjs 负责从整页切区块，pair.mjs 只负责把任意两张现成的图配对。
 * evalset 的夹具已自带区块裁剪，用这个直接配对即可。
 *
 * 图上不写任何标注文字 —— 实测模型会把标注读成页面内容
 * （问大标题，答「A — DESIGN (source of truth)」）。哪边是哪边由提示词声明。
 *
 * 图片一律内联成 data URI 并断言 naturalWidth>0：setContent 的文档源是 about:blank，
 * 其下的 file:// 子资源被静默拦截，且 waitForLoadState('networkidle') 不会报错。
 * 本仓库有整整两轮基准跑在这样产出的空白图上。
 */
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const GAP = 24

function arg(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) throw new Error(`缺少参数 ${flag}`)
  return process.argv[index + 1]
}

function dataUri(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
}

function size(file) {
  const head = fs.readFileSync(file).subarray(16, 24)
  return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) }
}

const left = path.resolve(arg('--left'))
const right = path.resolve(arg('--right'))
const out = path.resolve(arg('--out'))

for (const file of [left, right]) {
  if (!fs.existsSync(file)) throw new Error(`缺少输入文件: ${file}`)
}

const a = size(left)
const b = size(right)
if (a.width !== b.width || a.height !== b.height) {
  throw new Error(`两侧尺寸不一致: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
}

fs.mkdirSync(path.dirname(out), { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: a.width * 2 + GAP * 3, height: a.height + GAP * 2 },
  deviceScaleFactor: 1,
})
await page.setContent(`<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0 }
  body { background: #FFFFFF }
  .row { display: flex; gap: ${GAP}px; padding: ${GAP}px }
  img { display: block; width: ${a.width}px; height: ${a.height}px }
</style>
<div class="row"><img id="i0" src="${dataUri(left)}"><img id="i1" src="${dataUri(right)}"></div>`)

const decoded = await page.evaluate(() =>
  ['i0', 'i1'].map((id) => document.getElementById(id).naturalWidth))
if (decoded.some((width) => width === 0)) throw new Error(`图片未解码: ${decoded.join(',')}`)

await page.screenshot({ path: out })
await browser.close()
console.log(`${path.basename(out)}  ${a.width * 2 + GAP * 3}x${a.height + GAP * 2}`)
