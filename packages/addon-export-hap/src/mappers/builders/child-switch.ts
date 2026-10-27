/**
 * Child-switch builder — turns a camstack accessory child device (siren,
 * floodlight, spotlight, …) into a HomeKit Service ON THE PARENT
 * camera Accessory.
 *
 * The orchestrator (`child-accessory.ts → buildChildServicesFor`)
 * hands this builder the PARENT accessory + the CHILD's proxy + a
 * unique subtype so each service round-trips deterministically through
 * HAP serialisation. The builder:
 *  - Maps `switch` cap → `Service.Switch`.
 *  - Maps `switch` + `brightness` cap → `Service.Lightbulb` with
 *    Brightness characteristic (lighting devices only — see below).
 *  - Hydrates initial state from `getStatus({})`.
 *  - Wires `Characteristic.On` / `Characteristic.Brightness` through
 *    the typed DeviceProxy.
 *  - Subscribes to runtime-state slice updates so iOS Home reflects
 *    external state changes (e.g. another integration toggling the
 *    light).
 *
 * Service-kind selection: most cameras expose `brightness` on a siren
 * because it controls the alarm VOLUME, not luminosity. Mapping a
 * siren onto `Service.Lightbulb` makes it appear as a regular light in
 * iOS Home (wrong icon, wrong scenes, wrong Siri intents). We therefore
 * gate `Service.Lightbulb` on the child's `DeviceType` — only Light /
 * Generic devices keep the Lightbulb shape; Siren, Switch, and others
 * fall back to `Service.Switch`. Volume control for sirens is exposed
 * through the camstack admin UI; iOS Home only needs the on/off toggle.
 *
 * Child devices without `switch` / `brightness` cap (status sensors,
 * IR LED, etc.) return a no-op handle.
 */

import { DeviceType } from '@camstack/types'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { applyServiceLabel } from './service-label.js'

interface SwitchStatus {
  readonly on?: boolean
}

interface BrightnessStatus {
  readonly level?: number
}

export async function buildChildSwitch(
  bctx: BuilderContext,
  subtype: string,
  deviceType: DeviceType,
): Promise<BuilderHandle> {
  const { ctx, accessory, proxy, numericDeviceId, displayName } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })

  const hasSwitch = !!proxy.switch
  const hasBrightness = !!proxy.brightness

  if (!hasSwitch && !hasBrightness) {
    log.debug('export-hap: child has no switch/brightness cap — skipping')
    return {
      async dispose() {
        /* nothing */
      },
    }
  }

  // Only true lighting devices map onto `Service.Lightbulb`. A siren
  // also exposes `brightness` (alarm volume) but iOS Home would render
  // it as a light — wrong icon, wrong scenes, wrong Siri intents. Gate
  // on the child's DeviceType instead of the brightness cap alone.
  const isLightingDevice = deviceType === DeviceType.Light || deviceType === DeviceType.Generic
  const useLightbulb = hasBrightness && isLightingDevice
  // `displayName` is already resolved by `child-accessory.ts` through
  // `childServiceName`, so it is HAP-valid and device-derived. It is published
  // on BOTH `Name` and `ConfiguredName` — see `service-label.ts`.
  const service = useLightbulb
    ? accessory.addService(Service.Lightbulb, displayName, subtype)
    : accessory.addService(Service.Switch, displayName, subtype)
  applyServiceLabel(service, displayName)

  // Hydrate on-state
  try {
    const switchStatus = (await proxy.switch?.getStatus({})) as SwitchStatus | null
    if (switchStatus && typeof switchStatus.on === 'boolean') {
      service.updateCharacteristic(Characteristic.On, switchStatus.on)
    }
  } catch (err) {
    log.debug('export-hap: child switch.getStatus failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  // Hydrate brightness
  if (useLightbulb) {
    try {
      const status = (await proxy.brightness?.getStatus({})) as BrightnessStatus | null
      if (status && typeof status.level === 'number') {
        service.updateCharacteristic(Characteristic.Brightness, status.level)
      }
    } catch (err) {
      log.debug('export-hap: child brightness.getStatus failed (non-fatal)', {
        meta: { error: errMsg(err) },
      })
    }
  }

  // Wire setState
  if (hasSwitch) {
    service.getCharacteristic(Characteristic.On).onSet(async (value) => {
      const on = value === true
      try {
        await proxy.switch?.setState({ on })
      } catch (err) {
        log.warn('export-hap: child switch.setState failed', {
          meta: { on, error: errMsg(err) },
        })
      }
    })
  }

  // Wire setBrightness
  if (useLightbulb) {
    service.getCharacteristic(Characteristic.Brightness).onSet(async (value) => {
      const percentage = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(percentage)) return
      try {
        await proxy.brightness?.setBrightness({ level: percentage })
      } catch (err) {
        log.warn('export-hap: child brightness.setBrightness failed', {
          meta: { percentage, error: errMsg(err) },
        })
      }
    })
  }

  // Live state — subscribe to slice changes for push updates from
  // other integrations toggling the same device.
  const unsubscribes: Array<() => void> = []
  if (proxy.state.switch) {
    const unsubSwitch = proxy.state.switch.subscribe((value) => {
      if (value && typeof value.on === 'boolean') {
        service.updateCharacteristic(Characteristic.On, value.on)
      }
    })
    unsubscribes.push(unsubSwitch)
  }
  if (useLightbulb && proxy.state.brightness) {
    const unsubBrightness = proxy.state.brightness.subscribe((value) => {
      if (value && typeof value.level === 'number') {
        service.updateCharacteristic(Characteristic.Brightness, value.level)
      }
    })
    unsubscribes.push(unsubBrightness)
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
