import { describe, it, expect } from 'vitest'
import type { RecordingBand, RecordingConfig } from '@camstack/types'
import {
  alwaysBand,
  emptyBand,
  withBandAt,
  removeBandAt,
  isAlwaysBand,
  bandsFromFormState,
  formStateFromConfig,
  configFromFormState,
  isAdvancedConfig,
} from '../recording-config-form.js'

const CONTINUOUS_ALWAYS: RecordingBand = {
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '23:59',
  mode: 'continuous',
}

describe('band helpers', () => {
  it('alwaysBand covers every day, all day', () => {
    expect(alwaysBand('continuous')).toEqual(CONTINUOUS_ALWAYS)
  })

  it('alwaysBand carries the events parameters through', () => {
    const band = alwaysBand('events', { triggers: { motion: true }, postBufferSec: 10 })
    expect(band.mode).toBe('events')
    expect(band.triggers).toEqual({ motion: true })
    expect(band.postBufferSec).toBe(10)
  })

  it('emptyBand is a continuous office-hours row', () => {
    expect(emptyBand()).toEqual({
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '09:00',
      end: '18:00',
      mode: 'continuous',
    })
  })

  it('withBandAt replaces immutably', () => {
    const bands = [emptyBand(), emptyBand()]
    const next = withBandAt(bands, 1, { mode: 'events' })
    expect(next[1]?.mode).toBe('events')
    expect(next[0]?.mode).toBe('continuous')
    expect(bands[1]?.mode).toBe('continuous') // original untouched
  })

  it('removeBandAt drops the index immutably', () => {
    const bands = [emptyBand(), { ...emptyBand(), mode: 'events' as const }]
    const next = removeBandAt(bands, 0)
    expect(next).toHaveLength(1)
    expect(next[0]?.mode).toBe('events')
    expect(bands).toHaveLength(2)
  })

  it('isAlwaysBand accepts a full-week full-day band (explicit days or empty)', () => {
    expect(isAlwaysBand(CONTINUOUS_ALWAYS)).toBe(true)
    expect(isAlwaysBand({ ...CONTINUOUS_ALWAYS, days: [] })).toBe(true)
  })

  it('isAlwaysBand rejects a time- or weekday-restricted band', () => {
    expect(isAlwaysBand({ ...CONTINUOUS_ALWAYS, start: '09:00' })).toBe(false)
    expect(isAlwaysBand({ ...CONTINUOUS_ALWAYS, days: [1, 2, 3] })).toBe(false)
  })
})

describe('mode-first (Base) form ↔ config mapping', () => {
  describe('formStateFromConfig', () => {
    it('DERIVES the mode from the bands, not from a stored field', () => {
      expect(formStateFromConfig({ enabled: true, bands: [CONTINUOUS_ALWAYS] }).mode).toBe(
        'continuous',
      )
      expect(
        formStateFromConfig({ enabled: true, bands: [{ ...CONTINUOUS_ALWAYS, mode: 'events' }] })
          .mode,
      ).toBe('events')
      expect(formStateFromConfig({ enabled: true, bands: [] }).mode).toBe('off')
      expect(formStateFromConfig({ enabled: false, bands: [CONTINUOUS_ALWAYS] }).mode).toBe('off')
    })

    it('reads the events parameters off the first events band', () => {
      const s = formStateFromConfig({
        enabled: true,
        bands: [
          {
            ...CONTINUOUS_ALWAYS,
            mode: 'events',
            triggers: { motion: true, audioThresholdDbfs: -30 },
            postBufferSec: 10,
          },
        ],
      })
      expect(s.triggers).toEqual({ motion: true, audioThresholdDbfs: -30 })
      // No `preBufferSec` — D381 retired the band-level pre-buffer. The history
      // a recording begins with is the broker's ONE prebuffer, and the keep gate
      // is derived from its ceiling; there is nothing here for the form to read
      // or to write back.
      expect(s.postBufferSec).toBe(10)
    })

    it('carries profiles/segment/retention through', () => {
      const cfg: RecordingConfig = {
        enabled: true,
        bands: [CONTINUOUS_ALWAYS],
        profiles: ['high', 'low'],
        segmentSeconds: 4,
        retention: { maxAgeDays: 14 },
      }
      const s = formStateFromConfig(cfg)
      expect(s.profiles).toEqual(['high', 'low'])
      expect(s.segmentSeconds).toBe(4)
      expect(s.retention).toEqual({ maxAgeDays: 14 })
    })
  })

  describe('configFromFormState', () => {
    it('derives enabled from mode (off → disabled, no bands)', () => {
      const off = configFromFormState({ mode: 'off', triggers: {} })
      expect(off.enabled).toBe(false)
      expect(off.bands).toEqual([])
      expect(configFromFormState({ mode: 'continuous', triggers: {} }).enabled).toBe(true)
    })

    it('compiles Base to exactly ONE always-on band', () => {
      expect(configFromFormState({ mode: 'continuous', triggers: {} }).bands).toEqual([
        CONTINUOUS_ALWAYS,
      ])
    })

    it('never authors the derived mode — the recorder stamps it', () => {
      expect(configFromFormState({ mode: 'continuous', triggers: {} }).mode).toBeUndefined()
      expect(configFromFormState({ mode: 'off', triggers: {} }).mode).toBeUndefined()
    })

    it('puts triggers and the post-buffer ON the events band', () => {
      const cfg = configFromFormState({
        mode: 'events',
        triggers: { motion: true },
        postBufferSec: 8,
      })
      const [band] = cfg.bands
      expect(band?.mode).toBe('events')
      expect(band?.triggers).toEqual({ motion: true })
      expect(band?.postBufferSec).toBe(8)
      // The band carries no pre-buffer to emit (D381): `postBufferSec` is the
      // LIVE demand window and a real per-band policy, the pre side was a
      // restatement of the broker's retention and is derived now.
      expect(band === undefined ? true : 'preBufferSec' in band).toBe(false)
    })

    it('omits empty triggers rather than emitting an empty object', () => {
      expect(bandsFromFormState({ mode: 'events', triggers: {} })[0]?.triggers).toBeUndefined()
    })
  })

  it('round-trips an events config through the Base form', () => {
    const cfg: RecordingConfig = {
      enabled: true,
      profiles: ['high'],
      segmentSeconds: 6,
      bands: [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          start: '00:00',
          end: '23:59',
          mode: 'events',
          triggers: { motion: true, audioThresholdDbfs: -25 },
          postBufferSec: 8,
        },
      ],
      retention: { maxAgeDays: 7, maxSizeGb: 50 },
    }
    const round = configFromFormState(formStateFromConfig(cfg))
    expect(round.enabled).toBe(true)
    expect(round.bands).toEqual(cfg.bands)
    expect(round.profiles).toEqual(['high'])
    expect(round.segmentSeconds).toBe(6)
    expect(round.retention).toEqual(cfg.retention)
  })

  describe('isAdvancedConfig', () => {
    it('is true for more than one band', () => {
      expect(isAdvancedConfig({ enabled: true, bands: [CONTINUOUS_ALWAYS, emptyBand()] })).toBe(
        true,
      )
    })

    it('is true for a single time- or weekday-restricted band', () => {
      expect(isAdvancedConfig({ enabled: true, bands: [emptyBand()] })).toBe(true)
      expect(
        isAdvancedConfig({ enabled: true, bands: [{ ...CONTINUOUS_ALWAYS, days: [1, 2] }] }),
      ).toBe(true)
    })

    it('is false for the Base-representable shapes (one always band, or none)', () => {
      expect(isAdvancedConfig({ enabled: true, bands: [CONTINUOUS_ALWAYS] })).toBe(false)
      expect(isAdvancedConfig({ enabled: false, bands: [] })).toBe(false)
    })
  })
})
