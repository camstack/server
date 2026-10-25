/**
 * Apply the visibility mirror's changes to the linked Alexa accounts (S1,
 * D767): push what a user gained, delete what a user lost (already confirmed by
 * two reads in `AccountVisibilityMirror`). Never throws; every outcome is logged
 * against the account and the device.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { VisibilityChange } from './account-visibility.js'

export interface VisibilitySyncTarget {
  readonly pushDeviceToAccount: (userId: string, deviceId: number) => Promise<boolean>
  readonly removeDeviceFromAccount: (userId: string, deviceId: number) => Promise<boolean>
}

export async function applyVisibilityChanges(
  changes: readonly VisibilityChange[],
  target: VisibilitySyncTarget,
  logger: IScopedLogger,
): Promise<void> {
  for (const change of changes) {
    for (const deviceId of change.added) {
      const ok = await target.pushDeviceToAccount(change.userId, deviceId).catch((err: unknown) => {
        logger.warn('alexa access: pushing a newly granted device failed', {
          tags: { deviceId },
          meta: { userId: change.userId, error: errMsg(err) },
        })
        return false
      })
      logger.info(
        'alexa access: the linked user gained this device — pushed to their Alexa account',
        {
          tags: { deviceId },
          meta: { userId: change.userId, delivered: ok },
        },
      )
    }
    for (const deviceId of change.removed) {
      const ok = await target
        .removeDeviceFromAccount(change.userId, deviceId)
        .catch((err: unknown) => {
          logger.warn('alexa access: deleting a revoked device failed', {
            tags: { deviceId },
            meta: { userId: change.userId, error: errMsg(err) },
          })
          return false
        })
      logger.warn(
        'alexa access: the linked user lost this device (confirmed twice) — deleted from their Alexa account',
        { tags: { deviceId }, meta: { userId: change.userId, delivered: ok } },
      )
    }
  }
}
