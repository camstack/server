/**
 * A doorbell press is its stamp ADVANCING — not the arrival of a slice.
 *
 * Camera 101's composed doorbell (HA `switch.doorbell_bussano`, composer block
 * 1c446759) rang the operator on 2026-10-04 19:22:46 and 2026-10-06 08:10:56,
 * both while `provider-homeassistant` was being redeployed. The rows the
 * ingest wrote for them (`pipelineAnalytics.getSensorEvents`, kind `doorbell`):
 *
 *   2026-10-06 08:10:56  { lastPressedAt: null,          pressCountSinceStart: 12 }  ← restart
 *   2026-10-05 13:15:47  { lastPressedAt: 1791198947590, pressCountSinceStart: 12 }  ← real press
 *   2026-10-04 19:22:46  { lastPressedAt: null,          pressCountSinceStart: 11 }  ← restart
 *   2026-10-04 17:26:44  { lastPressedAt: 1791127604164, pressCountSinceStart: 11 }  ← real press
 *
 * The composer logged `composed field doorbell.lastPressedAt: fresh →
 * unavailable` the same second; the slice lost its stamp, the mirror diffed,
 * and the gate passed the doorbell through as "arrival is the event".
 */
import { ALL_CAPABILITY_DEFINITIONS, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { ADVANCE_FIELD, SensorTransitionGate } from '../services/sensor-transition-gate.js'
import {
  bootSensorWiring,
  flushSensorWiring,
  SENSOR_WIRING_CAMERA_ID,
  SENSOR_WIRING_SENSOR_ID,
  type SensorWiringBooted,
} from './sensor-wiring-harness.js'
import { makeSilentLogger } from './test-helpers.js'

const CAMERA = 101
const STARTED_AT = 1_791_266_800_000
/** The last real press before the restart — restored history to this process. */
const RESTORED_PRESS = 1_791_198_947_104

function gate(nowMs = STARTED_AT + 60_000): SensorTransitionGate {
  return new SensorTransitionGate({
    startedAtMs: STARTED_AT,
    now: () => nowMs,
  })
}

describe('ADVANCE_FIELD', () => {
  it('is read from the cap definitions — doorbell derives onPressed from lastPressedAt', () => {
    expect(ADVANCE_FIELD['doorbell']).toBe('lastPressedAt')
    const declared = ALL_CAPABILITY_DEFINITIONS.filter((def) =>
      Object.values(def.events ?? {}).some((e) => e.fromState?.on === 'advance'),
    ).map((def) => def.name)
    expect(Object.keys(ADVANCE_FIELD).toSorted()).toEqual(declared.toSorted())
  })
})

describe('SensorTransitionGate — advance-derived caps', () => {
  it('drops the stamp-less slice a provider restart re-emits (the 2026-10-06 ring)', () => {
    const g = gate()
    expect(
      g.observe(CAMERA, 'doorbell', {
        lastPressedAt: null,
        pressCountSinceStart: 12,
      }),
    ).toEqual({ changed: false, reason: 'no-advance' })
  })

  it('seeds the restored stamp after a restart and drops its re-emissions', () => {
    const g = gate()
    expect(
      g.observe(CAMERA, 'doorbell', {
        lastPressedAt: RESTORED_PRESS,
        pressCountSinceStart: 12,
      }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-stale-active' })
    // Source unavailable, then back: null, then the same stamp again.
    expect(
      g.observe(CAMERA, 'doorbell', {
        lastPressedAt: null,
        pressCountSinceStart: 12,
      }),
    ).toEqual({ changed: false, reason: 'no-advance' })
    expect(
      g.observe(CAMERA, 'doorbell', {
        lastPressedAt: RESTORED_PRESS,
        pressCountSinceStart: 12,
      }),
    ).toEqual({ changed: false, reason: 'no-advance' })
  })

  it('passes every real press — each one advances the stamp', () => {
    const g = gate()
    g.observe(CAMERA, 'doorbell', {
      lastPressedAt: RESTORED_PRESS,
      pressCountSinceStart: 12,
    })
    for (let i = 1; i <= 3; i++) {
      expect(
        g.observe(CAMERA, 'doorbell', {
          lastPressedAt: STARTED_AT + 10_000 * i,
          pressCountSinceStart: 12 + i,
        }),
      ).toEqual({ changed: true })
    }
  })

  it('a first sighting stamped after this process began watching is a press', () => {
    const g = gate()
    expect(g.observe(CAMERA, 'doorbell', { lastPressedAt: STARTED_AT + 5_000 })).toEqual({
      changed: true,
    })
  })

  it('an older stamp after a newer one is not a press', () => {
    const g = gate()
    expect(g.observe(CAMERA, 'doorbell', { lastPressedAt: STARTED_AT + 5_000 })).toEqual({
      changed: true,
    })
    expect(g.observe(CAMERA, 'doorbell', { lastPressedAt: STARTED_AT + 4_993 })).toEqual({
      changed: false,
      reason: 'no-advance',
    })
  })

  it('counts every no-advance drop in the summary, tagged by device', () => {
    let now = STARTED_AT + 60_000
    const g = new SensorTransitionGate({
      startedAtMs: STARTED_AT,
      now: () => now,
      summaryWindowMs: 1_000,
    })
    g.observe(CAMERA, 'doorbell', { lastPressedAt: null })
    g.observe(CAMERA, 'doorbell', { lastPressedAt: null })
    now += 1_000
    expect(g.takeDropSummary(now)).toEqual([
      { deviceId: CAMERA, capName: 'doorbell', reason: 'no-advance', count: 2 },
    ])
  })

  it('leaves caps with no advance declaration on arrival', () => {
    const g = gate()
    expect(g.observe(700, 'button', {})).toEqual({ changed: true })
  })
})

/** Booted addon, real bus: the gate is ASKED, not just correct. */
describe('a doorbell slice re-emitted by a provider restart writes no row', () => {
  let booted: SensorWiringBooted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('drops the stamp-less and the restored slices, keeps the next real press', async () => {
    booted = await bootSensorWiring({ logger: makeSilentLogger() })
    const { addon, bus } = booted
    const emit = (slice: Record<string, unknown>): void =>
      // Exactly the shape `device-state-mirror` emits: the category is not in
      // the typed `EventCatalog`, so `createEvent` cannot build it.
      bus.bus.emit({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        source: { type: 'device', id: SENSOR_WIRING_SENSOR_ID },
        category: EventCategory.DeviceStateChanged,
        data: { deviceId: SENSOR_WIRING_SENSOR_ID, capName: 'doorbell', slice },
      })
    // Restored stamp from before this process started, then the unavailable
    // flap (`lastPressedAt: null`), then the recovery with the same stamp.
    emit({ lastPressedAt: RESTORED_PRESS, pressCountSinceStart: 12 })
    await flushSensorWiring()
    emit({ lastPressedAt: null, pressCountSinceStart: 12 })
    await flushSensorWiring()
    emit({ lastPressedAt: RESTORED_PRESS, pressCountSinceStart: 12 })
    await flushSensorWiring()
    expect(await addon.getSensorEvents({ deviceId: SENSOR_WIRING_CAMERA_ID })).toEqual([])

    emit({ lastPressedAt: Date.now(), pressCountSinceStart: 13 })
    await flushSensorWiring()
    const rows = await addon.getSensorEvents({
      deviceId: SENSOR_WIRING_CAMERA_ID,
    })
    expect(rows.filter((r) => r.kind === 'doorbell')).toHaveLength(1)
  })
})
