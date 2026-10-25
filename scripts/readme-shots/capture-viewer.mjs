/**
 * Open the viewer web build against the demo hub and save README PNGs.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(
  '/Users/gianlucaruocco/Documents/Git/camstack/camstack-server/package.json',
)
const { chromium } = require('playwright')

const HUB = 'http://127.0.0.1:8791'
const APP = process.env.VIEWER_URL ?? 'http://127.0.0.1:8095'
const OUT = process.env.README_OUT ?? 'docs/assets/readme'

function secretKeySafe(id) {
  let out = ''
  for (let i = 0; i < id.length; i += 1) {
    const ch = id.charAt(i)
    out += /^[A-Za-z0-9.-]$/.test(ch) ? ch : `_${id.charCodeAt(i).toString(16).padStart(4, '0')}`
  }
  return out
}

function token() {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000, sub: 'demo' })).toString(
    'base64',
  )
  return `eyJhbGciOiJub25lIn0.${payload}.demo`
}

function seed(page) {
  const id = HUB
  const servers = JSON.stringify([
    {
      id,
      label: 'Home hub',
      serverUrl: HUB,
      name: 'Home hub',
      lastUsedAt: Date.now(),
    },
  ])
  const key = `v2.token.${secretKeySafe(id)}`
  return page.addInitScript(
    ({ servers, id, key, token, theme }) => {
      localStorage.setItem('v2.servers', servers)
      localStorage.setItem('v2.activeServerId', id)
      localStorage.setItem(key, token)
      localStorage.setItem('v2.theme', theme)
      localStorage.setItem('v2.language', 'en')
      localStorage.setItem('camstack.v2.whats-new.seen', '1.0.660')
    },
    { servers, id, key, token: token(), theme: 'dark' },
  )
}

async function shoot(page, name, width, height) {
  await page.setViewportSize({ width, height })
  const file = join(OUT, name)
  await page.screenshot({ path: file })
  process.stdout.write(`wrote ${file}\n`)
}

async function waitForText(page, text, ms) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: ms })
}

async function dismissNotes(page) {
  const ok = page.getByRole('button', { name: 'OK' })
  if (await ok.count()) {
    await ok.first().click()
    await page.waitForTimeout(400)
  }
}

async function waitForPicture(page) {
  await page
    .waitForFunction(
      () => {
        const images = [...document.querySelectorAll('img')]
        return images.some(
          (img) => img.naturalWidth > 40 && (img.currentSrc || img.src).includes('8791'),
        )
      },
      { timeout: 20_000 },
    )
    .catch(() => {})
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: 'dark' })
  page.on('pageerror', (err) => process.stdout.write(`pageerror ${err.message.split('\n')[0]}\n`))
  page.on('response', (res) => {
    const url = res.url()
    if ((url.includes('snapshot') || url.includes('event-media')) && res.status() >= 400) {
      process.stdout.write(`img ${res.status()} ${url.slice(0, 180)}\n`)
    }
  })
  await seed(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${APP}/cameras`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await waitForText(page, 'Front door', 180_000)
  await dismissNotes(page)
  await waitForPicture(page)
  await page.waitForTimeout(600)
  await shoot(page, 'viewer-grid-desktop.png', 1440, 900)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${APP}/cameras`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForText(page, 'Front door', 60_000)
  await dismissNotes(page)
  await waitForPicture(page)
  await page.waitForTimeout(600)
  await shoot(page, 'viewer-grid-phone.png', 390, 844)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${APP}/camera/1`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForText(page, 'Front door', 60_000)
  await dismissNotes(page)
  await waitForPicture(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'viewer-live-desktop.png') })
  process.stdout.write(`wrote ${join(OUT, 'viewer-live-desktop.png')}\n`)

  await page.mouse.click(1260, 520)
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT, 'viewer-playback-desktop.png') })
  process.stdout.write(`wrote ${join(OUT, 'viewer-playback-desktop.png')}\n`)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForPicture(page)
  const firstEvent = page
    .locator('img')
    .filter({ hasNot: page.locator('[alt=""]') })
    .first()
  if (await firstEvent.count()) await firstEvent.click()
  await page.waitForTimeout(700)
  await shoot(page, 'viewer-events-desktop.png', 1440, 900)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForPicture(page)
  await page.waitForTimeout(500)
  await shoot(page, 'viewer-events-phone.png', 390, 844)

  await browser.close()
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
