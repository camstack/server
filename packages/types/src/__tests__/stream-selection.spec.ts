/**
 * Tests for `pickPreferredRtspEntry` — the picker that resolves the
 * operator's `streamPreference` setting against the broker's RTSP
 * entries. The smart-auto path (resolution-targeted picking) lets
 * Alexa default to its 720p sweet spot and HomeKit to its 1080p sweet
 * spot without re-encoding a 4K source. The picker lives in
 * `@camstack/types` so every exporter calls the same code path.
 */
import { describe, it, expect } from 'vitest'
import { pickPreferredRtspEntry, type RtspEntryLike } from '../stream-selection.js'

const DEVICE_ID = 97

function entry(
  suffix: string,
  opts: {
    enabled?: boolean
    resolution?: { width: number; height: number }
    codec?: string
    profile?: 'high' | 'mid' | 'low'
  } = {},
): RtspEntryLike {
  return {
    brokerId: `${DEVICE_ID}/${suffix}`,
    url: `rtsp://127.0.0.1:8554/${suffix}`,
    mutedUrl: `rtsp://127.0.0.1:8554/${suffix}/muted`,
    enabled: opts.enabled ?? true,
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
  }
}

describe('pickPreferredRtspEntry', () => {
  it('returns null when there are no entries', () => {
    expect(pickPreferredRtspEntry([], 'auto', DEVICE_ID)).toBeNull()
  })

  it('returns null when every entry is disabled', () => {
    const entries = [entry('main', { enabled: false }), entry('sub', { enabled: false })]
    expect(pickPreferredRtspEntry(entries, 'auto', DEVICE_ID)).toBeNull()
  })

  it('exact streamPreference match wins over auto fallback', () => {
    const entries = [
      entry('main', { resolution: { width: 1920, height: 1080 } }),
      entry('sub', { resolution: { width: 640, height: 360 } }),
    ]
    const picked = pickPreferredRtspEntry(entries, 'sub', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    expect(picked?.profileId).toBe('sub')
  })

  it('falls back to first-enabled when the preferred suffix is missing', () => {
    const entries = [entry('main'), entry('sub')]
    const picked = pickPreferredRtspEntry(entries, 'slot-9', DEVICE_ID)
    expect(picked?.profileId).toBe('main')
  })

  it('auto without target → first enabled (legacy semantic preserved)', () => {
    const entries = [entry('main', { enabled: false }), entry('sub'), entry('ext')]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID)
    expect(picked?.profileId).toBe('sub')
  })

  it('auto with target 1280×720 prefers the slot ≥ target with the smallest pixel count', () => {
    const entries = [
      entry('hi', { resolution: { width: 3840, height: 2160 } }), // 8.3 MP
      entry('mid', { resolution: { width: 1280, height: 720 } }), // 0.92 MP — exact match
      entry('low', { resolution: { width: 640, height: 360 } }), // 0.23 MP
    ]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    expect(picked?.profileId).toBe('mid')
  })

  it('auto with target 1920×1080 picks the closest slot just above target (HomeKit case)', () => {
    const entries = [
      entry('hi', { resolution: { width: 3840, height: 2160 } }),
      entry('mid', { resolution: { width: 1920, height: 1080 } }),
      entry('low', { resolution: { width: 640, height: 360 } }),
    ]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID, {
      targetResolution: { width: 1920, height: 1080 },
    })
    expect(picked?.profileId).toBe('mid')
  })

  it('auto with target but no entry ≥ target picks the LARGEST below target', () => {
    const entries = [
      entry('sub', { resolution: { width: 640, height: 360 } }), // 0.23 MP
      entry('ext', { resolution: { width: 320, height: 240 } }), // 0.077 MP
    ]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    expect(picked?.profileId).toBe('sub')
  })

  it('auto with target falls back to first-enabled when no entry advertises resolution', () => {
    const entries = [entry('main'), entry('sub')]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    expect(picked?.profileId).toBe('main')
  })

  it('skips disabled entries even when their resolution matches target perfectly', () => {
    const entries = [
      entry('main', { enabled: false, resolution: { width: 1280, height: 720 } }),
      entry('sub', { resolution: { width: 640, height: 360 } }),
    ]
    const picked = pickPreferredRtspEntry(entries, 'auto', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    expect(picked?.profileId).toBe('sub')
  })

  it('matches a profile-keyed entry by its `profile` field, not the brokerId suffix', () => {
    // brokerId suffixes deliberately differ from the profile names so
    // only the `profile` match can select 'mid' (the legacy suffix path
    // would fall through to auto/first-enabled = native:main).
    const entries = [
      entry('native:main', { profile: 'high', resolution: { width: 3840, height: 2160 } }),
      entry('native:ext', { profile: 'mid', resolution: { width: 1920, height: 1080 } }),
      entry('native:sub', { profile: 'low', resolution: { width: 640, height: 360 } }),
    ]
    const picked = pickPreferredRtspEntry(entries, 'mid', DEVICE_ID)
    expect(picked?.profileId).toBe('native:ext')
  })

  it('profile pref falls back to auto resolution-pick when that profile is absent', () => {
    const entries = [
      entry('high', { profile: 'high', resolution: { width: 3840, height: 2160 } }),
      entry('low', { profile: 'low', resolution: { width: 640, height: 360 } }),
    ]
    const picked = pickPreferredRtspEntry(entries, 'mid', DEVICE_ID, {
      targetResolution: { width: 1280, height: 720 },
    })
    // 'mid' missing → auto: prefer >= target → high (3840x2160) is the only one >= target.
    expect(picked?.profileId).toBe('high')
  })

  it('legacy brokerId-suffix match still works (back-compat)', () => {
    const entries = [entry('native:main'), entry('native:sub')]
    const picked = pickPreferredRtspEntry(entries, 'native:sub', DEVICE_ID)
    expect(picked?.profileId).toBe('native:sub')
  })
})
