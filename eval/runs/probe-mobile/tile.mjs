/**
 * tile.mjs —— 分区平铺送检的夹具生成器（DESIGN.md §4.3）
 *
 * 整页拼图实测不可用：1644×1800 送进视觉模型后被降采样到约 375px 有效宽度，
 * 低于 393px 的 CSS 逻辑宽度，字重与 8px 间距在该尺度上物理不可分辨。
 * 本脚本按语义区块切分，每区单独拼成 1:1 对比图，不做任何缩放。
 *
 * 区块边界取自实现页面的真实 bounding box，不用等分网格 —— 等分会把一个卡片切成两半。
 * 相邻区块各外扩 PAD_CSS，保证跨区边界的间距问题两边都能看到。
 */
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const VIEWPORT = { width: 393, height: 852 }
const SCALE = 2
const PAD_CSS = 20

// 语义区块，不是等分网格。顺序即页面自上而下的扫描顺序。
const REGIONS = [
  { name: 'header', selector: '.greet', extend: '.date' },
  { name: 'ring', selector: '.ringcard' },
  { name: 'stats', selector: '.stats' },
  { name: 'chart', selector: '.chart' },
  { name: 'tabbar', selector: '.tabbar' },
]

// 整页作为一个伪区块一起产出，让「整页 vs 分区」的对照组走完全相同的拼图代码，
// 不掺入旧脚本的排版差异。
const FULL = { name: 'full', top: 0, bottom: VIEWPORT.height }

function fail(message) {
  console.error(message)
  process.exit(1)
}

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  return process.argv[index + 1]
}

function dataUri(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
}

async function main() {
  // 区块边界一律取自参考实现（忠实版 v1），不取自被测版本。
  // 若从被测版本取边界，间距类缺陷会连同窗口一起平移，模型永远看不到它。
  const refHtml = path.resolve(arg('--ref'))
  const designPng = path.resolve(arg('--design'))
  const shotPng = path.resolve(arg('--shot'))
  const outDir = path.resolve(arg('--out'))
  const label = arg('--label', path.basename(shotPng, '.png'))

  for (const file of [refHtml, designPng, shotPng]) {
    if (!fs.existsSync(file)) fail(`缺少输入文件: ${file}`)
  }
  fs.mkdirSync(outDir, { recursive: true })

  const browser = await chromium.launch()

  // 第一步：从参考实现读真实区块边界（CSS px）。
  const measure = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
  await measure.goto(`file://${refHtml}`)
  const bands = []
  for (const region of REGIONS) {
    const box = await measure.locator(region.selector).first().boundingBox()
    if (!box) fail(`区块 ${region.name} 的选择器 ${region.selector} 未命中`)
    let bottom = box.y + box.height
    if (region.extend) {
      const tail = await measure.locator(region.extend).first().boundingBox()
      if (!tail) fail(`区块 ${region.name} 的扩展选择器 ${region.extend} 未命中`)
      bottom = Math.max(bottom, tail.y + tail.height)
    }
    bands.push({ name: region.name, top: box.y - PAD_CSS, bottom: bottom + PAD_CSS })
  }
  bands.push(FULL)
  await measure.close()

  // 第二步：按同一组 y 坐标切设计稿与实现截图，左右并排，1:1 不缩放。
  const pageHeightPx = VIEWPORT.height * SCALE
  const widthPx = VIEWPORT.width * SCALE
  const written = []

  // setContent 的文档源是 about:blank，其下的 file:// 子资源会被拦截，
  // 图片加载失败时截出来的是两块空白且左右一模一样 —— 内联成 data URI 规避。
  const designUri = dataUri(designPng)
  const shotUri = dataUri(shotPng)

  for (const band of bands) {
    const topPx = Math.max(0, Math.round(band.top * SCALE))
    const bottomPx = Math.min(pageHeightPx, Math.round(band.bottom * SCALE))
    const heightPx = bottomPx - topPx
    if (heightPx <= 0) fail(`区块 ${band.name} 的高度为 ${heightPx}px`)

    // 三个产物：并排拼图（单图送检）、A 单图、B 单图（双图送检）。
    // 拼图不再写「A — 设计稿」这类标注 —— 实测模型会把标注读成页面内容，
    // 问大标题答「A — DESIGN (source of truth)」。哪边是哪边改由提示词声明。
    const shots = [
      { suffix: '', panes: [designUri, shotUri] },
      { suffix: '__A', panes: [designUri] },
      { suffix: '__B', panes: [shotUri] },
    ]

    for (const { suffix, panes } of shots) {
      const wins = panes.map((uri, index) =>
        `<div class="win"><img id="i${index}" src="${uri}"></div>`).join('')
      const html = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box }
  body { background: #FFFFFF }
  .row { display: flex; gap: 24px; padding: 12px }
  .win { width: ${widthPx}px; height: ${heightPx}px; overflow: hidden; position: relative }
  .win img { position: absolute; left: 0; top: ${-topPx}px; width: ${widthPx}px; display: block }
</style>
<div class="row">${wins}</div>`

      const page = await browser.newPage({
        viewport: { width: widthPx * panes.length + 24 * panes.length, height: heightPx + 24 },
        deviceScaleFactor: 1,
      })
      await page.setContent(html)
      // 断言每张图都真的解码了，否则截出来是空白，且各 arm 之间字节完全相同。
      const decoded = await page.evaluate((count) => Array.from({ length: count }, (_, index) => {
        const img = document.getElementById(`i${index}`)
        return img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0
      }), panes.length)
      if (decoded.some((width) => width === 0)) fail(`区块 ${band.name}${suffix} 有图片未解码: ${decoded.join(',')}`)
      const out = path.join(outDir, `${label}__${band.name}${suffix}.png`)
      await page.screenshot({ path: out })
      await page.close()
      if (suffix === '') written.push({ region: band.name, file: out, topPx, bottomPx, heightPx, widthPx })
    }
  }

  await browser.close()

  // 断言：拼图里实现侧的宽度必须 >= CSS 逻辑宽度，否则分区没有解决降采样问题。
  for (const item of written) {
    if (item.widthPx < VIEWPORT.width) fail(`区块 ${item.region} 有效宽度 ${item.widthPx} 低于 CSS 逻辑宽度 ${VIEWPORT.width}`)
    console.log(`${item.region.padEnd(8)} ${item.widthPx}x${item.heightPx}  ${path.basename(item.file)}`)
  }
  fs.writeFileSync(path.join(outDir, `${label}__regions.json`), JSON.stringify(written, null, 2))
}

main()
