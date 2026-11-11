/**
 * The hub-side door of a step's `if`: a `time-is` guard is read on the site
 * clock the door fetches through `system.getSiteLocation`. Without the site it
 * read `unknown` and neither branch ran.
 */
import type { AddonApi, AutomationWhen, SiteReading } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conditionDoorOver } from '../step-condition-door.js'

const ROME: SiteReading = {
  location: { latitude: 41.9, longitude: 12.5 },
  timeZone: 'Europe/Rome',
}

const NIGHT: AutomationWhen = {
  kind: 'time-is',
  between: {
    from: { kind: 'clock', hh: 22, mm: 0 },
    to: { kind: 'clock', hh: 6, mm: 0 },
  },
}
const AFTER_SUNSET: AutomationWhen = {
  kind: 'time-is',
  between: {
    from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
    to: { kind: 'clock', hh: 23, mm: 59 },
  },
}
const SWITCH_ON: AutomationWhen = {
  kind: 'device-is',
  deviceId: 1,
  cap: 'switch',
  fieldPath: 'on',
  operator: 'eq',
  value: true,
}

function apiOf(readSite: () => Promise<SiteReading>): {
  api: AddonApi
  siteReads: () => number
} {
  let siteReads = 0
  const fake = {
    system: {
      getSiteLocation: {
        query: () => {
          siteReads += 1
          return readSite()
        },
      },
    },
    deviceState: { getCapSlice: { query: async () => ({ on: true }) } },
    deviceManager: { listAll: { query: async () => [] } },
  }
  // The fake covers only the three routers the door reads.
  return {
    api: Object.assign(Object.create(null), fake),
    siteReads: () => siteReads,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('conditionDoorOver — a time-is guard', () => {
  it('is judged on the site clock: true inside the window, false outside', async () => {
    const { api } = apiOf(async () => ROME)
    const evaluate = conditionDoorOver(() => api)()
    // Rome is UTC+1 in March: 23:30 local, then 12:00 local.
    vi.useFakeTimers({ now: Date.parse('2026-03-10T22:30:00Z') })
    expect((await evaluate(NIGHT)).result).toBe('true')
    vi.setSystemTime(Date.parse('2026-03-10T11:00:00Z'))
    expect((await evaluate(NIGHT)).result).toBe('false')
  })

  it('reads unknown, with the reason, when the site cannot be read', async () => {
    const { api } = apiOf(async () => {
      throw new Error('hub still booting')
    })
    const verdict = await conditionDoorOver(() => api)()(NIGHT)
    expect(verdict.result).toBe('unknown')
    expect(verdict.reason).toContain('the site could not be read')
    expect(verdict.reason).toContain('hub still booting')
  })

  it('a sun window on a site with no location reads unknown and says so', async () => {
    const { api } = apiOf(async () => ({
      location: null,
      timeZone: 'Europe/Rome',
    }))
    const verdict = await conditionDoorOver(() => api)()(AFTER_SUNSET)
    expect(verdict.result).toBe('unknown')
    expect(verdict.reason).toContain('needs the site location')
  })

  it('does not read the site for a tree with no time leaf', async () => {
    const { api, siteReads } = apiOf(async () => ROME)
    expect((await conditionDoorOver(() => api)()(SWITCH_ON)).result).toBe('true')
    expect(siteReads()).toBe(0)
  })
})
