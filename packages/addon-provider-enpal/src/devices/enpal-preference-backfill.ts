import { errMsg, type IScopedLogger } from '@camstack/types'

/** What {@link backfillPrimaryChildPreference} needs from the device and the device-manager. */
export interface PreferenceBackfillInput {
  readonly deviceId: number
  /** The preference on the container's meta row, `undefined` when it carries none. */
  readonly stored: readonly string[] | undefined
  /** What the catalog declares for this piece, limited to the children it was adopted with. */
  readonly declared: readonly string[]
  readonly write: (keys: readonly string[]) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * Stamp the declared primary-child preference on a container adopted before
 * the declaration existed, or before it changed. Adoption stamps it through
 * `InitialDeviceMeta`; a restore passes no initial meta, so an older row would
 * otherwise keep the old declaration (or none) — a System adopted before its
 * Energy system child (#513) would keep standing for its PV sensor.
 *
 * The stored declaration is always the provider's own, so a different one is
 * replaced and an equal one is left alone (no write). The operator's pick
 * (`primaryChildEntityId`) is a different column, never written here, and
 * still wins at resolution.
 *
 * @returns whether it wrote.
 */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

export async function backfillPrimaryChildPreference(
  input: PreferenceBackfillInput,
): Promise<boolean> {
  const { deviceId, stored, declared, write, logger } = input
  if (declared.length === 0) return false
  if (stored !== undefined && sameKeys(stored, declared)) return false
  try {
    await write(declared)
  } catch (err: unknown) {
    logger.warn('enpal: could not stamp the primary-child preference', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return false
  }
  logger.info('enpal: stamped the current primary-child preference on a container', {
    tags: { deviceId },
    meta: { primaryChildPreference: declared, previous: stored ?? null },
  })
  return true
}
