import { describe, it, expect } from 'vitest'
import {
  RecordingBandSchema,
  RecordingRetentionSchema,
  RecordingConfigSchema,
  RecordingTriggersSchema,
  MAX_SENSOR_TRIGGER_DEVICES,
  deriveRecordingMode,
  migrateLegacyDeviceSignalConfig,
} from '../recording-config.js'

describe('recording-config schemas', () => {
  it('accepts a band covering every day', () => {
    const b = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', mode: 'continuous' }
    expect(RecordingBandSchema.parse(b)).toEqual(b)
  })

  it('rejects a malformed band time', () => {
    expect(() =>
      RecordingBandSchema.parse({ days: [], start: '9:9', end: '06:00', mode: 'events' }),
    ).toThrow()
  })

  it('parses a full config with bands and retention', () => {
    const c = RecordingConfigSchema.parse({
      enabled: true,
      profiles: ['high', 'mid'],
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
      retention: { maxAgeDays: 30, maxSizeGb: 50 },
    })
    expect(c.enabled).toBe(true)
    expect(c.bands).toHaveLength(1)
    expect(c.retention?.maxAgeDays).toBe(30)
    expect(c.retention?.maxSizeGb).toBe(50)
  })

  it('materializes bands to an empty array when absent', () => {
    expect(RecordingConfigSchema.parse({ enabled: false }).bands).toEqual([])
  })

  // The legacy authoring surface (mode/schedules/triggers/pre-post/rules) was
  // retired 2026-07-30 — bands are the only truth. A stale caller (a cached
  // admin-ui bundle) must FAIL LOUDLY rather than have its legacy intent
  // silently stripped, which would leave the camera with zero bands = off.
  it.each([
    'schedule',
    'schedules',
    'triggers',
    'preBufferSec',
    'postBufferSec',
    'rules',
  ])('rejects the retired legacy field %s', (field) => {
    expect(() => RecordingConfigSchema.parse({ enabled: true, [field]: {} })).toThrow()
  })

  it('accepts an empty retention object', () => {
    expect(RecordingRetentionSchema.parse({})).toEqual({})
  })

  it('rejects the retired scrubThumbnails knob — the sprite tier it drove is gone', () => {
    expect(() => RecordingConfigSchema.parse({ enabled: true, scrubThumbnails: 'high' })).toThrow()
  })
})

// R5: the ONE canonical event-clip pad — every consumer (today: the videoclips
// provider) derives from this constant.
import { EVENT_PAD_MS } from '../recording-config.js'

describe('EVENT_PAD_MS', () => {
  it('is the canonical -5s/+10s clip window (matches the admin-ui clip window)', () => {
    expect(EVENT_PAD_MS).toEqual({ preMs: 5_000, postMs: 10_000 })
  })
})

import { VISIT_MERGE_GAP_MS, DEFAULT_EVENTS_BAND_BUFFER_SEC } from '../recording-config.js'

describe('VISIT_MERGE_GAP_MS', () => {
  it('equals the default events-band post-buffer, not the 5s timeline merge', () => {
    expect(VISIT_MERGE_GAP_MS).toBe(DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000)
    expect(VISIT_MERGE_GAP_MS).toBe(30_000)
  })
})

import { DEFAULT_RECORDING_PROFILES, resolveRecordingProfiles } from '../recording-config.js'

describe('resolveRecordingProfiles', () => {
  it('defaults to high+low among assigned slots (not mid)', () => {
    expect(DEFAULT_RECORDING_PROFILES).toEqual(['high', 'low'])
    expect(resolveRecordingProfiles(['high', 'mid', 'low'], undefined)).toEqual(['high', 'low'])
  })

  it('keeps an explicit operator subset that intersects assigned slots', () => {
    expect(resolveRecordingProfiles(['high', 'mid', 'low'], ['mid'])).toEqual(['mid'])
    expect(resolveRecordingProfiles(['high', 'low'], ['high'])).toEqual(['high'])
  })

  it('falls back to every assigned slot when the camera has no high/low', () => {
    expect(resolveRecordingProfiles(['mid'], undefined)).toEqual(['mid'])
  })

  it('falls back to assigned when an override matches nothing', () => {
    expect(resolveRecordingProfiles(['high', 'low'], ['mid'])).toEqual(['high', 'low'])
  })

  it('returns empty when the broker has no assigned slots', () => {
    expect(resolveRecordingProfiles([], undefined)).toEqual([])
    expect(resolveRecordingProfiles([], ['high'])).toEqual([])
  })
})

describe('RecordingTriggersSchema.objectClasses', () => {
  it('accepts a subset of the three macro classes', () => {
    const parsed = RecordingTriggersSchema.parse({ objectClasses: ['person', 'vehicle'] })
    expect(parsed.objectClasses).toEqual(['person', 'vehicle'])
  })

  it('rejects an EMPTY array — it is an "events band that never records"', () => {
    // Absent = the source is not listened to. Empty would be the same thing
    // written in a way that looks like a configuration.
    expect(() => RecordingTriggersSchema.parse({ objectClasses: [] })).toThrow()
  })

  it('rejects package — it is not an output of the object-detection step', () => {
    expect(() => RecordingTriggersSchema.parse({ objectClasses: ['package'] })).toThrow()
  })

  it('rejects a repeated class — it would double the count in segmentMissedByMs', () => {
    expect(() => RecordingTriggersSchema.parse({ objectClasses: ['person', 'person'] })).toThrow()
  })

  it('stays compatible: a motion-only band keeps parsing', () => {
    expect(RecordingTriggersSchema.parse({ motion: true })).toEqual({ motion: true })
  })
})

describe('RecordingTriggersSchema.sensorDeviceIds', () => {
  it('accepts a selection of source devices', () => {
    expect(RecordingTriggersSchema.parse({ sensorDeviceIds: [42, 43] }).sensorDeviceIds).toEqual([
      42, 43,
    ])
  })

  it('rejects an empty array', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [] })).toThrow()
  })

  it('rejects a repeated id — it would be the same key counted twice', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [42, 42] })).toThrow()
  })

  it('rejects beyond MAX_SENSOR_TRIGGER_DEVICES — the TriggerState keys are bounded', () => {
    const tooMany = Array.from({ length: MAX_SENSOR_TRIGGER_DEVICES + 1 }, (_, i) => i + 1)
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: tooMany })).toThrow()
    const exactly = Array.from({ length: MAX_SENSOR_TRIGGER_DEVICES }, (_, i) => i + 1)
    expect(
      RecordingTriggersSchema.parse({ sensorDeviceIds: exactly }).sensorDeviceIds,
    ).toHaveLength(MAX_SENSOR_TRIGGER_DEVICES)
  })

  it('rejects an id that is not an integer or not positive', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [0] })).toThrow()
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [1.5] })).toThrow()
  })

  it('the four sources ADD UP — no exclusivity constraint', () => {
    // Operator decision (2026-08-26): motion, audio, object-detection and
    // sensor are additive. No `.refine()` makes them mutually exclusive.
    const all = {
      motion: true,
      audioThresholdDbfs: -30,
      objectClasses: ['person'],
      sensorDeviceIds: [42],
    }
    expect(RecordingTriggersSchema.parse(all)).toEqual(all)
  })
})

describe("the DEVICE decides — `deviceDecision`, D380's mode with no schedule", () => {
  it('is a whole-config flag and needs no band', () => {
    const config = RecordingConfigSchema.parse({ enabled: true, bands: [], deviceDecision: true })
    expect(config.deviceDecision).toBe(true)
    expect(config.bands).toEqual([])
  })

  it('the retired band trigger `deviceSignal` is no longer authorable', () => {
    // A band is an HOUR. The signal is not one — it is the mode above.
    expect(RecordingTriggersSchema.parse({ deviceSignal: true, motion: true })).toEqual({
      motion: true,
    })
  })

  it('REFUSES bands alongside it — two authorities over one camera is D62', () => {
    const withBand = {
      enabled: true,
      deviceDecision: true,
      bands: [{ days: [], start: '00:00', end: '00:00', mode: 'continuous' }],
    }
    expect(RecordingConfigSchema.safeParse(withBand).success).toBe(false)
  })

  it('derives the `on-device-decision` mode, and a disabled camera is still off', () => {
    expect(deriveRecordingMode({ enabled: true, bands: [], deviceDecision: true })).toBe(
      'on-device-decision',
    )
    // Band-less and enabled would be `off` for anything else: the mode is
    // checked FIRST, or the one config shape that legitimately has no band
    // reads as "records nothing".
    expect(deriveRecordingMode({ enabled: false, bands: [], deviceDecision: true })).toBe('off')
  })
})

describe('migrateLegacyDeviceSignalConfig — D371 rows become the D380 mode', () => {
  /** Camera 4374 as stored on the reference hub before this change. */
  const legacy4374 = {
    enabled: true,
    mode: 'events',
    profiles: ['low'],
    bands: [
      {
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '23:59',
        mode: 'events',
        triggers: { deviceSignal: true },
        preBufferSec: 5,
        postBufferSec: 15,
      },
    ],
  }

  it("turns 4374's band into the mode, keeps `enabled`, drops the stale summary", () => {
    const out = migrateLegacyDeviceSignalConfig(legacy4374)
    expect(out.migrated).toBe(true)
    expect(out.strippedOnly).toBe(false)
    const config = RecordingConfigSchema.parse(out.value)
    // `profiles: ['low']` SURVIVES: the robot's one stream is the low slot, and
    // losing it would send its footage to a storage class scrub cannot read.
    expect(config).toEqual({
      enabled: true,
      bands: [],
      deviceDecision: true,
      profiles: ['low'],
    })
    expect(deriveRecordingMode(config)).toBe('on-device-decision')
  })

  it('is IDEMPOTENT — a second pass finds nothing and returns the same reference', () => {
    const once = migrateLegacyDeviceSignalConfig(legacy4374)
    const twice = migrateLegacyDeviceSignalConfig(once.value)
    expect(twice.migrated).toBe(false)
    expect(twice.strippedOnly).toBe(false)
    expect(twice.value).toBe(once.value)
  })

  it('a camera the operator had switched OFF comes out still off (D62)', () => {
    const out = migrateLegacyDeviceSignalConfig({ ...legacy4374, enabled: false })
    expect(RecordingConfigSchema.parse(out.value).enabled).toBe(false)
  })

  it('a MIXED band keeps its other triggers and only loses the retired key', () => {
    const out = migrateLegacyDeviceSignalConfig({
      enabled: true,
      bands: [
        {
          days: [],
          start: '00:00',
          end: '00:00',
          mode: 'events',
          triggers: { deviceSignal: true, motion: true },
        },
      ],
    })
    expect(out.migrated).toBe(false)
    expect(out.strippedOnly).toBe(true)
    const config = RecordingConfigSchema.parse(out.value)
    expect(config.deviceDecision).toBeUndefined()
    expect(config.bands[0]?.triggers).toEqual({ motion: true })
  })

  it('leaves a config that never carried the key alone, by reference', () => {
    const modern = { enabled: true, bands: [], deviceDecision: true }
    expect(migrateLegacyDeviceSignalConfig(modern).value).toBe(modern)
  })
})

/**
 * D381 — the band `preBufferSec` is RETIRED, and retiring it is a migration,
 * not a deletion. `RecordingBandSchema` is a plain `z.object`: a key removed
 * from the shape survives one parse and disappears on the next save with no
 * line anywhere. So the key stays declared and is stripped deliberately.
 */
import {
  type RecordingBand,
  type RecordingConfig,
  stripRetiredBandPreBufferSec,
} from '../recording-config.js'

describe('stripRetiredBandPreBufferSec — the retired band pre-buffer', () => {
  const bandWith = (preBufferSec?: number): RecordingBand => ({
    days: [],
    start: '00:00',
    end: '00:00',
    mode: 'events',
    ...(preBufferSec === undefined ? {} : { preBufferSec }),
    postBufferSec: 30,
  })
  const configWith = (...bands: readonly RecordingBand[]): RecordingConfig =>
    RecordingConfigSchema.parse({ enabled: true, bands })

  it('removes the key and says which bands carried it', () => {
    const result = stripRetiredBandPreBufferSec(configWith(bandWith(5), bandWith()))
    expect(result.strippedBands).toEqual([0])
    expect('preBufferSec' in result.config.bands[0]!).toBe(false)
  })

  it('removes an explicit 0 too — it was a value, not an omission', () => {
    const result = stripRetiredBandPreBufferSec(configWith(bandWith(0)))
    expect(result.strippedBands).toEqual([0])
    expect('preBufferSec' in result.config.bands[0]!).toBe(false)
  })

  it('returns the SAME config by reference when there is nothing to strip', () => {
    const config = configWith(bandWith())
    expect(stripRetiredBandPreBufferSec(config).config).toBe(config)
  })

  it('is idempotent, and preserves everything else about the band', () => {
    const once = stripRetiredBandPreBufferSec(configWith(bandWith(5)))
    const twice = stripRetiredBandPreBufferSec(once.config)
    expect(twice.strippedBands).toEqual([])
    expect(twice.config.bands[0]).toEqual({
      days: [],
      start: '00:00',
      end: '00:00',
      mode: 'events',
      postBufferSec: 30,
    })
  })

  it('the shipped band defaults no longer carry a pre-buffer at all', () => {
    expect('preBufferSec' in DEFAULT_EVENTS_BAND_BUFFER_SEC).toBe(false)
    expect(DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec).toBe(30)
  })
})
