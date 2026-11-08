/**
 * `npx tsx scripts/ui/shots/hero-compare.ts [--ids 1101,1105] [--out <dir>] [--mock <dir>]`
 *
 * Shoots every mockup device of `fixtures/hero-mockups.ts` (the preview page, light
 * and dark, desktop 1440x900 and phone 390x844) and builds, per device, a
 * SIDE-BY-SIDE PNG: the operator's mockup crop on the left, our shot on the right
 * (desktop dark, the mockup's own theme), plus the light / phone shots below it.
 * Output: `<out>/<id>-<key>.png` (side by side) and the raw shots in `<out>/raw/`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import { MOCKUP_SPECS } from './fixtures/hero-mockups'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const MOCK_DEFAULT =
  '/private/tmp/claude-501/-Users-gianlucaruocco-Documents-Git-camstack-camstack-server/a7dc4296-811a-4e15-8ef1-69a25b4b11c3/scratchpad/hero-mock/png'

interface Crop {
  readonly file: string
  /** In the displayed (scaled) image the operator's PNG was read at; scaled up by `k`. */
  readonly k: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly key: string
}

const T1 = 1.17
const T2 = 1.53
const col1 = [55, 438, 821]
const col2 = [42, 335, 627]
const c = (
  file: string,
  k: number,
  key: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Crop => ({
  file,
  k,
  key,
  x,
  y,
  w,
  h,
})
/** Mockup card boxes, in the displayed coordinates of each PNG. */
export const CROPS: Readonly<Record<number, Crop>> = {
  1101: c('Tutti1.png', T1, 'clima', col1[0]!, 162, 356, 400),
  1102: c('Tutti1.png', T1, 'termostato', col1[1]!, 162, 356, 348),
  1103: c('Tutti1.png', T1, 'stufa', col1[2]!, 162, 356, 344),
  1104: c('Tutti1.png', T1, 'ventilatore', col1[0]!, 648, 356, 348),
  1105: c('Tutti1.png', T1, 'lavatrice', col1[1]!, 648, 356, 350),
  1106: c('Tutti1.png', T1, 'asciugatrice', col1[2]!, 648, 356, 350),
  1107: c('Tutti1.png', T1, 'lavastoviglie', col1[0]!, 1070, 356, 304),
  1108: c('Tutti1.png', T1, 'fontanella', col1[1]!, 1070, 356, 364),
  1109: c('Tutti1.png', T1, 'feeder', col1[2]!, 1070, 356, 360),
  1201: c('Tutti2.png', T2, 'robot', col2[0]!, 124, 273, 265),
  1202: c('Tutti2.png', T2, 'tagliaerba', col2[1]!, 124, 273, 262),
  1203: c('Tutti2.png', T2, 'tv', col2[2]!, 124, 273, 295),
  1204: c('Tutti2.png', T2, 'altoparlante', col2[0]!, 473, 273, 255),
  1205: c('Tutti2.png', T2, 'videocamera', col2[1]!, 473, 273, 255),
  1206: c('Tutti2.png', T2, 'luce', col2[2]!, 473, 273, 262),
  1207: c('Tutti2.png', T2, 'tapparella', col2[0]!, 795, 273, 262),
  1208: c('Tutti2.png', T2, 'serratura', col2[1]!, 795, 273, 262),
  1209: c('Tutti2.png', T2, 'allarme', col2[2]!, 795, 273, 230),
  1210: c('Tutti2.png', T2, 'sirena', col2[0]!, 1130, 273, 220),
  1301: c('Tutti3.png', T2, 'temperatura', col2[0]!, 124, 273, 262),
  1302: c('Tutti3.png', T2, 'contatto', col2[1]!, 124, 273, 227),
  1303: c('Tutti3.png', T2, 'presenza', col2[2]!, 124, 273, 227),
  1304: c('Tutti3.png', T2, 'meteo', col2[0]!, 452, 273, 262),
  1305: c('Tutti3.png', T2, 'presa', col2[1]!, 452, 273, 262),
  1306: c('Tutti3.png', T2, 'pulsante', col2[2]!, 452, 273, 227),
  1307: c('Tutti3.png', T2, 'aggiornamento', col2[0]!, 780, 273, 227),
  1308: c('Tutti3.png', T2, 'controllo', col2[1]!, 780, 273, 207),
  1309: c('Tutti3.png', T2, 'eventi', col2[2]!, 780, 273, 207),
  1310: c('Tutti3.png', T2, 'gateway', col2[0]!, 1073, 273, 227),
  1311: c('Tutti3.png', T2, 'comando', col2[1]!, 1073, 273, 207),
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const ids = (arg('ids')?.split(',').map(Number) ?? Object.keys(MOCKUP_SPECS).map(Number)).filter(
  (id) => id in MOCKUP_SPECS,
)
const OUT = path.resolve(ROOT, arg('out') ?? 'scratchpad/ui-shots/hero-compare')
const MOCK = arg('mock') ?? MOCK_DEFAULT
const RAW = path.join(OUT, 'raw')
const SHOTS = [
  { name: 'desktop-dark', w: 1440, h: 900, theme: 'dark' },
  { name: 'desktop-light', w: 1440, h: 900, theme: 'light' },
  { name: 'phone-dark', w: 390, h: 844, theme: 'dark' },
  { name: 'phone-light', w: 390, h: 844, theme: 'light' },
] as const

async function shootAll(): Promise<void> {
  const { chromium } = await import('playwright')
  const { createServer } = await import('vite')
  const server = await createServer({
    configFile: path.join(__dirname, 'harness', 'vite.config.ts'),
    server: { port: Number(arg('port') ?? 3968) },
  })
  await server.listen()
  const browser = await chromium.launch()
  try {
    for (const shot of SHOTS) {
      const ctx = await browser.newContext({
        viewport: { width: shot.w, height: shot.h },
        deviceScaleFactor: 2,
        colorScheme: shot.theme,
      })
      await ctx.addInitScript('globalThis.__name = (f) => f')
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.split('\n')[0]}`))
      await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 9, 9, 31)))
      const q = new URLSearchParams({ fx: 'hero-mockups', theme: shot.theme, ids: ids.join(',') })
      await page.goto(`http://127.0.0.1:${server.config.server.port}/device-module-preview?${q}`)
      await page.waitForSelector('[data-device-id] [data-testid="device-detail-module"]', {
        timeout: 180_000,
      })
      await page.waitForTimeout(3500)
      for (const id of ids) {
        const cell = page.locator(`[data-device-id="${String(id)}"]`)
        await cell.screenshot({ path: path.join(RAW, `${String(id)}-${shot.name}.png`) })
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

async function sideBySide(id: number): Promise<void> {
  const crop = CROPS[id]
  if (crop === undefined) return
  const mock = sharp(path.join(MOCK, crop.file))
  const meta = await mock.metadata()
  const left = Math.round(crop.x * crop.k)
  const top = Math.round(crop.y * crop.k)
  const width = Math.min(Math.round(crop.w * crop.k), (meta.width ?? 0) - left)
  const mockBuf = await sharp(path.join(MOCK, crop.file))
    .extract({ left, top, width, height: Math.round(crop.h * crop.k) })
    .png()
    .toBuffer()
  const theirs = await sharp(path.join(RAW, `${String(id)}-desktop-dark.png`))
    .png()
    .toBuffer()
  const tm = await sharp(theirs).metadata()
  const mm = await sharp(mockBuf).metadata()
  // Both at the same scale: ours is shot at 2x, the mockup is 1x of a 1440 canvas.
  const oursScaled = await sharp(theirs)
    .resize({ width: Math.round((tm.width ?? 0) / 2) })
    .png()
    .toBuffer()
  const om = await sharp(oursScaled).metadata()
  const h = Math.max(mm.height ?? 0, om.height ?? 0)
  const gap = 16
  await sharp({
    create: {
      width: (mm.width ?? 0) + gap + (om.width ?? 0),
      height: h,
      channels: 4,
      background: { r: 14, g: 16, b: 20, alpha: 1 },
    },
  })
    .composite([
      { input: mockBuf, left: 0, top: 0 },
      { input: oursScaled, left: (mm.width ?? 0) + gap, top: 0 },
    ])
    .png()
    .toFile(path.join(OUT, `${String(id)}-${crop.key}.png`))
}

async function main(): Promise<void> {
  fs.mkdirSync(RAW, { recursive: true })
  await shootAll()
  for (const id of ids) await sideBySide(id)
  console.log(`hero-compare: ${String(ids.length)} device(s) -> ${OUT}`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
