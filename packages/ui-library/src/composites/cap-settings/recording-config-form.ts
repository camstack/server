import { deriveRecordingMode } from '@camstack/types'
import type {
  RecordingBand,
  RecordingBandMode,
  RecordingConfig,
  RecordingStorageMode,
  RecordingTriggers,
  RecordingRetention,
  CamProfile,
} from '@camstack/types'

/** Every weekday — the `days` of a band that covers the whole week. */
export const ALL_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6] as const

/** The full-day span of an always-on band (`HH:MM`, 23:59 = end of day). */
export const ALL_DAY_START = '00:00'
export const ALL_DAY_END = '23:59'

// ── Bands (the ONLY authored recording intent) ──────────────────────────────

/** A band covering every day, all day, in `mode` — what the Base tab authors. */
export function alwaysBand(mode: RecordingBandMode, rest?: Partial<RecordingBand>): RecordingBand {
  return {
    days: [...ALL_WEEKDAYS],
    start: ALL_DAY_START,
    end: ALL_DAY_END,
    mode,
    ...rest,
  }
}

/** A fresh row for the Advanced band table: every day, office hours, continuous. */
export function emptyBand(): RecordingBand {
  return { days: [...ALL_WEEKDAYS], start: '09:00', end: '18:00', mode: 'continuous' }
}

export function withBandAt(
  bands: readonly RecordingBand[],
  index: number,
  patch: Partial<RecordingBand>,
): RecordingBand[] {
  return bands.map((band, i) => (i === index ? { ...band, ...patch } : band))
}

export function removeBandAt(bands: readonly RecordingBand[], index: number): RecordingBand[] {
  return bands.filter((_, i) => i !== index)
}

/** Does this band cover the whole week, all day? (the Base-tab shape) */
export function isAlwaysBand(band: RecordingBand): boolean {
  const coversWeek = band.days.length === 0 || ALL_WEEKDAYS.every((d) => band.days.includes(d))
  return coversWeek && band.start === ALL_DAY_START && band.end === ALL_DAY_END
}

/**
 * A config is "advanced" when its bands cannot be expressed by the Base tab —
 * i.e. more than one band, or a single band restricted in time or weekday. Such
 * a config opens directly in the Advanced band table so nothing is silently
 * flattened by the simpler form.
 */
export function isAdvancedConfig(cfg: RecordingConfig): boolean {
  if (cfg.bands.length > 1) return true
  const [only] = cfg.bands
  return only !== undefined && !isAlwaysBand(only)
}

// ── Basic (mode-first) form state ───────────────────────────────────────────

/**
 * The editable shape of the Basic recording form: a storage mode plus the
 * `events` parameters. It compiles to exactly ONE always-on band (or none, when
 * `off`) — bands are the only thing that reaches the wire.
 */
export interface RecordingFormState {
  readonly mode: RecordingStorageMode
  readonly profiles?: readonly CamProfile[]
  readonly segmentSeconds?: number
  readonly triggers: RecordingTriggers
  readonly postBufferSec?: number
  readonly retention?: RecordingRetention
}

/**
 * Read a persisted config into the Basic form state. `mode` is DERIVED from the
 * bands by the same function the recorder stamps `config.mode` with; the
 * `events` parameters come from the first events band, so re-opening the form
 * shows what is actually recorded.
 */
export function formStateFromConfig(cfg: RecordingConfig): RecordingFormState {
  const eventsBand = cfg.bands.find((band) => band.mode === 'events')
  return {
    mode: deriveRecordingMode(cfg),
    profiles: cfg.profiles,
    segmentSeconds: cfg.segmentSeconds,
    triggers: eventsBand?.triggers ?? {},
    postBufferSec: eventsBand?.postBufferSec,
    retention: cfg.retention,
  }
}

/**
 * Serialize the Basic form state to the wire config: one always-on band of the
 * chosen mode, none when `off`. `enabled` follows the mode; `mode` itself is
 * NOT sent — the recorder stamps it as the derived summary of the bands.
 */
export function configFromFormState(state: RecordingFormState): RecordingConfig {
  return {
    enabled: state.mode !== 'off',
    bands: bandsFromFormState(state),
    // The device-decided mode is the one authored intent that is not a band —
    // exclusive with `bands`, which is why `bandsFromFormState` returns none
    // for it (D380).
    ...(state.mode === 'on-device-decision' ? { deviceDecision: true } : {}),
    profiles: state.profiles ? [...state.profiles] : undefined,
    segmentSeconds: state.segmentSeconds,
    retention: state.retention,
  }
}

/** The Base tab's bands: one always-on band of the chosen mode (none = off). */
export function bandsFromFormState(state: RecordingFormState): RecordingBand[] {
  if (state.mode === 'off') return []
  if (state.mode === 'on-device-decision') return []
  if (state.mode === 'continuous') return [alwaysBand('continuous')]
  return [
    alwaysBand('events', {
      ...(Object.keys(state.triggers).length > 0 ? { triggers: state.triggers } : {}),
      ...(state.postBufferSec !== undefined ? { postBufferSec: state.postBufferSec } : {}),
    }),
  ]
}
