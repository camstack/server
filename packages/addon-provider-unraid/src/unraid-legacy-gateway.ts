/**
 * The Gateway device older versions adopted for an Unraid server (D1064: the server is a Host,
 * a Gateway exists only when necessary). A row persisted under its stable id has no class any
 * more, so it is retired on restore through the normal device removal, which records the
 * tombstone (D865) — never by its absence from a list.
 */
import { DeviceType, errMsg, type IScopedLogger, type SavedDevice } from '@dominevo/types'

/** The Gateway's own native id; a container or VM named "gateway" is `docker:gateway` / `vm:gateway`. */
const LEGACY_GATEWAY_NATIVE_ID = 'gateway'
const STABLE_ID_PREFIX = 'unraid:'
const STABLE_ID_SUFFIX = ':gateway'

/**
 * Is this persisted row the Gateway an older version adopted? Anchored on the stable id's known
 * prefix and suffix, so an integration id holding a `:` matches too
 * (`unraid:<integrationId>:gateway`), and on the row itself: its `nativeId` is `gateway`, or
 * its type is Gateway (this addon has no Gateway class any more; a config that failed to load
 * reads as empty).
 */
export function isLegacyUnraidGatewayRow(
  row: Pick<SavedDevice, 'stableId' | 'config' | 'type'>,
): boolean {
  return (
    (row.config['nativeId'] === LEGACY_GATEWAY_NATIVE_ID || row.type === DeviceType.Gateway) &&
    row.stableId.startsWith(STABLE_ID_PREFIX) &&
    row.stableId.endsWith(STABLE_ID_SUFFIX) &&
    row.stableId.length > STABLE_ID_PREFIX.length + STABLE_ID_SUFFIX.length
  )
}

/** Inputs of {@link retireLegacyUnraidGatewayRows}. */
export interface RetireLegacyGatewayInput {
  readonly saved: readonly SavedDevice[]
  /** The kernel's device removal: cascades and writes the tombstone. */
  readonly remove: (deviceId: number) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * Remove every legacy Gateway row and return the rows left to restore. A removal that fails
 * is logged and the row is still left out (it has no class to restore into); the next boot
 * tries again.
 */
export async function retireLegacyUnraidGatewayRows(
  input: RetireLegacyGatewayInput,
): Promise<readonly SavedDevice[]> {
  const rest: SavedDevice[] = []
  for (const row of input.saved) {
    if (!isLegacyUnraidGatewayRow(row)) {
      rest.push(row)
      continue
    }
    try {
      await input.remove(row.id)
      input.logger.info('Unraid: legacy Gateway device retired, the server is its Host', {
        tags: { deviceId: row.id },
        meta: { stableId: row.stableId },
      })
    } catch (err) {
      input.logger.warn('Unraid: legacy Gateway device retire failed, retried next boot', {
        tags: { deviceId: row.id },
        meta: { stableId: row.stableId, error: errMsg(err) },
      })
    }
  }
  return rest
}
