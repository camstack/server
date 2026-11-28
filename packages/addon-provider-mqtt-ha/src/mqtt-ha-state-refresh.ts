/**
 * MQTT's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * Every state a device has arrives as a broker message the addon caches per
 * topic (`push: 'full'`), so the core never schedules a read. The `refresh` it
 * can ask for is NOT an upstream read (MQTT has no query): it recomputes the
 * device's slices from the cached payloads, which recovers a notification that
 * was dropped on the way to the device.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** Never scheduled (push full); only the floor the core accepts. */
export const MQTT_HA_MIN_REFRESH_INTERVAL_MS = 1_000

/** The part of a device context the refresh registration uses. */
export type MqttHaRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface MqttHaStateRefreshTarget {
  readonly ctx: MqttHaRefreshContext
  /** The broker id, the integration the core groups the device under. */
  readonly brokerId: string
  /** Recompute every slice from the cached payloads. */
  readonly reapplyCache: () => void
}

export function mqttHaRefreshPolicy(brokerId: string): StateRefreshPolicy {
  return {
    integrationId: brokerId,
    minIntervalMs: MQTT_HA_MIN_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'full',
  }
}

export function registerMqttHaStateRefresh(target: MqttHaStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      target.reapplyCache()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: mqttHaRefreshPolicy(target.brokerId),
  })
}
