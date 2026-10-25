import { describe, it, expect } from 'vitest'
import type { RecordingConfig } from '@camstack/types'
import {
  buildSensorTriggerBindings,
  parseSensorStateChanged,
  SensorTriggerRouter,
} from '../sensor-trigger.js'

const router = (nowMs = 100_000): SensorTriggerRouter =>
  new SensorTriggerRouter({ now: () => nowMs, startedAtMs: 0 })

const openSlice = { entryOpen: true, lastChangedAt: 99_000 }
const closedSlice = { entryOpen: false, lastChangedAt: 99_500 }

describe('SensorTriggerRouter', () => {
  it('routes the rising edge to EVERY camera that listens to that sensor', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101, 102])]]))
    r.onStateSlice(42, 'contact', closedSlice)
    expect(r.onStateSlice(42, 'contact', openSlice)).toEqual({
      fired: [101, 102],
      skipped: null,
    })
  })

  it('a sensor that no band names exits without touching the edge memory', () => {
    const r = router()
    r.setBindings(new Map())
    expect(r.onStateSlice(42, 'contact', openSlice)).toEqual({
      fired: [],
      skipped: 'not-listened',
    })
    // Unobserved: the next time a band names it, the first slice
    // is still a FIRST observation and goes through the freshness rule.
    r.setBindings(new Map([[42, new Set([101])]]))
    expect(r.onStateSlice(42, 'contact', { entryOpen: true, lastChangedAt: 1 }).skipped).toBe(
      'baseline-seeded-stale-active',
    )
  })

  it('the falling edge lights nothing and says so', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    expect(r.onStateSlice(42, 'contact', closedSlice)).toEqual({
      fired: [],
      skipped: 'falling-edge',
    })
  })

  it('the memory is per (device, cap): two caps of the same device are not confused', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    expect(r.onStateSlice(42, 'tamper', { tampered: true, lastChangedAt: 99_000 }).fired).toEqual([
      101,
    ])
  })

  it('removing the sensor from the band stops routing without erasing the memory', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    r.setBindings(new Map())
    expect(r.onStateSlice(42, 'contact', closedSlice).skipped).toBe('not-listened')
    r.setBindings(new Map([[42, new Set([101])]]))
    // `prior` is still `true`: the lost close does NOT become a rising edge.
    expect(r.onStateSlice(42, 'contact', openSlice).skipped).toBe('no-change')
  })

  it('a cap that is not a source exits with unknown-cap, not silently', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    expect(r.onStateSlice(42, 'presence', { state: 'home' })).toEqual({
      fired: [],
      skipped: 'unknown-cap',
    })
  })

  it('lists the sources it listens to — the log line at boot', () => {
    const r = router()
    r.setBindings(
      new Map([
        [42, new Set([101])],
        [43, new Set([102])],
      ]),
    )
    expect([...r.listenedSourceIds()].toSorted((a, b) => a - b)).toEqual([42, 43])
  })
})

describe('buildSensorTriggerBindings', () => {
  const band = (sensorDeviceIds: readonly number[]): RecordingConfig['bands'] => [
    {
      days: [],
      start: '00:00',
      end: '00:00',
      mode: 'events',
      triggers: { sensorDeviceIds: [...sensorDeviceIds] },
    },
  ]

  it('indexes source → cameras, from EVERY band and not only the currently active one', () => {
    // The index changes only on a config write, while the active band
    // changes with the clock: an index that followed the clock would lose the
    // first trigger after every band edge. Filtering by band is already the job of the
    // gate, which reads `bandTriggerSources` of the band active at that instant.
    const configs = new Map<number, RecordingConfig>([
      [
        101,
        {
          enabled: true,
          bands: [
            {
              days: [],
              start: '00:00',
              end: '08:00',
              mode: 'events',
              triggers: { sensorDeviceIds: [42] },
            },
            {
              days: [],
              start: '08:00',
              end: '00:00',
              mode: 'events',
              triggers: { sensorDeviceIds: [43] },
            },
          ],
        },
      ],
      [102, { enabled: true, bands: band([42]) }],
    ])
    const index = buildSensorTriggerBindings(configs)
    expect([...(index.get(42) ?? [])].toSorted((a, b) => a - b)).toEqual([101, 102])
    expect([...(index.get(43) ?? [])]).toEqual([101])
  })

  it('a DISABLED camera does not enter the index', () => {
    const index = buildSensorTriggerBindings(
      new Map([[101, { enabled: false, bands: band([42]) }]]),
    )
    expect(index.size).toBe(0)
  })

  it('a config without sensor triggers produces no keys', () => {
    const index = buildSensorTriggerBindings(
      new Map([
        [
          101,
          {
            enabled: true,
            bands: [
              {
                days: [],
                start: '00:00',
                end: '00:00',
                mode: 'events',
                triggers: { motion: true },
              },
            ],
          },
        ],
      ]),
    )
    expect(index.size).toBe(0)
  })
})

describe('parseSensorStateChanged', () => {
  it('accepts a well-formed DeviceStateChanged payload', () => {
    expect(
      parseSensorStateChanged({ deviceId: 42, capName: 'contact', slice: { entryOpen: true } }),
    ).toEqual({ deviceId: 42, capName: 'contact', slice: { entryOpen: true } })
  })

  it('rejects a payload without shape — type guard, not cast', () => {
    expect(parseSensorStateChanged(null)).toBeNull()
    expect(parseSensorStateChanged({ deviceId: '42', capName: 'contact', slice: {} })).toBeNull()
    expect(parseSensorStateChanged({ deviceId: 42, slice: {} })).toBeNull()
  })

  it('rejects an absent or non-object slice: there is nothing to read an edge from', () => {
    expect(parseSensorStateChanged({ deviceId: 42, capName: 'contact' })).toBeNull()
    expect(parseSensorStateChanged({ deviceId: 42, capName: 'contact', slice: 7 })).toBeNull()
  })
})
