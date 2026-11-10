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
 * the declaration existed. Adoption stamps it through `InitialDeviceMeta`;
 * a restore passes no initial meta, so an older row would otherwise never get
 * one and keep being shown by the heuristic's child.
 *
 * Only an ABSENT declaration is filled: a stored one is the provider's own and
 * is left alone. The operator's pick (`primaryChildEntityId`) is a different
 * column, never written here, and still wins at resolution.
 *
 * @returns whether it wrote.
 */
export async function backfillPrimaryChildPreference(
  input: PreferenceBackfillInput,
): Promise<boolean> {
  const { deviceId, stored, declared, write, logger } = input
  if (stored !== undefined && stored.length > 0) return false
  if (declared.length === 0) return false
  try {
    await write(declared)
  } catch (err: unknown) {
    logger.warn('enpal: could not stamp the primary-child preference', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return false
  }
  logger.info('enpal: stamped the primary-child preference on a container adopted without one', {
    tags: { deviceId },
    meta: { primaryChildPreference: declared },
  })
  return true
}
