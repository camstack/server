/**
 * D735: a contact that returns from `unavailable` to the value it already held is not a
 * transition — the slice keeps the change time it had, and no consumer sees an edge.
 *
 * The reference is 2026-10-07 02:32Z. Night was armed at 21:40 with the studio window open
 * (open since 18:05). The hub restarted at 23:16Z, so every sensor-edge consumer's memory was
 * empty from then on. At 02:31 Zigbee2MQTT restarted: the window went `on → unavailable → on`
 * and HA handed the recovery a FRESH `last_changed` (02:32). The provider wrote it, the
 * consumer's first sighting read an active level with a fresh stamp as an opening, and the
 * armed panel was pressed for a window that had not moved in eight hours.
 *
 * Each case drives the REAL device through the same `broker.message` listener production
 * uses, and judges the committed slice with the SHARED edge rule exactly as a consumer that
 * started at the hub restart would (`evaluateSensorEdge`, first sighting).
 */
import {
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorEdge,
  type SensorEdgeVerdict,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HA_SEEDED_CHANGED_AT, haChangeStamp } from '../../ha-change-stamp.js'
import { makeBinarySensor } from './ha-binary-sensor-harness.js'

const OPENED = Date.parse('2026-10-06T18:05:00.000Z')
const HUB_RESTART = Date.parse('2026-10-06T23:16:00.000Z')
const Z2M_DOWN = Date.parse('2026-10-07T02:31:40.000Z')
const RECOVERED = Date.parse('2026-10-07T02:32:01.000Z')

/** A consumer that began watching at the hub restart and has never seen this sensor. */
function firstSighting(slice: Readonly<Record<string, unknown>> | undefined): SensorEdgeVerdict {
  if (slice === undefined) throw new Error('the device holds no contact slice')
  return evaluateSensorEdge({
    capName: 'contact',
    slice,
    prior: undefined,
    startedAtMs: HUB_RESTART,
    nowMs: Date.now(),
    firstSightingFreshnessMs: DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  })
}

beforeEach(() => {
  vi.useFakeTimers({ now: HUB_RESTART + 5_000, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a Zigbee2MQTT restart is not an opening (D735)', () => {
  it('the exact 02:32 sequence: the window keeps its 18:05 stamp and is no edge', () => {
    // The provider restarted with the hub: the slice is RESTORED, and HA replays the state.
    const sensor = makeBinarySensor('contact', {
      contact: { entryOpen: true, lastChangedAt: OPENED },
    })
    sensor.push('on', OPENED)
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: OPENED })

    vi.setSystemTime(Z2M_DOWN)
    sensor.push('unavailable', Z2M_DOWN)
    vi.setSystemTime(RECOVERED)
    sensor.push('on', RECOVERED)

    // Identical slice: the mirror diffs nothing, so no DeviceStateChanged is even emitted…
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: OPENED })
    // …and a consumer that sees it anyway (a hydration) seeds a baseline, never a rise.
    const verdict = firstSighting(sensor.slice())
    expect(verdict.edge).toBe('none')
    expect(verdict).toMatchObject({ reason: 'baseline-seeded-stale-active' })
  })

  it('an HA restart that only resets `last_changed` is not a change either', () => {
    const sensor = makeBinarySensor('contact', {
      contact: { entryOpen: true, lastChangedAt: OPENED },
    })
    vi.setSystemTime(RECOVERED)
    sensor.push('on', RECOVERED)
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: OPENED })
  })

  it('nothing known before the outage: the value is real, its change time is not — no edge, and said', () => {
    const sensor = makeBinarySensor('contact')
    vi.setSystemTime(Z2M_DOWN)
    sensor.push('unavailable', Z2M_DOWN)
    vi.setSystemTime(RECOVERED)
    sensor.push('on', RECOVERED)
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: HA_SEEDED_CHANGED_AT })
    expect(firstSighting(sensor.slice()).edge).toBe('none')
    expect(sensor.logger.info).toHaveBeenCalledWith(
      'HA→device recovery with no known prior value — no change time',
      expect.objectContaining({ meta: expect.objectContaining({ cap: 'contact', value: 'on' }) }),
    )
  })

  it('a window that really OPENED during the outage is still an opening', () => {
    const sensor = makeBinarySensor('contact', {
      contact: { entryOpen: false, lastChangedAt: OPENED },
    })
    vi.setSystemTime(Z2M_DOWN)
    sensor.push('unavailable', Z2M_DOWN)
    vi.setSystemTime(RECOVERED)
    sensor.push('on', RECOVERED)
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: RECOVERED })
    expect(firstSighting(sensor.slice()).edge).toBe('rising')
  })

  it('an ordinary opening, no outage, is untouched', () => {
    const sensor = makeBinarySensor('contact', {
      contact: { entryOpen: false, lastChangedAt: OPENED },
    })
    vi.setSystemTime(RECOVERED)
    sensor.push('on', RECOVERED)
    expect(sensor.slice()).toEqual({ entryOpen: true, lastChangedAt: RECOVERED })
  })
})

describe('haChangeStamp', () => {
  const HA = 5_000
  it('keeps a known stamp for the same value, outage or not', () => {
    for (const afterOutage of [true, false]) {
      expect(
        haChangeStamp({ sameValue: true, priorChangedAt: 1_000, haChangedAt: HA, afterOutage }),
      ).toEqual({ kind: 'kept', at: 1_000 })
    }
  })
  it('seeds a recovery with nothing known before it', () => {
    for (const priorChangedAt of [undefined, 0]) {
      expect(
        haChangeStamp({ sameValue: false, priorChangedAt, haChangedAt: HA, afterOutage: true }),
      ).toEqual({ kind: 'seeded', at: HA_SEEDED_CHANGED_AT })
    }
  })
  it("takes HA's stamp for a real change, and for a first push outside an outage", () => {
    expect(
      haChangeStamp({
        sameValue: false,
        priorChangedAt: 1_000,
        haChangedAt: HA,
        afterOutage: true,
      }),
    ).toEqual({ kind: 'ha', at: HA })
    expect(
      haChangeStamp({ sameValue: true, priorChangedAt: 0, haChangedAt: HA, afterOutage: false }),
    ).toEqual({ kind: 'ha', at: HA })
  })
})
