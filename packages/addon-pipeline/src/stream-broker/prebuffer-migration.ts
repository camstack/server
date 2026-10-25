/**
 * MIGRATION of the retired per-stream pre-roll override onto the one prebuffer.
 *
 * `DeviceOverride.preRollMs` was the per-camera-stream DETECTION pre-roll: how
 * much history a decode dial could be handed. D381 retires it — there is one
 * retention now and it is the prebuffer's — but a key that is merely removed
 * from a non-strict `z.object` is **stripped in silence** on the next save,
 * which is the failure D380 came within one commit of shipping.
 *
 * So the key is retired EXPLICITLY: read once, converted into the
 * configuration that now carries its meaning, and cleared. An operator who had
 * typed "3 s of history on 102's substream" keeps 3 s of history on 102's
 * substream; they do not silently get the cluster default, and they do not
 * silently get nothing.
 */
import { PREBUFFER_MAX_SEC, PREBUFFER_MIN_SEC, type StreamPrebufferOverride } from './prebuffer.js'

/** The slice of a persisted device override this migration reads and rewrites. */
export interface PrebufferMigratableOverride {
  readonly preBuffer?: Readonly<Record<string, StreamPrebufferOverride>>
  /** RETIRED (D381). Present only in configurations written before that record. */
  readonly preRollMs?: Readonly<Record<string, number>>
}

/** What the migration did, so the caller can log it per device. */
export interface PrebufferMigrationResult {
  readonly override: PrebufferMigratableOverride
  /** Streams whose retired pre-roll became a prebuffer. Empty = nothing to do. */
  readonly migrated: readonly string[]
  /** Streams whose retired pre-roll was dropped because an explicit prebuffer already existed. */
  readonly superseded: readonly string[]
}

/**
 * Fold a retired `preRollMs` map into the prebuffer overrides.
 *
 * An EXPLICIT prebuffer override wins and the retired value is dropped: the
 * operator answered the same question later and more directly, and a migration
 * that overwrote it would be this subsystem's original sin one more time — two
 * writers for one number.
 *
 * Rounds UP to whole seconds. The prebuffer is configured in seconds and the
 * retired knob in milliseconds; rounding down would hand back a window
 * narrower than the one that was running, which is the direction that loses
 * media.
 */
export function migrateRetiredPreRollOverride(
  input: PrebufferMigratableOverride,
): PrebufferMigrationResult {
  const retired = input.preRollMs
  if (retired === undefined || Object.keys(retired).length === 0) {
    return { override: input, migrated: [], superseded: [] }
  }
  const preBuffer: Record<string, StreamPrebufferOverride> = { ...input.preBuffer }
  const migrated: string[] = []
  const superseded: string[] = []
  for (const [camStreamId, ms] of Object.entries(retired)) {
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (input.preBuffer?.[camStreamId] !== undefined) {
      superseded.push(camStreamId)
      continue
    }
    const seconds = Math.min(PREBUFFER_MAX_SEC, Math.max(PREBUFFER_MIN_SEC, Math.ceil(ms / 1000)))
    preBuffer[camStreamId] = { enabled: true, seconds }
    migrated.push(camStreamId)
  }
  const { preRollMs: _retired, ...rest } = input
  return {
    override: Object.keys(preBuffer).length > 0 ? { ...rest, preBuffer } : rest,
    migrated,
    superseded,
  }
}
