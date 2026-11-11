/**
 * Every host that mounts `StreamPanel` with detections also feeds it the CENSUS.
 *
 * The parked objects are not in the detection stream — when the evidence ledger
 * promotes one, the tracker is told to forget it — so the stationary layer only
 * draws when its host passes `stationaryObjects`. There is more than one host,
 * and wiring ONE of them is indistinguishable from wiring none: the switches
 * still appear (they live in `StreamPanel`), the deploy still reports success,
 * and the operator still sees nothing.
 *
 * That is exactly what happened on 2026-09-15: `LiveStreamViewer` was wired
 * while the device-detail page renders `StreamPanelContent`, so the census
 * never reached the panel the operator was looking at.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * The tree is walked and read ONCE, in `beforeAll`, not inside each test body:
 * a synchronous scan of the whole admin-ui source takes seconds on a loaded
 * machine and used to be charged to the 5 s test timeout. The hook budget
 * (60 s) is a ceiling for a starved CI host, not an expected cost.
 */
const SCAN_BUDGET_MS = 60_000
let sources: ReadonlyMap<string, string>

beforeAll(() => {
  sources = new Map(walk(SRC).map((file) => [file, readFileSync(file, 'utf8')]))
}, SCAN_BUDGET_MS)

describe('the census reaches every StreamPanel', () => {
  it('every host that passes `detections` also passes `stationaryObjects`', () => {
    const offenders: string[] = []
    for (const [file, text] of sources) {
      if (!text.includes('<StreamPanel')) continue
      if (!text.includes('detections={')) continue
      if (!text.includes('stationaryObjects')) offenders.push(file.slice(SRC.length + 1))
    }
    expect(offenders, 'these mount StreamPanel with detections but no census').toEqual([])
  })

  it('finds the hosts at all — a guard that matches nothing guards nothing', () => {
    const hosts = [...sources.values()].filter((text) => text.includes('<StreamPanel'))
    expect(hosts.length).toBeGreaterThan(1)
  })
})
