/**
 * evalset 截图脚本：按 fixtures.mjs 声明的视口与语义区块，为每组夹具出整页截图与区块裁剪。
 *
 * 1. 每组按声明的 CSS 视口 + deviceScaleFactor=2 截图，产出的像素尺寸对同一组内
 *    design / v1 / v2 完全一致，因此无需任何事后缩放即可 1:1 对比。
 * 2. 三重断言：
 *    a. CSS 渲染尺寸 == 视口（偏差 >1px 直接抛错）
 *    b. 内容未溢出被裁切（scrollHeight <= 视口高 + 1）
 *    c. 落盘 PNG 的 IHDR 实际像素尺寸 == 视口 × scale
 *    任何一条不过就抛错——被缩放或被裁切的截图不能用来做保真判断。
 * 3. `--crops` 按 BLOCKS 声明的语义区块出分区图。视觉模型对单张图收固定 token 预算
 *    （约 1024 tokens，与图像尺寸无关），整页大图必被降采样、细节丢失，因此判定按区块送检。
 *    带 `seam-` 前缀的区块是**跨区块缝隙**，专为「区块间距」类缺陷准备：这类缺陷在任一
 *    单独区块内都看不出来，只有把上下两块一起裁进来才可归因。
 *
 * 用法：
 *   node shoot.mjs                    # 全部四组整页图
 *   node shoot.mjs landing form       # 只跑指定组
 *   node shoot.mjs --crops            # 整页图 + 分区图（写到 <group>/crops/）
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { GROUPS } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SCALE = 2

const VARIANTS = ['design', 'v1', 'v2']

/** 从 PNG 头部 IHDR 读实际像素宽高，用于校验落盘文件而不只是渲染上下文。 */
function pngSize(path) {
  const buf = readFileSync(path)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 按精确视口与像素密度截取一个文件，断言尺寸与无裁切，可选出分区图。 */
async function shoot(browser, group, variant, withCrops) {
  const { viewport, blocks } = GROUPS[group]
  const src = join(here, group, `${variant}.html`)
  if (!existsSync(src)) return null
  const page = await browser.newPage({ viewport, deviceScaleFactor: SCALE })
  await page.goto('file://' + src)
  await page.waitForLoadState('networkidle')

  const box = await page.evaluate(() => ({
    w: document.body.clientWidth,
    h: document.body.clientHeight,
    scroll: document.body.scrollHeight,
  }))
  if (Math.abs(box.w - viewport.width) > 1 || Math.abs(box.h - viewport.height) > 1) {
    throw new Error(`${group}/${variant}: CSS 尺寸应为 ${viewport.width}x${viewport.height}，实得 ${box.w}x${box.h}`)
  }
  if (box.scroll > viewport.height + 1) {
    throw new Error(`${group}/${variant}: 内容溢出被裁切，scrollHeight=${box.scroll} > ${viewport.height}`)
  }

  const out = join(here, group, `${variant}.png`)
  await page.screenshot({ path: out })

  const px = pngSize(out)
  const want = { width: viewport.width * SCALE, height: viewport.height * SCALE }
  if (px.width !== want.width || px.height !== want.height) {
    throw new Error(`${group}/${variant}: PNG 应为 ${want.width}x${want.height}，实得 ${px.width}x${px.height}`)
  }
  console.log(`  ${group}/${variant}.png  CSS ${box.w}x${box.h} @${SCALE}x -> ${px.width}x${px.height}`)

  if (withCrops) {
    const dir = join(here, group, 'crops')
    mkdirSync(dir, { recursive: true })
    for (const [name, [x, y, w, h]] of Object.entries(blocks)) {
      if (x + w > viewport.width || y + h > viewport.height) {
        throw new Error(`${group}: 区块 ${name} [${x},${y},${w},${h}] 超出视口`)
      }
      await page.screenshot({ path: join(dir, `${variant}__${name}.png`), clip: { x, y, width: w, height: h } })
    }
    console.log(`    分区图 ${Object.keys(blocks).length} 张 -> ${group}/crops/${variant}__*.png`)
  }

  await page.close()
  return out
}

const args = process.argv.slice(2)
const withCrops = args.includes('--crops')
const only = args.filter((a) => !a.startsWith('--'))
const groups = only.length ? only : Object.keys(GROUPS)
for (const g of groups) {
  if (!GROUPS[g]) throw new Error(`未知夹具组：${g}（可选：${Object.keys(GROUPS).join(', ')}）`)
}

const browser = await chromium.launch()
for (const group of groups) {
  const { kind, viewport } = GROUPS[group]
  console.log(`[${group}] ${kind} ${viewport.width}x${viewport.height}`)
  for (const variant of VARIANTS) await shoot(browser, group, variant, withCrops)
}
await browser.close()
console.log('完成')
