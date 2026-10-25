import { describe, it, expect } from 'vitest'
import { RecordingBandsConfigSchema } from '../config-types.js'

describe('RecordingBandsConfigSchema', () => {
  it('accepts a multi-band config with per-band mode', () => {
    const cfg = {
      bands: [
        { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', mode: 'continuous' },
        {
          days: [],
          start: '06:00',
          end: '22:00',
          mode: 'events',
          triggers: { motion: true },
          preBufferSec: 5,
          postBufferSec: 10,
        },
      ],
    }
    expect(RecordingBandsConfigSchema.parse(cfg)).toEqual(cfg)
  })
  it('defaults bands to [] (off everywhere)', () => {
    expect(RecordingBandsConfigSchema.parse({})).toEqual({ bands: [] })
  })
  it('rejects a bad time format', () => {
    expect(() =>
      RecordingBandsConfigSchema.parse({
        bands: [{ days: [], start: '25:00', end: '06:00', mode: 'continuous' }],
      }),
    ).toThrow()
  })
  it('rejects an out-of-range weekday', () => {
    expect(() =>
      RecordingBandsConfigSchema.parse({
        bands: [{ days: [7], start: '00:00', end: '01:00', mode: 'continuous' }],
      }),
    ).toThrow()
  })
  it('rejects an unknown mode', () => {
    expect(() =>
      RecordingBandsConfigSchema.parse({
        bands: [{ days: [], start: '00:00', end: '01:00', mode: 'wat' }],
      }),
    ).toThrow()
  })
})
