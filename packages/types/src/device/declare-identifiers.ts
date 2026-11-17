/**
 * The provider side of `device-manager.setIdentifiers` (D1059): normalise what a
 * driver read, log what was refused, send the declaration. `BaseDevice.
 * declareIdentifiers` calls it for a device; a provider module that holds only a
 * device id (a metadata populator) calls it directly with `ctx.api`.
 *
 * Best-effort like every other device-meta write from a driver: a failure is
 * logged with `tags: { deviceId }` and answered as an outcome, never thrown, so a
 * device boot never fails on it.
 */

import type { IScopedLogger } from '../interfaces/logging.js'
import { errMsg } from '../utils/err-msg.js'
import {
  isEmptyIdentifiers,
  normaliseIdentifiers,
  type DeviceIdentifiers,
  type NormaliseIdentifiersOptions,
  type RawDeviceIdentifiers,
} from './device-identifiers.js'

/** The input `device-manager.setIdentifiers` takes. */
export interface SetIdentifiersInput {
  readonly deviceId: number
  readonly identifiers: DeviceIdentifiers | null
}

/** The slice of the generated `ctx.api.deviceManager.setIdentifiers` this helper uses. */
export interface IdentifiersWriter {
  mutate(input: SetIdentifiersInput): Promise<unknown>
}

export interface DeclareIdentifiersDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  /** `ctx.api.deviceManager?.setIdentifiers`; absent when the device-manager is not reachable. */
  readonly writer: IdentifiersWriter | undefined
}

/**
 * - `declared` — written (or already equal to what is stored);
 * - `nothing-to-declare` — no value survived normalisation; NOTHING is written, so
 *   a probe that read nothing never erases an earlier declaration;
 * - `unavailable` — no device-manager to write to;
 * - `failed` — the write was refused or threw (logged).
 */
export type DeclareIdentifiersOutcome = 'declared' | 'nothing-to-declare' | 'unavailable' | 'failed'

export interface DeclareIdentifiersResult {
  readonly outcome: DeclareIdentifiersOutcome
  readonly identifiers: DeviceIdentifiers
}

/**
 * Normalise `raw` and declare it as the device's WHOLE identifier set (it replaces
 * the previous declaration — pass everything the provider knows in one call).
 */
export async function declareDeviceIdentifiers(
  deps: DeclareIdentifiersDeps,
  raw: RawDeviceIdentifiers,
  options: NormaliseIdentifiersOptions = {},
): Promise<DeclareIdentifiersResult> {
  const { deviceId, logger, writer } = deps
  const { identifiers, rejected } = normaliseIdentifiers(raw, options)
  for (const r of rejected) {
    logger.warn('identifier refused — not declared', {
      tags: { deviceId },
      meta: { key: r.key, value: r.value, reason: r.reason },
    })
  }
  if (isEmptyIdentifiers(identifiers)) {
    logger.debug('no identifier to declare', { tags: { deviceId } })
    return { outcome: 'nothing-to-declare', identifiers }
  }
  if (writer === undefined) {
    logger.warn('identifiers not declared — device-manager unreachable', { tags: { deviceId } })
    return { outcome: 'unavailable', identifiers }
  }
  try {
    await writer.mutate({ deviceId, identifiers })
    return { outcome: 'declared', identifiers }
  } catch (err) {
    logger.warn('identifiers not declared — setIdentifiers failed', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return { outcome: 'failed', identifiers }
  }
}
