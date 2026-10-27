/**
 * Battery builder — surfaces a battery-operated camera's power state
 * as HAP `Service.Battery` on the camera accessory.
 *
 * Hydrates the initial snapshot from `proxy.battery.getStatus({})` and
 * subscribes to the runtime-state slice so iOS Home reflects level /
 * charging changes pushed by the firmware without a poll loop.
 *
 * The status→characteristic mapping is {@link batteryCharacteristicUpdates},
 * exported because the generic (non-camera) export path publishes the same
 * `Service.Battery` from the same cap — one derivation, two accessory shapes.
 *
 * Skipped silently when the `battery` cap is not bound — caller checks
 * cap presence before invoking this builder (see `camera-accessory.ts`).
 */
import { Characteristic, Service, type Service as HapService } from '@homebridge/hap-nodejs'

import { BatteryStatusSchema } from '@camstack/types'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { applyUpdates, reader } from './generic/characteristic-update.js'
import { hapServiceName } from './service-names.js'
import { applyServiceLabel } from './service-label.js'

const LOW_BATTERY_THRESHOLD_PCT = 20

/**
 * `percentage` is required; `charging` is not.
 *
 * A provider that reports a level without a charging source used to be read as
 * `charging !== 'none'` → CHARGING, so a missing field became a claim. Absent
 * now means absent: the level and the low-battery flag still land, and
 * `ChargingState` is simply not written.
 */
const BatteryReadSchema = BatteryStatusSchema.pick({ level: true }).extend({
  charging: BatteryStatusSchema.shape.charging.optional(),
})

/**
 * Mapping:
 *  - `BatteryStatus.level` (0..100) → `Characteristic.BatteryLevel`
 *  - `BatteryStatus.charging`:
 *      `'none'` → `ChargingState.NOT_CHARGING`
 *      `'dc' | 'solar'` → `ChargingState.CHARGING`
 *      `'unknown'` (or absent) → not written; HomeKit has no "unknown" and
 *      either value would be a claim
 *  - `percentage <= LOW_BATTERY_THRESHOLD_PCT` → `StatusLowBattery.LOW`
 */
export const batteryCharacteristicUpdates = reader(BatteryReadSchema, (status) => {
  // A NOT-YET-KNOWN level publishes nothing at all. Coercing it to 0 would
  // hand HomeKit a flat battery and a LOW warning for every camera on every
  // hub restart — which is the bug that made `percentage` nullable.
  if (status.level === null) {
    return status.charging === undefined || status.charging === 'unknown'
      ? []
      : [
          {
            characteristic: Characteristic.ChargingState,
            value:
              status.charging === 'none'
                ? Characteristic.ChargingState.NOT_CHARGING
                : Characteristic.ChargingState.CHARGING,
          },
        ]
  }
  const pct = Math.max(0, Math.min(100, Math.round(status.level)))
  return [
    { characteristic: Characteristic.BatteryLevel, value: pct },
    ...(status.charging === undefined || status.charging === 'unknown'
      ? []
      : [
          {
            characteristic: Characteristic.ChargingState,
            value:
              status.charging === 'none'
                ? Characteristic.ChargingState.NOT_CHARGING
                : Characteristic.ChargingState.CHARGING,
          },
        ]),
    {
      characteristic: Characteristic.StatusLowBattery,
      value:
        pct <= LOW_BATTERY_THRESHOLD_PCT
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    },
  ]
})

export async function buildBattery(bctx: BuilderContext): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId, displayName } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  // See `motion-sensor.ts` — the device name is sanitised for the same reason.
  const label = hapServiceName([displayName], `Camera ${numericDeviceId}`)
  const service = accessory.addService(Service.Battery, label)
  applyServiceLabel(service, label)

  try {
    const status = await proxy.battery?.getStatus({})
    if (status !== undefined && status !== null) applyToService(service, status)
  } catch (err) {
    log.debug('export-hap: battery getStatus hydrate failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  const unsubscribes: Array<() => void> = []
  if (proxy.state.battery) {
    const unsub = proxy.state.battery.subscribe((value) => {
      if (!value) return
      applyToService(service, value)
    })
    unsubscribes.push(unsub)
  }

  return {
    async dispose(): Promise<void> {
      for (const u of unsubscribes) {
        try {
          u()
        } catch {
          /* already gone */
        }
      }
    },
  }
}

function applyToService(service: HapService, status: unknown): void {
  applyUpdates(service, batteryCharacteristicUpdates(status))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
