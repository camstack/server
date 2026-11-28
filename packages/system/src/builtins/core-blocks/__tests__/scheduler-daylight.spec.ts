import { type NarrowActionStep, type SchedulerInput, occurrenceOn, siteFor } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ALL_DAYS, at, harness } from './scheduler-support.js'

const MIN = 60_000
const switchOn: NarrowActionStep = {
  kind: 'command',
  target: { kind: 'devices', ids: [1] },
  actionId: 'switch.on',
  args: { on: true },
}
/** A point 30 minutes after the night begins, whatever decides when the night begins. */
const NIGHT_PLUS_30: SchedulerInput = {
  name: 'Lights after dark',
  enabled: true,
  priority: 0,
  maxLateMs: 10 * MIN,
  profiles: [
    {
      id: 'p1',
      name: 'P',
      enabled: true,
      days: [...ALL_DAYS],
      points: [
        {
          id: 'dusk',
          at: { kind: 'phase', phase: 'night', offsetMin: 30 },
          mode: 'edge',
          steps: [switchOn],
        },
      ],
    },
  ],
}

const ROME = { location: { latitude: 41.9, longitude: 12.5 }, timeZone: 'Europe/Rome' }
const MORNING = at('2026-03-10T08:00:00Z')

describe('a scheduler point on the daylight phase (planning#737)', () => {
  it('fires 30 minutes after the SENSOR night began, not after sunset', async () => {
    const w = await harness({ start: MORNING, devices: [{ id: 1 }] })
    w.phase.value = { phase: 'night', since: at('2026-03-10T16:10:00Z'), source: 'sensor' }
    await w.create(NIGHT_PLUS_30)
    await w.engine.start()
    await w.advanceTo(at('2026-03-10T16:39:00Z'))
    expect(w.calls).toHaveLength(0)
    await w.advanceTo(at('2026-03-10T16:41:00Z'))
    expect(w.calls).toHaveLength(1)
  })

  it('moves when the transition moves: re-judged on the engine reload', async () => {
    const w = await harness({ start: MORNING, devices: [{ id: 1 }] })
    w.phase.value = { phase: 'night', since: at('2026-03-10T16:10:00Z'), source: 'sensor' }
    await w.create(NIGHT_PLUS_30)
    await w.engine.start()
    await w.advanceTo(at('2026-03-10T16:20:00Z'))
    // The sensor night is re-dated (a new transition): the point follows it.
    w.phase.value = { phase: 'night', since: at('2026-03-10T16:30:00Z'), source: 'sensor' }
    await w.engine.reload()
    await w.settle()
    await w.advanceTo(at('2026-03-10T16:41:00Z'))
    expect(w.calls).toHaveLength(0)
    await w.advanceTo(at('2026-03-10T17:01:00Z'))
    expect(w.calls).toHaveLength(1)
  })

  it('follows the sun when no sensor phase is given (night + 30 is sunset + 30)', async () => {
    const site = siteFor(ROME)
    if (site === null) throw new Error('no site')
    const sunset30 = occurrenceOn(
      { kind: 'sun', event: 'sunset', offsetMin: 30 },
      '2026-03-10',
      site,
    )
    if (sunset30 === null) throw new Error('no sunset')
    const w = await harness({ start: MORNING, devices: [{ id: 1 }] })
    await w.create(NIGHT_PLUS_30)
    await w.engine.start()
    await w.advanceTo(sunset30 - 2 * MIN)
    expect(w.calls).toHaveLength(0)
    await w.advanceTo(sunset30 + MIN)
    expect(w.calls).toHaveLength(1)
  })
})
