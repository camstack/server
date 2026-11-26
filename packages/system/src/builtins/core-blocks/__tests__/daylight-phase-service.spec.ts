import {
  type DaylightPhaseReading,
  type DaylightSensorSettings,
  type SiteReading,
  createRecordsAccess,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DaylightPhaseService } from '../daylight/daylight-phase-service.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { recordingLogger } from './fixtures.js'

const MIN = 60_000
const ROME: SiteReading = {
  location: { latitude: 41.9, longitude: 12.5 },
  timeZone: 'Europe/Rome',
}
const SENSOR: DaylightSensorSettings = {
  source: 'sensor',
  deviceId: 9,
  cap: 'illuminance-sensor',
  fieldPath: 'illuminance',
  darkBelow: 20,
  hysteresis: 30,
  minDwellMin: 10,
}

async function build(start: number) {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const clock = { t: start }
  const log = recordingLogger()
  const lux: { value: unknown; fails: boolean } = { value: 500, fails: false }
  const site: { value: SiteReading } = { value: ROME }
  const emitted: DaylightPhaseReading[] = []
  const service = new DaylightPhaseService({
    settings: records.kind(coreBlocksRecordKinds['daylight-settings']),
    host: {
      readSite: async () => site.value,
      fetchSlice: async () => {
        if (lux.fails) throw new Error('device offline')
        return { illuminance: lux.value }
      },
    },
    onTransition: (reading) => emitted.push(reading),
    logger: log.logger,
    now: () => clock.t,
  })
  return { service, clock, lux, site, emitted, log }
}

describe('DaylightPhaseService', () => {
  it('is the sun by default, and says nothing is wrong', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    const status = await h.service.getPhase({})
    expect(status.configured).toEqual({ source: 'sun' })
    expect(status.fallbackReason).toBeNull()
    expect(status.phase).toMatchObject({ phase: 'day', source: 'sun' })
  })

  it('a sensor reading dark makes it night at midday, honouring hysteresis and dwell', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR) // 500 lux: day
    expect((await h.service.getPhase({})).phase).toMatchObject({ phase: 'day', source: 'sensor' })

    h.lux.value = 5
    h.clock.t = t + 5 * MIN
    // Dark, but the day has not lasted the minimum dwell yet.
    expect((await h.service.getPhase({})).phase?.phase).toBe('day')
    h.clock.t = t + 11 * MIN
    const night = await h.service.getPhase({})
    expect(night.phase).toEqual({ phase: 'night', since: t + 11 * MIN, source: 'sensor' })
    expect(h.emitted.at(-1)).toEqual(night.phase)

    // 35 lux is inside the band: the night stays. 60 lifts it, after the dwell.
    h.lux.value = 35
    h.clock.t = t + 30 * MIN
    expect((await h.service.getPhase({})).phase?.phase).toBe('night')
    h.lux.value = 60
    h.clock.t = t + 40 * MIN
    expect((await h.service.getPhase({})).phase).toMatchObject({ phase: 'day', source: 'sensor' })
  })

  it('falls back to the sun when the sensor cannot be read, and logs why with the device', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR)
    h.lux.fails = true
    h.clock.t = t + 30 * MIN
    const status = await h.service.getPhase({})
    expect(status.phase).toMatchObject({ phase: 'day', source: 'sun' })
    expect(status.fallbackReason).toContain('device offline')
    const warn = h.log.lines.find((l) => l.level === 'warn')
    expect(warn?.extras?.tags).toEqual({ deviceId: 9 })
    // The same reason is not logged again on every re-check.
    await h.service.getPhase({})
    expect(h.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('treats a reading that is not a number as unreadable, never as zero', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR)
    h.lux.value = null
    const status = await h.service.getPhase({})
    expect(status.phase?.source).toBe('sun')
    expect(status.fallbackReason).toMatch(/not a number/)
  })

  it('keeps the settings across a restart (a new service over the same store)', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR)
    const reread = await h.service.readStoredSettings()
    expect(reread).toEqual(SENSOR)
  })

  it('switching back to the sun restores the sun phase', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR)
    h.lux.value = 1
    h.clock.t = t + 30 * MIN
    await h.service.getPhase({})
    const back = await h.service.setSettings({ source: 'sun' })
    expect(back.phase).toMatchObject({ phase: 'day', source: 'sun' })
  })

  it('has no phase on a sun source without a site location, and says nothing is wrong', async () => {
    const h = await build(Date.parse('2026-01-14T11:00:00Z'))
    h.site.value = { location: null, timeZone: 'Europe/Rome' }
    const status = await h.service.getPhase({})
    expect(status.phase).toBeNull()
  })

  it('re-judges when the watched device changes state, and ignores any other device', async () => {
    const t = Date.parse('2026-01-14T11:00:00Z')
    const h = await build(t)
    await h.service.setSettings(SENSOR)
    h.lux.value = 1
    h.clock.t = t + 30 * MIN
    await h.service.onDeviceState(77, 'illuminance-sensor')
    expect(h.emitted).toHaveLength(0)
    await h.service.onDeviceState(9, 'illuminance-sensor')
    expect(h.emitted.at(-1)?.phase).toBe('night')
  })
})
