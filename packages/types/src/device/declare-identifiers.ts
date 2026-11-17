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
  type DeviceIdentifierKey,
  normaliseIdentifiers,
  type DeviceIdentifiers,
  type NormaliseIdentifiersOptions,
  type RawDeviceIdentifiers,
} from './device-identifiers.js'

/** The input `device-manager.setIdentifiers` takes. */
export interface SetIdentifiersInput {
  readonly deviceId: number
  readonly identifiers: DeviceIdentifiers | null
  /** Kinds whose read FAILED this time: the stored value is kept. */
  readonly unread?: readonly DeviceIdentifierKey[]
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

export interface DeclareIdentifiersOptions extends NormaliseIdentifiersOptions {
  /**
   * Kinds the provider TRIED to read and could not (a probe threw, a session has
   * not answered yet). Their stored values are kept; every other kind is replaced
   * by this declaration, and a kind absent from it is removed. Never list a kind
   * that was read and found absent — that is what removes a stale value.
   */
  readonly unread?: readonly DeviceIdentifierKey[]
}

/**
 * Normalise `raw` and declare it: every kind it carries replaces the stored one,
 * every kind it lacks is removed, except the kinds in `options.unread` (a failed
 * read keeps what was stored) — pass everything the provider read in one call.
 */
export async function declareDeviceIdentifiers(
  deps: DeclareIdentifiersDeps,
  raw: RawDeviceIdentifiers,
  options: DeclareIdentifiersOptions = {},
): Promise<DeclareIdentifiersResult> {
  const { deviceId, logger, writer } = deps
  const { unread, ...normaliseOptions } = options
  const { identifiers, rejected } = normaliseIdentifiers(raw, normaliseOptions)
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
    await writer.mutate({
      deviceId,
      identifiers,
      ...(unread !== undefined && unread.length > 0 ? { unread } : {}),
    })
    return { outcome: 'declared', identifiers }
  } catch (err) {
    logger.warn('identifiers not declared — setIdentifiers failed', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return { outcome: 'failed', identifiers }
  }
}
