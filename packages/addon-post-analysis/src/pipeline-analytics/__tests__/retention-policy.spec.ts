/**
 * Retention policy — ONE window per device (D62). Pinned hard: a wrong cutoff
 * here IS data loss.
 *
 * What this file is really asserting is the SIZE of the operator-visible
 * surface. D61 made retention one age sweep over tracks but left four per-family
 * day knobs in the form, and three of them stopped deciding anything the moment
 * object events, faces, plates and media became track-owned. An operator could
 * set object retention to 30 days, watch the form save it, and lose the events
 * at 7. So the surface is now two keys, and it is enumerated
 * (`RETENTION_SETTING_KEYS`) so a third cannot be added by accident.
 */
import { describe, expect, it } from 'vitest'
import {
  FOLLOW_FLOOR_DAYS,
  followCutoffMs,
  RETENTION_SETTING_KEYS,
  RetentionSettingsSchema,
  resolveRetentionCutoffs,
  resolveRetentionSettings,
  TRACK_RETENTION_DEFAULT_DAYS,
} from '../retention-policy.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 200 * DAY

describe('the operator-visible retention surface', () => {
  it('is exactly the two keys one policy needs — a mode and a window', () => {
    expect([...RETENTION_SETTING_KEYS]).toEqual(['retentionMode', 'trackRetentionDays'])
  })

  it('the declared key list IS the schema — neither can grow without the other', () => {
    // The list is hand-written (deriving it would need a cast). This is the
    // check that keeps it honest: add a field to the schema and forget the
    // list, or vice versa, and this goes red.
    expect(Object.keys(RetentionSettingsSchema.shape).toSorted()).toEqual(
      [...RETENTION_SETTING_KEYS].toSorted(),
    )
  })

  it('the retired per-family day knobs are not accepted, not even silently', () => {
    const s = resolveRetentionSettings({
      retentionObjectDays: 30,
      retentionMotionDays: 14,
      retentionAudioDays: 7,
    })
    expect(Object.keys(s).toSorted()).toEqual(['retentionMode', 'trackRetentionDays'])
  })
})

describe('resolveRetentionSettings', () => {
  it('defaults to follow-recordings with the 7-day window', () => {
    const s = resolveRetentionSettings({})
    expect(s.retentionMode).toBe('follow-recordings')
    expect(s.trackRetentionDays).toBe(TRACK_RETENTION_DEFAULT_DAYS)
    expect(TRACK_RETENTION_DEFAULT_DAYS).toBe(7)
  })

  it('one invalid field never discards the others', () => {
    const s = resolveRetentionSettings({ retentionMode: 'bogus', trackRetentionDays: 60 })
    expect(s.retentionMode).toBe('follow-recordings')
    expect(s.trackRetentionDays).toBe(60)
  })

  it('a negative window is not a window — it falls back to the default', () => {
    expect(resolveRetentionSettings({ trackRetentionDays: -3 }).trackRetentionDays).toBe(7)
    expect(resolveRetentionSettings({ trackRetentionDays: 'nope' }).trackRetentionDays).toBe(7)
  })
})

describe('followCutoffMs', () => {
  it('no footage → null (caller falls back to the custom window)', () => {
    expect(followCutoffMs(NOW, null)).toBeNull()
  })

  it('old footage → the footage horizon IS the cutoff', () => {
    expect(followCutoffMs(NOW, NOW - 60 * DAY)).toBe(NOW - 60 * DAY)
  })

  it('young footage → floored: the last N days always survive', () => {
    expect(followCutoffMs(NOW, NOW - 2 * DAY)).toBe(NOW - FOLLOW_FLOOR_DAYS * DAY)
  })
})

describe('FOLLOW_FLOOR_DAYS', () => {
  /**
   * The floor and the custom default are the SAME number on purpose, and now
   * that the cutoff governs the whole cascade rather than a few event rows,
   * that coincidence is the property that makes `follow-recordings` safe as the
   * default: switching a camera from `custom(7)` to follow can only ever keep
   * MORE, never less. Change one of these and you must change the other
   * consciously — which is what this assertion costs you.
   */
  it('equals the custom default, so follow mode is never more aggressive than custom', () => {
    expect(FOLLOW_FLOOR_DAYS).toBe(TRACK_RETENTION_DEFAULT_DAYS)
  })
})

describe('resolveRetentionCutoffs — ONE cutoff', () => {
  it('follow mode with footage: the footage horizon', () => {
    const c = resolveRetentionCutoffs(resolveRetentionSettings({}), NOW, NOW - 40 * DAY)
    expect(c.effectiveMode).toBe('follow-recordings')
    expect(c.cutoffMs).toBe(NOW - 40 * DAY)
  })

  it('follow mode WITHOUT footage falls back to the custom window — never unbounded', () => {
    const c = resolveRetentionCutoffs(resolveRetentionSettings({}), NOW, null)
    expect(c.effectiveMode).toBe('custom')
    expect(c.cutoffMs).toBe(NOW - 7 * DAY)
  })

  it('custom mode uses the window, and ignores footage entirely', () => {
    const s = resolveRetentionSettings({ retentionMode: 'custom', trackRetentionDays: 3 })
    const c = resolveRetentionCutoffs(s, NOW, NOW - 100 * DAY)
    expect(c.effectiveMode).toBe('custom')
    expect(c.cutoffMs).toBe(NOW - 3 * DAY)
  })

  it('0 = keep forever → null, and that is the ONE way retention is off', () => {
    const s = resolveRetentionSettings({ retentionMode: 'custom', trackRetentionDays: 0 })
    expect(resolveRetentionCutoffs(s, NOW, NOW - 100 * DAY).cutoffMs).toBeNull()
  })

  it('follow mode with no footage AND a 0 window is off too — the fallback is honest', () => {
    const s = resolveRetentionSettings({ trackRetentionDays: 0 })
    expect(resolveRetentionCutoffs(s, NOW, null).cutoffMs).toBeNull()
  })
})
