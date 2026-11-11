#!/usr/bin/env node
/**
 * Card parity: shoots the approved card mockup and the implemented device card
 * with the same data, and lays each pair side by side.
 *
 *   node scripts/ui/card-parity.mjs --mockup <card-grid.html> [--types plug,climate] [--label card-parity]
 *
 * The implementation side is `npm run ui:shots` on the harness route
 * `/device-card-preview?type=<type>`, which renders the fixtures in
 * `packages/ui-library/src/composites/device-card/__fixtures__/` — the mockup's
 * own data. The mockup side is the mockup file opened as it is, on the same
 * type page. Both are shot light and dark, at 1440x900 and 390x844.
 *
 * Output (gitignored): scratchpad/ui-shots/<label>/
 *   mockup/<type>--<viewport>-<theme>.png
 *   impl-<type>/…                              (the ui:shots run)
 *   <type>--<viewport>-<theme>--side-by-side.png
 *   report.md                                  (one table per type)
 *
 * The mockup lives in the private planning repo, so its path is an argument and
 * nothing here is wired into CI: this is the tool a card change is reviewed with.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..', '..')
/**
 * `tall` is the height the implementation is shot at: ui:shots captures the
 * viewport, and a type page holds more cards than one screen.
 */
const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, tall: 4200 },
  { id: 'phone', width: 390, height: 844, tall: 6400 },
]
const THEMES = ['light', 'dark']
const GAP = 24
const SETTLE_MS = 400

function parseArgs(argv) {
  const out = { types: ['plug', 'climate'], label: 'card-parity', mockup: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--mockup') out.mockup = value
    else if (flag === '--types') out.types = value.split(',').filter((t) => t.length > 0)
    else if (flag === '--label') out.label = value
    else continue
    i += 1
  }
  return out
}

function fail(message) {
  console.error(`card-parity: ${message}`)
  process.exit(1)
}

async function shootMockup(mockup, types, dir) {
  const browser = await chromium.launch()
  try {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
        })
        await page.goto(pathToFileURL(mockup).href)
        for (const type of types) {
          const tab = page.locator(`[data-go="${type}"]`)
          if ((await tab.count()) === 0) fail(`the mockup has no page for "${type}"`)
          await tab.first().click()
          await page.waitForTimeout(SETTLE_MS)
          // The section that holds the cards; the page also carries the option
          // panel and the device-row list, which the card does not draw.
          const pageRoot = page.locator(`.page[data-page="${type}"]`)
          const cards = pageRoot.locator('section:has(.card)')
          const target = (await cards.count()) > 0 ? cards.first() : pageRoot
          await target.screenshot({ path: join(dir, `${type}--${viewport.id}-${theme}.png`) })
        }
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}

function shootImplementation(type, dir) {
  const run = spawnSync(
    'npm',
    [
      'run',
      '-s',
      'ui:shots',
      '--',
      '--route',
      `/device-card-preview?type=${type}`,
      '--out',
      dir,
      ...VIEWPORTS.flatMap((v) => ['--viewport', `${v.width}x${v.tall}`]),
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  if (run.status !== 0) fail(`ui:shots failed for "${type}" (exit ${run.status})`)
}

/** Cuts the empty tail a tall viewport leaves under the last card. */
async function trimmed(file) {
  const out = file.replace(/\.png$/, '.trim.png')
  await sharp(file).trim().toFile(out)
  return out
}

async function sideBySide(left, right, out) {
  const [a, b] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()])
  await sharp({
    create: {
      width: a.width + GAP + b.width,
      height: Math.max(a.height, b.height),
      channels: 4,
      background: { r: 127, g: 127, b: 127, alpha: 1 },
    },
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: a.width + GAP, top: 0 },
    ])
    .png()
    .toFile(out)
  return { mockup: `${a.width}x${a.height}`, implementation: `${b.width}x${b.height}` }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mockup === null) fail('--mockup <path to the approved card mockup html> is required')
  const mockup = resolve(args.mockup)
  if (!existsSync(mockup)) fail(`no mockup at ${mockup}`)

  const outDir = join(ROOT, 'scratchpad', 'ui-shots', args.label)
  const mockupDir = join(outDir, 'mockup')
  mkdirSync(mockupDir, { recursive: true })
  await shootMockup(mockup, args.types, mockupDir)

  const lines = [
    `# Card parity — ${args.label}`,
    '',
    'Left: the approved mockup. Right: the implemented card, same data.',
    '',
  ]
  for (const type of args.types) {
    const implDir = join(outDir, `impl-${type}`)
    shootImplementation(type, implDir)
    lines.push(`## ${type}`, '', '| Viewport | Theme | Mockup | Implementation | Side by side |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        const suffix = `${viewport.id}-${theme}`
        const left = join(mockupDir, `${type}--${suffix}.png`)
        const shot = join(
          implDir,
          `device-card-preview-type-${type}--${viewport.width}x${viewport.tall}-${theme}.png`,
        )
        if (!existsSync(shot)) fail(`ui:shots wrote no ${shot}`)
        const right = await trimmed(shot)
        const name = `${type}--${suffix}--side-by-side.png`
        const size = await sideBySide(left, right, join(outDir, name))
        lines.push(
          `| ${viewport.id} ${viewport.width}x${viewport.height} | ${theme} | ${size.mockup} | ${size.implementation} | ![](${name}) |`,
        )
      }
    }
    lines.push('')
  }
  writeFileSync(join(outDir, 'report.md'), `${lines.join('\n')}\n`)
  console.log(`card-parity: ${join(outDir, 'report.md')}`)
}

await main()
