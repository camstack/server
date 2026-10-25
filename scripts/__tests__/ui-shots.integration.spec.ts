/**
 * `ui:shots` end to end: the harness serves the real admin-ui source against
 * the access fixtures, Playwright shoots one route, the report lands on disk.
 * Skipped when Playwright's Chromium is not installed
 * (`npx playwright install chromium`).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { parseShotsArgs } from '../ui/shots/lib/args.js'
import type { ShotsReport } from '../ui/shots/lib/report.js'
import { runShots } from '../ui/shots/lib/run.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const hasChromium = ((): boolean => {
  try {
    return fs.existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

describe.skipIf(!hasChromium)('ui:shots against the harness', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-'))
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }))

  it('renders Tokens & sessions from fixtures, measures it and writes the report', async () => {
    const args = parseShotsArgs(
      [
        '--route',
        '/system/identity?tab=access',
        '--fixtures',
        'access',
        '--label',
        'it',
        '--out',
        out,
        '--theme',
        'dark',
        '--viewport',
        '390x844',
        '--port',
        '3968',
      ],
      ROOT,
    )
    if ('error' in args) throw new Error(args.error)
    const { report } = await runShots(args, ROOT, () => undefined)
    const [shot] = report.shots
    expect(shot?.pageErrors).toEqual([])
    expect(shot?.missingFixtures).toEqual([])
    expect(shot?.measurement.overflowDoc).toBe(0)
    expect(fs.statSync(path.join(out, shot?.image ?? 'missing')).size).toBeGreaterThan(10_000)
    const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')) as ShotsReport
    expect(json.shots).toHaveLength(1)
    expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toContain(
      '| /system/identity?tab=access | 390x844 390×844 | dark |',
    )
  }, 300_000)
})
