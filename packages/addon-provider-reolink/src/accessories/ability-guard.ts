/**
 * Operator writes on an accessory child are refused when the parent camera
 * does not advertise the ability behind it. A Floodlight child that outlived
 * a probe saying `hasFloodlight:false` used to accept `setState`, send
 * `setWhiteLedState` to a camera without the hardware, write the slice and
 * report success (D391: a branch that accepts and produces nothing is the
 * same bug as one that silently drops).
 */

import type { IScopedLogger } from '@camstack/types'
import type { ReolinkAccessoryHost } from './base.js'

export type AccessoryAbilityFlag = 'hasFloodlight' | 'hasSiren'

/** Typed refusal: the message names the flag and what the parent reported. */
export class AccessoryAbilityError extends Error {
  readonly flag: AccessoryAbilityFlag
  constructor(flag: AccessoryAbilityFlag, reported: boolean | undefined) {
    super(
      `The camera does not advertise ${flag} (reported ${reported === undefined ? 'unknown' : String(reported)}); the command was not sent.`,
    )
    this.name = 'AccessoryAbilityError'
    this.flag = flag
  }
}

/**
 * Throws {@link AccessoryAbilityError} (after logging it) unless the host
 * does not report the flag `false`; an unknown flag passes with a warning. A host that cannot report abilities (older impls)
 * is allowed through, as before.
 */
export function assertAccessoryAbility(
  host: ReolinkAccessoryHost,
  flag: AccessoryAbilityFlag,
  logger: IScopedLogger,
  deviceId: number,
  action: string,
): void {
  if (host.probeAbility === undefined) return
  const reported = host.probeAbility(flag)
  if (reported === true) return
  if (reported === undefined) {
    logger.warn('accessory command allowed — the parent ability is unknown', {
      tags: { deviceId },
      meta: { flag, action },
    })
    return
  }
  logger.warn('accessory command refused — the parent camera does not advertise the ability', {
    tags: { deviceId },
    meta: { flag, reported: reported ?? null, action },
  })
  throw new AccessoryAbilityError(flag, reported)
}
