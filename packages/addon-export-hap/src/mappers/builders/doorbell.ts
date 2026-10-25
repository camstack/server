/**
 * Doorbell builder — wires camstack `doorbell.onPressed` events into
 * the HAP Doorbell service so iOS Home receives a ring notification.
 *
 * The Doorbell service itself is created by the `DoorbellController`
 * (the camera-accessory orchestrator picks `DoorbellController` over
 * `CameraController` when the device has the `doorbell` cap). This
 * builder is responsible only for SIGNALLING — it subscribes to the
 * `EventCategory.DoorbellOnPressed` event and calls `ringDoorbell()`
 * on the controller, which translates to the
 * `ProgrammableSwitchEvent.SINGLE_PRESS` push expected by HomeKit.
 *
 * Every hop is logged, tagged `deviceId`. That is not decoration: this
 * path used to be entirely silent — `ringDoorbell()` returns `void`,
 * and hap-nodejs drops the event frame without a word when no HAP
 * connection has SUBSCRIBED to the characteristic (see
 * `doorbell-delivery.ts`). On 2026-08-07 a real press on camera 101
 * produced zero `export-hap` output and no iPhone notification, and
 * there was no way to tell whether the event had even arrived. The
 * three outcomes — never arrived / arrived for another camera / rang
 * into an empty room — are now distinct lines.
 */
import type { DoorbellController } from '@homebridge/hap-nodejs'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import { EventCategory } from '@camstack/types'

import { describeDoorbellDelivery, ringReachedNobody } from './doorbell-delivery.js'
import type { BuilderContext, BuilderHandle } from '../types.js'

export interface DoorbellBuilderInput {
  readonly bctx: BuilderContext
  readonly controller: DoorbellController
}

export async function buildDoorbell(input: DoorbellBuilderInput): Promise<BuilderHandle> {
  const { bctx, controller } = input
  const { ctx, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  log.info('export-hap: doorbell forward armed — HomeKit will ring on doorbell.onPressed')

  const unsubscribe = ctx.eventBus.subscribe(
    { category: EventCategory.DoorbellOnPressed },
    (event) => {
      const pressedDeviceId = (event.data as { deviceId?: unknown } | null)?.deviceId
      if (pressedDeviceId !== numericDeviceId) return
      try {
        // Probe BEFORE ringing: a controller that subscribes between the two
        // calls would make the report claim a delivery the frame never had.
        // The Doorbell service is read off the ACCESSORY (public API) — the
        // controller keeps its own reference private.
        const delivery = describeDoorbellDelivery(
          bctx.accessory,
          bctx.accessory
            .getService(Service.Doorbell)
            ?.getCharacteristic(Characteristic.ProgrammableSwitchEvent) ?? null,
        )
        controller.ringDoorbell()
        if (ringReachedNobody(delivery)) {
          log.warn(
            'export-hap: doorbell rang but NO HomeKit controller is subscribed — the press was dropped before it left the hub (no home hub connected, or the accessory was republished and iOS has not re-subscribed yet)',
            { meta: { ...delivery } },
          )
          return
        }
        log.info('export-hap: doorbell SINGLE_PRESS pushed to HomeKit', {
          meta: { ...delivery },
        })
      } catch (err) {
        log.warn('export-hap: ringDoorbell() failed', { meta: { error: errMsg(err) } })
      }
    },
  )

  return {
    async dispose(): Promise<void> {
      unsubscribe()
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
