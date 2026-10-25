/**
 * The CONTRACT half of the batched timeline heatmap.
 *
 * Three reads draw a camera's day on the timeline — event density, footage
 * availability, and which days have footage at all. Singular, a tablet grid of
 * N cameras paid 3N round trips on every day change. The batches collapse the
 * transport; this file pins the two things a batch can silently destroy:
 *
 *  1. **A ceiling that REFUSES, never truncates.** An answer for 200 of 300
 *     cameras that looks exactly like an answer for 300 is worse than an error.
 *  2. **"Could not read" is a first-class row.** `buckets: []` / `ranges: []` /
 *     `days: []` is a camera that ANSWERED and has nothing in the window. A
 *     camera nobody could read must never be spelled the same way — the
 *     timeline would draw "quiet" over "unknown".
 */
import { describe, expect, it } from 'vitest'
import {
  EVENT_DENSITY_BATCH_MAX,
  EventDensityForDeviceSchema,
  pipelineAnalyticsCapability,
} from '../capabilities/pipeline-analytics.cap.js'
import {
  RECORDING_SOURCE_CAMSTACK_ADDON,
  recordingCapability,
} from '../capabilities/recording.cap.js'
import {
  RECORDING_TIMELINE_BATCH_MAX,
  RecordingAvailabilityForDeviceSchema,
  RecordingDaysForDeviceSchema,
  recordingArchiveCapability,
} from '../capabilities/recording-archive.cap.js'

/** The three batch inputs, named so a failure says WHICH one drifted. */
const BATCH_INPUTS = [
  {
    label: 'pipelineAnalytics.getEventDensityBatch',
    schema: pipelineAnalyticsCapability.methods.getEventDensityBatch.input,
    max: EVENT_DENSITY_BATCH_MAX,
    rest: { since: 0, until: 86_400_000, bucketMs: 60_000 },
  },
  {
    label: 'recordingArchive.getAvailabilityBatch',
    schema: recordingArchiveCapability.methods.getAvailabilityBatch.input,
    max: RECORDING_TIMELINE_BATCH_MAX,
    rest: { fromMs: 0, toMs: 86_400_000 },
  },
  {
    label: 'recordingArchive.getDaysWithRecordingsBatch',
    schema: recordingArchiveCapability.methods.getDaysWithRecordingsBatch.input,
    max: RECORDING_TIMELINE_BATCH_MAX,
    rest: { fromMs: 0, toMs: 86_400_000, tzOffsetMinutes: 0 },
  },
] as const

describe('timeline heatmap batches — the ceiling is REPORTED, not applied', () => {
  for (const { label, schema, max, rest } of BATCH_INPUTS) {
    it(`${label} accepts exactly ${max} ids`, () => {
      const deviceIds = Array.from({ length: max }, (_, i) => 600 + i)
      const parsed = schema.safeParse({ deviceIds, ...rest })
      expect(parsed.success).toBe(true)
    })

    it(`${label} REFUSES ${max + 1} ids instead of truncating`, () => {
      const deviceIds = Array.from({ length: max + 1 }, (_, i) => 600 + i)
      const parsed = schema.safeParse({ deviceIds, ...rest })
      // Refused. The failure mode this guards is the other one: a schema that
      // silently kept the first `max` would hand back an answer indistinguishable
      // from a complete one, and the caller would never learn it asked too much.
      expect(parsed.success).toBe(false)
      if (parsed.success) {
        expect(parsed.data.deviceIds.length).toBe(max + 1)
      }
    })

    it(`${label} refuses an EMPTY ask rather than reading everything`, () => {
      expect(schema.safeParse({ deviceIds: [], ...rest }).success).toBe(false)
    })
  }
})

describe('timeline heatmap batches — unreadable is not empty', () => {
  it('event density spells "read, nothing here" and "could not read" differently', () => {
    const quiet = EventDensityForDeviceSchema.parse({
      deviceId: 101,
      read: 'read',
      buckets: [],
    })
    const unknown = EventDensityForDeviceSchema.parse({
      deviceId: 616,
      read: 'unreadable',
      buckets: [],
    })
    expect(quiet.read).not.toBe(unknown.read)
  })

  it('recording availability + days carry the same mark', () => {
    expect(
      RecordingAvailabilityForDeviceSchema.parse({
        deviceId: 101,
        read: 'unreadable',
        ranges: [],
        // Empty on an unreadable row: nobody looked, so nothing is claimed
        // about which profiles exist either (D433).
        profilesWithFootage: [],
      }).read,
    ).toBe('unreadable')
    expect(
      RecordingDaysForDeviceSchema.parse({ deviceId: 101, read: 'unreadable', days: [] }).read,
    ).toBe('unreadable')
  })

  it('rejects a row that omits the mark — a row is never allowed to be ambiguous', () => {
    expect(EventDensityForDeviceSchema.safeParse({ deviceId: 101, buckets: [] }).success).toBe(
      false,
    )
    expect(
      RecordingAvailabilityForDeviceSchema.safeParse({ deviceId: 101, ranges: [] }).success,
    ).toBe(false)
    expect(RecordingDaysForDeviceSchema.safeParse({ deviceId: 101, days: [] }).success).toBe(false)
  })
})

describe('the recording batches are OURS, and the singular read names its source', () => {
  it("the batch inputs carry no provider — they are the archive's, ours only (D625)", () => {
    // A `deviceIds` array cannot be routed by a device-scoped mount, so the
    // batches stayed on the singleton. The consequence is stated rather than
    // hidden: they answer for CamStack's archive and never for a camera's card.
    for (const name of ['getAvailabilityBatch', 'getDaysWithRecordingsBatch'] as const) {
      const parsed = recordingArchiveCapability.methods[name].input.safeParse({
        deviceIds: [101],
        fromMs: 0,
        toMs: 1,
        tzOffsetMinutes: 0,
        provider: RECORDING_SOURCE_CAMSTACK_ADDON,
      })
      expect(parsed.success).toBe(true)
      expect(parsed.success && 'provider' in parsed.data).toBe(false)
    }
  })
})

describe('timeline heatmap batches — the batch answers the same question', () => {
  it('the batch row carries exactly what the singular method returns, per device', () => {
    // Same question, same answer shape: a batch row minus its `read` mark must
    // satisfy the singular method's own output schema. If the two ever drift,
    // the tablet timeline and the single-camera timeline draw different days.
    const singularAvailability = recordingCapability.methods.getAvailability.output
    const row = RecordingAvailabilityForDeviceSchema.parse({
      deviceId: 101,
      read: 'read',
      ranges: [{ profile: 'mid', startMs: 1_000, endMs: 5_000 }],
      profilesWithFootage: ['mid', 'low'],
    })
    expect(
      singularAvailability.safeParse({
        deviceId: row.deviceId,
        // The batch row's OWN mark, carried across rather than invented: since
        // D625 the singular answer carries it too, so the two shapes are one.
        read: row.read,
        ranges: row.ranges,
        // Carried ACROSS, not re-derived: a batch row that dropped it would
        // tell a grid caller the archive holds one profile (D433).
        profilesWithFootage: row.profilesWithFootage,
      }).success,
    ).toBe(true)

    const singularDays = recordingCapability.methods.getDaysWithRecordings.output
    const daysRow = RecordingDaysForDeviceSchema.parse({
      deviceId: 101,
      read: 'read',
      days: [1_000],
    })
    expect(
      singularDays.safeParse({
        deviceId: daysRow.deviceId,
        read: daysRow.read,
        days: daysRow.days,
      }).success,
    ).toBe(true)

    const singularDensity = pipelineAnalyticsCapability.methods.getEventDensity.output
    const densityRow = EventDensityForDeviceSchema.parse({
      deviceId: 101,
      read: 'read',
      buckets: [{ bucketStart: 0, motion: 1, object: 2, audio: 3 }],
    })
    expect(singularDensity.safeParse(densityRow.buckets).success).toBe(true)
  })
})
