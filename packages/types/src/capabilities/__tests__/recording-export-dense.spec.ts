/**
 * `ExportTimelapseSchema.dense` — the POST-HOC timelapse's two-rate contract.
 *
 * A scheduled timelapse is not a uniform sample: the interesting minutes are
 * the ones a track was open in, and the rest is an empty driveway. `dense`
 * carries those minutes to the renderer as ranges RELATIVE to the export's own
 * `fromMs`, so the same render answers "every 30 s all night, but every 2 s
 * while something moved".
 */
import { describe, expect, it } from 'vitest'
import { ExportOptionsSchema, ExportTimelapseSchema } from '../recording-export.cap.js'

const baseOptions = {
  includeAudio: false,
  maxLifeMs: 86_400_000,
  deleteAfterDownload: false,
}

describe('ExportTimelapseSchema.dense', () => {
  it('accepts a timelapse with no dense overlay (today’s exact shape)', () => {
    const parsed = ExportTimelapseSchema.parse({ everyMs: 30_000, outputFps: 12 })
    expect(parsed.dense).toBeUndefined()
  })

  it('accepts dense ranges expressed in seconds from the export start', () => {
    const parsed = ExportTimelapseSchema.parse({
      everyMs: 30_000,
      outputFps: 12,
      dense: { everyMs: 2000, ranges: [{ fromSec: 10, toSec: 40 }] },
    })
    expect(parsed.dense?.everyMs).toBe(2000)
    expect(parsed.dense?.ranges).toEqual([{ fromSec: 10, toSec: 40 }])
  })

  it('refuses a dense cadence that is not DENSER than the base cadence', () => {
    // The whole point of the field is a second, faster rate. Equal or slower
    // is an authoring mistake that would silently render a uniform timelapse
    // the operator believes is two-rate.
    expect(() =>
      ExportTimelapseSchema.parse({
        everyMs: 2000,
        dense: { everyMs: 2000, ranges: [{ fromSec: 0, toSec: 5 }] },
      }),
    ).toThrow()
  })

  it('refuses an empty or inverted range', () => {
    expect(() =>
      ExportTimelapseSchema.parse({
        everyMs: 30_000,
        dense: { everyMs: 2000, ranges: [] },
      }),
    ).toThrow()
    expect(() =>
      ExportTimelapseSchema.parse({
        everyMs: 30_000,
        dense: { everyMs: 2000, ranges: [{ fromSec: 40, toSec: 40 }] },
      }),
    ).toThrow()
  })

  it('bounds the range count so one render can never emit an unbounded filter', () => {
    const ranges = Array.from({ length: 201 }, (_, i) => ({ fromSec: i * 10, toSec: i * 10 + 1 }))
    expect(() =>
      ExportTimelapseSchema.parse({ everyMs: 30_000, dense: { everyMs: 2000, ranges } }),
    ).toThrow()
  })

  it('still refuses speed + timelapse together when dense is present', () => {
    expect(() =>
      ExportOptionsSchema.parse({
        ...baseOptions,
        speed: 4,
        timelapse: {
          everyMs: 30_000,
          dense: { everyMs: 2000, ranges: [{ fromSec: 0, toSec: 5 }] },
        },
      }),
    ).toThrow()
  })
})
