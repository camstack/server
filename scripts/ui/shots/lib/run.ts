/**
 * The `ui:shots` run: start the harness dev server, shoot every route ×
 * viewport × theme with Playwright, measure each page, write the report.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser, Page } from 'playwright'
import type { ShotsArgs, Theme, Viewport } from './args.js'
import { measureInPage, scrollForSticky, stickyProbe, summarizeMeasure } from './measure.js'
import { imageName, renderReport, type ShotRecord, type ShotsReport } from './report.js'

const HARNESS = path.resolve(import.meta.dirname, '..', 'harness')
/** One minute after the fixtures' NOW (`fixtures/_time.ts`). */
const FROZEN_CLOCK = Date.UTC(2026, 9, 9, 9, 31)
const FIRST_LOAD_TIMEOUT_MS = 180_000
const LOAD_TIMEOUT_MS = 60_000
const STICKY_SETTLE_MS = 250

export const INSTALL_HINT =
  'Playwright has no Chromium here: run `npx playwright install chromium` once.'

export interface RunResult {
  readonly report: ShotsReport
  readonly markdownPath: string
}

function commitOf(root: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== ''
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return 'unknown'
  }
}

function harnessUrl(
  port: number,
  route: string,
  fixtures: ShotsArgs['fixtures'],
  theme: Theme,
): string {
  const q = new URLSearchParams({ fx: fixtures === 'all' ? 'all' : fixtures.join(','), theme })
  // The query goes BEFORE a fragment (`/sso-complete#return=oauth&…`), or the harness switches would be swallowed by it.
  const hashAt = route.indexOf('#')
  const pathAndQuery = hashAt === -1 ? route : route.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : route.slice(hashAt)
  return `http://127.0.0.1:${port}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}${q}${hash}`
}

/** Run one `--step` (see `lib/args.ts`) on the page. */
async function runStep(page: Page, step: string): Promise<void> {
  const [kind, ...rest] = step.split(':')
  if (kind === 'wait') {
    await page.waitForTimeout(Number(rest[0] ?? 0))
  } else if (kind === 'key') {
    await page.keyboard.press(rest.join(':'))
  } else if (kind === 'js') {
    // A page expression, its JSON on stdout — to assert layout facts the shot cannot show.
    const value: unknown = await page.evaluate(rest.join(':'))
    console.log(`  [js] ${JSON.stringify(value)}`)
  } else if (kind === 'click') {
    await page.locator(rest.join(':')).first().click()
  } else if (kind === 'mouse') {
    const fy = Number(rest.at(-1))
    const fx = Number(rest.at(-2))
    const box = await page.locator(rest.slice(0, -2).join(':')).first().boundingBox()
    if (box === null) throw new Error(`--step ${step}: element has no box`)
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 4 })
  } else {
    throw new Error(`--step: unknown action "${step}"`)
  }
  await page.waitForTimeout(300)
}

async function shoot(
  browser: Browser,
  args: ShotsArgs,
  route: string,
  viewport: Viewport,
  theme: Theme,
  firstLoad: boolean,
): Promise<ShotRecord> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  })
  try {
    // tsx/esbuild may wrap named functions in `__name(...)`; page.evaluate
    // ships the source, so give the page a no-op of that helper.
    await ctx.addInitScript('globalThis.__name = (f) => f')
    const page = await ctx.newPage()
    await page.clock.setFixedTime(new Date(FROZEN_CLOCK))
    const pageErrors: string[] = []
    page.on('pageerror', (e) =>
      // UI_SHOTS_STACK=1: the whole stack, to find which component threw.
      pageErrors.push(
        process.env['UI_SHOTS_STACK'] === '1'
          ? String(e.stack)
          : (e.message.split('\n')[0] ?? e.message),
      ),
    )
    if (process.env['UI_SHOTS_DEBUG'] === '1') {
      page.on('framenavigated', (f) => console.log(`  [nav] ${f.url()}`))
      page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 300)}`))
    }
    await page.goto(harnessUrl(args.port, route, args.fixtures, theme))
    await page
      .waitForSelector('main', { timeout: firstLoad ? FIRST_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS })
      .catch(() => pageErrors.push('no <main> rendered'))
    await page.waitForTimeout(args.wait)
    for (const step of args.steps) await runStep(page, step)
    const image = imageName(route, viewport, theme)
    await page.screenshot({ path: path.join(args.out, image) })
    const raw = await page.evaluate(measureInPage)
    const before = await page.evaluate(stickyProbe, 'mark' as const)
    const scrolled = await page.evaluate(scrollForSticky)
    await page.waitForTimeout(STICKY_SETTLE_MS)
    const after = await page.evaluate(stickyProbe, 'read' as const)
    const missingFixtures = await page.evaluate(() =>
      Array.from(
        (window as unknown as { __uiShotsMissing?: Set<string> }).__uiShotsMissing ?? [],
      ).toSorted(),
    )
    return {
      route,
      theme,
      viewport,
      image,
      measurement: summarizeMeasure({ ...raw, sticky: { scrolled, before, after } }),
      missingFixtures,
      pageErrors,
    }
  } finally {
    await ctx.close()
  }
}

function clearRun(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.png') || f === 'report.md' || f === 'report.json') fs.rmSync(path.join(dir, f))
  }
}

function readBefore(dir: string): ShotsReport {
  const file = path.join(dir, 'report.json')
  if (!fs.existsSync(file)) throw new Error(`--compare: no report.json in ${dir}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ShotsReport
}

export async function runShots(
  args: ShotsArgs,
  root: string,
  log: (line: string) => void,
): Promise<RunResult> {
  const before = args.compare === null ? null : readBefore(args.compare)
  const { chromium } = await import('playwright')
  if (!fs.existsSync(chromium.executablePath())) throw new Error(INSTALL_HINT)
  const { createServer } = await import('vite')
  const server = await createServer({
    configFile: path.join(HARNESS, 'vite.config.ts'),
    server: { port: args.port },
  })
  await server.listen()
  const browser = await chromium.launch()
  clearRun(args.out)
  const shots: ShotRecord[] = []
  try {
    let first = true
    for (const route of args.routes) {
      for (const viewport of args.viewports) {
        for (const theme of args.themes) {
          const s = await shoot(browser, args, route, viewport, theme, first)
          first = false
          const m = s.measurement
          log(
            `  ${route} ${viewport.name} ${theme}: overflow doc=${m.overflowDoc} main=${m.overflowMain ?? '—'} wide=${m.wide.length} sticky=${m.sticky.measured ? `${m.sticky.pinned}/${m.sticky.total}` : 'n/a'}${s.missingFixtures.length > 0 ? ` missing=${s.missingFixtures.join(',')}` : ''}${s.pageErrors.length > 0 ? ` errors=${s.pageErrors.length}` : ''}`,
          )
          shots.push(s)
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  const report: ShotsReport = {
    label: args.label,
    createdAt: new Date().toISOString(),
    commit: commitOf(root),
    fixtures: args.fixtures,
    shots,
  }
  fs.writeFileSync(path.join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const markdownPath = path.join(args.out, 'report.md')
  const compare =
    before === null || args.compare === null
      ? undefined
      : { before, beforeDir: path.relative(args.out, args.compare) || '.' }
  fs.writeFileSync(markdownPath, renderReport(report, compare))
  return { report, markdownPath }
}
