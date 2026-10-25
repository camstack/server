/**
 * The operator's two clip knobs, and the one thing a cascade must get right:
 * **reset == unset == the default.**
 *
 * The repo's cascade pattern (`stationary-settings.ts`) exists because a
 * per-device override that resolves differently from "never set" makes a Reset
 * button a lie. Here the stakes are a camera's HomeKit copies: an override the
 * operator cleared must fall back to the GLOBAL default he set, not to the
 * shipped one, and an absent global must fall back to fourteen days.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CLIP_RETENTION_DAYS,
  resolveClipRetentionDays,
  resolveKeepHomekitClips,
} from '../hap-export.addon.js'

describe('resolveKeepHomekitClips — default ON', () => {
  it('keeps clips for an entry persisted before the field existed', () => {
    // Same reasoning as `resolveHksvRecording`: a stream nobody teed is gone,
    // so absent must mean ON or the feature does nothing until the operator
    // visits every camera — and the clips lost meanwhile are unrecoverable.
    expect(resolveKeepHomekitClips(null)).toBe(true)
    expect(resolveKeepHomekitClips(undefined)).toBe(true)
    expect(resolveKeepHomekitClips({ streamPreference: 'auto' })).toBe(true)
  })

  it('honours an explicit operator OFF', () => {
    expect(resolveKeepHomekitClips({ streamPreference: 'auto', keepClips: false })).toBe(false)
  })

  it('stays ON when explicitly on', () => {
    expect(resolveKeepHomekitClips({ streamPreference: 'auto', keepClips: true })).toBe(true)
  })
})

describe('resolveClipRetentionDays — global default plus per-device override', () => {
  it('ships at fourteen days', () => {
    expect(DEFAULT_CLIP_RETENTION_DAYS).toBe(14)
    expect(resolveClipRetentionDays(null, DEFAULT_CLIP_RETENTION_DAYS)).toBe(14)
  })

  it('falls back to the GLOBAL default when the camera has no override', () => {
    expect(resolveClipRetentionDays({ streamPreference: 'auto' }, 30)).toBe(30)
  })

  it('lets one camera differ from the fleet', () => {
    expect(resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: 3 }, 30)).toBe(3)
  })

  it('treats a cleared override exactly like one never set', () => {
    // Reset == unset. A UI that writes `undefined` on clear and a UI that never
    // wrote the key must resolve identically, or Reset does not reset.
    expect(
      resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: undefined }, 30),
    ).toBe(30)
  })

  it('refuses a value that would break a rail, rather than storing a lie', () => {
    // Zero would be "delete every clip the moment it lands" — the tee turned
    // into a no-op by a number nobody read as one. Clamped, both ends.
    expect(resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: 0 }, 30)).toBe(
      30,
    )
    expect(resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: -5 }, 30)).toBe(
      30,
    )
    expect(
      resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: 10_000 }, 30),
    ).toBe(365)
    expect(
      resolveClipRetentionDays({ streamPreference: 'auto', clipRetentionDays: Number.NaN }, 30),
    ).toBe(30)
  })

  it('falls back to the shipped default when the GLOBAL value is nonsense too', () => {
    expect(resolveClipRetentionDays(null, 0)).toBe(DEFAULT_CLIP_RETENTION_DAYS)
    expect(resolveClipRetentionDays(null, Number.NaN)).toBe(DEFAULT_CLIP_RETENTION_DAYS)
  })
})
