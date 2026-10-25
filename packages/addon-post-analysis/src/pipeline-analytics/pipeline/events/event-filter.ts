export interface EventEmitterConfig {
  /** Minimum confirmed hits (frame count) before a track may emit events. */
  readonly minTrackAge: number
  /**
   * Minimum wall-clock track age (ms, `dwellTimeMs`) before a track may emit
   * events — fps-independent so a sub-second flicker fragment never becomes an
   * event (0 = disabled). Complements the frame-count `minTrackAge`. The addon
   * overrides this from per-device tracking settings; the library default stays
   * 0 so it never surprises a bare emitter.
   */
  readonly minTrackAgeMs: number
  readonly cooldownSec: number
  readonly enabledTypes: readonly string[]
  /**
   * Emit a synthetic APPEARANCE event (`object.detected`) the first time a track
   * passes the min-age gate WITHOUT already producing a crop-bearing transition
   * that frame — so every subject's passage is valued with a real current-frame
   * crop + a bestEventId, not just the ones that happen to fire a zone/state
   * transition. Default on; the appearance event is NOT surfaced to the
   * notification bus (see the addon), so it never changes notification volume.
   */
  readonly emitAppearance: boolean
}

export const DEFAULT_EVENT_EMITTER_CONFIG: EventEmitterConfig = {
  minTrackAge: 3,
  minTrackAgeMs: 0,
  cooldownSec: 5,
  emitAppearance: true,
  enabledTypes: [
    'object.entering',
    'object.leaving',
    'object.stationary',
    'object.loitering',
    'zone.enter',
    'zone.exit',
    'tripwire.cross',
  ],
}
