/**
 * `lock-control` → `Service.LockMechanism`.
 *
 * Not a sensor row: HomeKit models a lock as two characteristics, a CURRENT
 * state the accessory owns and a TARGET state the controller writes, and the
 * cap's five states do not map onto either one alone.
 *
 * ```
 *  cap state    LockCurrentState   LockTargetState
 *  locked       SECURED            SECURED
 *  unlocked     UNSECURED          UNSECURED
 *  locking      UNKNOWN            SECURED      (in flight — do not claim SECURED)
 *  unlocking    UNKNOWN            UNSECURED
 *  jammed       JAMMED             unchanged    (the controller's intent stands)
 * ```
 *
 * Reporting SECURED while the bolt is still moving is the failure worth naming:
 * iOS renders the lock as closed, the operator walks away, and the motor stalls
 * behind them. `UNKNOWN` is the honest answer for an in-flight transition.
 *
 * `open` (the cap's third method, for locks with a latch/buzzer) has no HomeKit
 * counterpart on this service and is deliberately not wired — a Switch that
 * silently buzzes a door open would be a second knob nobody asked for.
 */
import { LockControlStatusSchema } from '@camstack/types'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../../types.js'
import { hapServiceName } from '../service-names.js'
import { applyServiceLabel } from '../service-label.js'
import { applyUpdates, reader } from './characteristic-update.js'

const SUBTYPE = 'lock-control'

const readLock = reader(LockControlStatusSchema.pick({ state: true }), (status) => {
  const current =
    status.state === 'locked'
      ? Characteristic.LockCurrentState.SECURED
      : status.state === 'unlocked'
        ? Characteristic.LockCurrentState.UNSECURED
        : status.state === 'jammed'
          ? Characteristic.LockCurrentState.JAMMED
          : Characteristic.LockCurrentState.UNKNOWN
  const target =
    status.state === 'locked' || status.state === 'locking'
      ? Characteristic.LockTargetState.SECURED
      : status.state === 'unlocked' || status.state === 'unlocking'
        ? Characteristic.LockTargetState.UNSECURED
        : null
  return [
    { characteristic: Characteristic.LockCurrentState, value: current },
    ...(target === null ? [] : [{ characteristic: Characteristic.LockTargetState, value: target }]),
  ]
})

export async function buildLockMechanism(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId, displayName } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  const label = hapServiceName([displayName], `Lock ${numericDeviceId}`)
  const service = accessory.addService(Service.LockMechanism, label, SUBTYPE)
  applyServiceLabel(service, label)

  const apply = (status: unknown, source: string): void => {
    const updates = readLock(status)
    if (updates.length === 0) {
      log.debug('export-hap: lock status did not match the cap schema — no update', {
        meta: { source },
      })
      return
    }
    applyUpdates(service, updates)
  }

  try {
    const status = await proxy.lockControl?.getStatus({})
    if (status !== undefined && status !== null) apply(status, 'getStatus')
  } catch (err) {
    log.debug('export-hap: lock getStatus hydrate failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  service.getCharacteristic(Characteristic.LockTargetState).onSet(async (value) => {
    const secure = value === Characteristic.LockTargetState.SECURED
    try {
      // No optimistic write of LockCurrentState: the cap pushes the real
      // transition through the slice, and claiming SECURED before the bolt
      // moved is exactly the lie this builder refuses to tell.
      if (secure) {
        await proxy.lockControl?.lock({})
      } else {
        await proxy.lockControl?.unlock({})
      }
    } catch (err) {
      log.warn('export-hap: lock command failed', {
        meta: { secure, error: errMsg(err) },
      })
    }
  })

  const unsubscribe =
    proxy.state.lockControl?.subscribe((value) => {
      if (value === undefined || value === null) return
      apply(value, 'slice')
    }) ?? null

  return {
    async dispose(): Promise<void> {
      try {
        unsubscribe?.()
      } catch {
        /* already gone */
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
