/**
 * Motion-sensor builder — adds a `Service.MotionSensor` to the supplied
 * camera accessory and keeps `Characteristic.MotionDetected` in sync
 * with the camstack `motion-detection` cap.
 *
 * Wire-up:
 *  - Subscribes to `EventCategory.MotionOnMotionChanged` filtered by
 *    the device's numeric id. Each event carries `{ detected: boolean }`
 *    which we forward to `Characteristic.MotionDetected`.
 *  - Auto-resets to `false` after `RESET_DEBOUNCE_MS` of no fresh
 *    `detected: true` push — covers cameras whose firmware doesn't emit
 *    an explicit "clear" event.
 *  - Initial state is hydrated from the typed device proxy
 *    (`proxy.motion.isDetected({})`) when the motion cap is bound.
 */

import { EventCategory } from '@camstack/types'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { applyServiceLabel } from './service-label.js'
import { hapServiceName } from './service-names.js'

const RESET_DEBOUNCE_MS = 5_000

/**
 * @param existing - The controller's OWN `MotionSensor`, when HomeKit Secure
 *  Video is advertised. HKSV derives its `EventTriggerOption.MOTION` from the
 *  service the `CameraController` created (`sensors: { motion: true }`) and is
 *  blind to any other one — a second MotionSensor added here would keep working
 *  as a sensor in the Home app while silently triggering no recording at all.
 *  `null` when recording is off, in which case this builder owns the service as
 *  it always has.
 */
export async function buildMotionSensor(
  bctx: BuilderContext,
  existing: Service | null = null,
): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId, displayName } = bctx

  // Sanitised even though it is the device's own name: an operator name
  // carrying an em-dash or a trailing symbol trips hap-nodejs' `checkName` and
  // iOS discards the label.
  //
  // Routed through `applyServiceLabel` like every other service on the
  // accessory — including the controller's OWN motion service under HKSV,
  // which is a service the operator sees and can rename. It was once excluded
  // on the theory that a sensor is not a separately named tile; that theory was
  // never measured, and excluding it left one service on the accessory whose
  // name a paired controller could never be told about. See `service-label.ts`.
  const label = hapServiceName([displayName], `Camera ${numericDeviceId}`)
  const motionService = existing ?? accessory.addService(Service.MotionSensor, label)
  applyServiceLabel(motionService, label)
  motionService.setCharacteristic(Characteristic.MotionDetected, false)

  // Hydrate from the typed proxy. Failures are non-fatal — the next
  // event will set the state correctly.
  try {
    const detected = await proxy.motion?.isDetected({})
    if (typeof detected === 'boolean') {
      motionService.updateCharacteristic(Characteristic.MotionDetected, detected)
    }
  } catch (err) {
    ctx.logger
      .withTags({ deviceId: numericDeviceId })
      .debug('export-hap: initial motion hydrate failed (non-fatal)', {
        meta: { error: errMsg(err) },
      })
  }

  let resetTimer: NodeJS.Timeout | null = null
  const armReset = (): void => {
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      motionService.updateCharacteristic(Characteristic.MotionDetected, false)
      resetTimer = null
    }, RESET_DEBOUNCE_MS)
  }

  // When HKSV is on, this push is the ENTIRE recording trigger: HomeKit records
  // on the controller's own motion service and on nothing else, so a motion
  // that does not arrive here is a timeline that stays empty by construction.
  // It used to be pushed with no log line at all, which made "motion never
  // reached HomeKit" and "HomeKit chose not to record" the same silence — the
  // exact question asked of camera 101 on 2026-08-08.
  const motionLog = ctx.logger.withTags({ deviceId: numericDeviceId })
  const hksvTrigger = existing !== null

  const unsubscribe = ctx.eventBus.subscribe(
    { category: EventCategory.MotionOnMotionChanged },
    (event) => {
      if (event.data.deviceId !== numericDeviceId) return
      const detected = event.data.detected === true
      motionService.updateCharacteristic(Characteristic.MotionDetected, detected)
      motionLog.debug('export-hap: motion pushed to HomeKit', {
        meta: { detected, hksvTrigger },
      })
      if (detected) {
        armReset()
      } else if (resetTimer) {
        clearTimeout(resetTimer)
        resetTimer = null
      }
    },
  )

  return {
    async dispose(): Promise<void> {
      unsubscribe()
      if (resetTimer) {
        clearTimeout(resetTimer)
        resetTimer = null
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
