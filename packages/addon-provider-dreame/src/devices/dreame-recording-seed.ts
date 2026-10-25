/**
 * The robot camera's ONE-SHOT recording seed.
 *
 * A camera that can say "record me now" and is never configured to record is a
 * feature nobody switched on: on the reference hub, 4374 recorded only because
 * the operator wrote its config by hand through the API, and 4373 — the second
 * robot camera — sat at `{"enabled": false, "bands": []}` and would never have
 * recorded anything. So the provider seeds the mode the first time it brings
 * the camera up.
 *
 * ## What makes this safe to do at all
 *
 * A provider that writes an operator-owned setting is normally the D62 failure.
 * Two things keep this on the right side of that line:
 *
 *  - **The authority does not move.** `RecordingConfig` stays THE authority for
 *    what this camera records; the provider writes a DEFAULT into it once
 *    through the same `recording.setDeviceConfig` an operator uses, and keeps
 *    no second copy of the value. Read the mode back and you read the
 *    recorder's config, never a Dreame field.
 *  - **The mark is not the value.** `recordingSeededAt` says "this camera was
 *    seeded", which stays true after the operator switches recording off. The
 *    current value says something else entirely, and asking the value whether
 *    to seed is exactly how this class of feature turns into a switch that
 *    flips itself back on at every restart: an operator's `off` and a camera
 *    that was never seeded read IDENTICALLY (`enabled: false, bands: []`).
 *
 * The seed is therefore gated on the MARK alone, and the mark is written only
 * after the config write succeeded — a seed that never landed has never been
 * seen by anyone, so retrying it at the next boot takes nothing away.
 */
import type { IScopedLogger, RecordingConfig } from '@camstack/types'
import { errMsg } from '@camstack/types'

/**
 * THE config the provider seeds: recording ON, decided by the device.
 *
 * No bands (the mode carries none, D380) and no profiles/retention: those are
 * cluster-wide defaults the recorder already resolves, and pinning them here
 * would be the provider deciding storage policy for a camera it does not own.
 */
export const DEVICE_DECISION_SEED_CONFIG: RecordingConfig = Object.freeze({
  enabled: true,
  deviceDecision: true,
  bands: [],
})

/** What one call to {@link seedDeviceDecisionRecording} did. */
export type RecordingSeedOutcome =
  /** The config was written and the durable mark persisted. */
  | 'seeded'
  /** The mark was already there — an operator's choice is never overwritten. */
  | 'already-seeded'
  /** The config write failed; nothing was marked, so the next boot retries. */
  | 'failed'

export interface RecordingSeedDeps {
  readonly deviceId: number
  /** The DURABLE mark, read from the device's persisted config. */
  readonly alreadySeeded: boolean
  /** `recording.setDeviceConfig` for this camera. */
  readonly writeConfig: (config: RecordingConfig) => Promise<unknown>
  /** Persist the mark. Called ONLY after {@link writeConfig} resolved. */
  readonly markSeeded: () => Promise<void>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/**
 * Seed `on-device-decision` recording for this camera, once, ever.
 *
 * Never throws: it runs on the activation path and a camera that fails to be
 * seeded must still come up. Every branch that does not write says why — a
 * silent skip here is indistinguishable from the feature not existing.
 */
export async function seedDeviceDecisionRecording(
  deps: RecordingSeedDeps,
): Promise<RecordingSeedOutcome> {
  const { deviceId, logger } = deps
  if (deps.alreadySeeded) return 'already-seeded'
  try {
    await deps.writeConfig(DEVICE_DECISION_SEED_CONFIG)
  } catch (err: unknown) {
    logger.warn(
      'robot camera: could not seed on-device-decision recording — retried at the next start',
      { tags: { deviceId }, meta: { error: errMsg(err) } },
    )
    return 'failed'
  }
  try {
    await deps.markSeeded()
  } catch (err: unknown) {
    // The config landed; only the mark did not. Loud, because this is the one
    // way the seed could run a second time and overwrite an operator's off.
    logger.warn(
      'robot camera: recording seeded but the one-shot mark could not be persisted — a restart ' +
        'may seed it again and override an operator who switched it off',
      { tags: { deviceId }, meta: { error: errMsg(err) } },
    )
    return 'seeded'
  }
  logger.info('robot camera: seeded on-device-decision recording (once, at first start)', {
    tags: { deviceId },
  })
  return 'seeded'
}
