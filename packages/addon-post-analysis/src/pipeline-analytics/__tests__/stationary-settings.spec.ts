import { describe, it, expect } from 'vitest'
import {
  StationarySettingsSchema,
  STATIONARY_DEFAULTS,
  resolveStationarySettings,
} from '../stationary-settings.js'
import {
  SUPPRESS_IOU,
  WAKE_ASSOC_IOU,
  SESSION_STILLNESS_WINDOW_MS,
  ENTRY_TTL_MS,
} from '../pipeline/stationary/stationary-types.js'

describe('stationary-settings', () => {
  it('reset == unset == today: defaults equal the runtime constants (no drift)', () => {
    expect(STATIONARY_DEFAULTS).toEqual({
      enabled: true,
      suppressIou: SUPPRESS_IOU,
      wakeAssocIou: WAKE_ASSOC_IOU,
      sessionStillnessWindowMs: SESSION_STILLNESS_WINDOW_MS,
      entryTtlMs: ENTRY_TTL_MS,
    })
  })

  it('an empty blob (unset / reset) resolves to the runtime defaults', () => {
    expect(resolveStationarySettings({})).toEqual(STATIONARY_DEFAULTS)
  })

  it('a valid per-device override wins over the default', () => {
    const resolved = resolveStationarySettings({
      enabled: false,
      suppressIou: 0.8,
      wakeAssocIou: 0.05,
      sessionStillnessWindowMs: 60_000,
      entryTtlMs: 600_000,
    })
    expect(resolved).toEqual({
      enabled: false,
      suppressIou: 0.8,
      wakeAssocIou: 0.05,
      sessionStillnessWindowMs: 60_000,
      entryTtlMs: 600_000,
    })
  })

  it('an invalid field falls back to its default without throwing', () => {
    const resolved = resolveStationarySettings({
      suppressIou: 5, // out of [0.3, 0.9]
      wakeAssocIou: 'nope',
      sessionStillnessWindowMs: 1, // below min
      entryTtlMs: null,
    })
    expect(resolved.suppressIou).toBe(SUPPRESS_IOU)
    expect(resolved.wakeAssocIou).toBe(WAKE_ASSOC_IOU)
    expect(resolved.sessionStillnessWindowMs).toBe(SESSION_STILLNESS_WINDOW_MS)
    expect(resolved.entryTtlMs).toBe(ENTRY_TTL_MS)
  })

  it('schema is the single source — parse of {} matches STATIONARY_DEFAULTS', () => {
    expect(StationarySettingsSchema.parse({})).toEqual(STATIONARY_DEFAULTS)
  })
})
