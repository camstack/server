/**
 * Child-switch builder — turns a camstack accessory child device (siren,
 * floodlight, spotlight, …) into a HomeKit Service ON THE PARENT
 * camera Accessory.
 *
 * The orchestrator (`child-accessory.ts → buildChildServicesFor`)
 * hands this builder the PARENT accessory + the CHILD's proxy + a
 * unique subtype so each service round-trips deterministically through
 * HAP serialisation. The builder:
 *  - Maps `switch` cap → `Service.Switch`, or the service the device's switch
 *    sub-role names (`onOffServiceKind`).
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

import { DeviceType, isOutlet, isSwitchFan, isSwitchLight } from '@camstack/types'
import { Characteristic, Service } from '@homebridge/hap-nodejs'

import type { BuilderContext, BuilderHandle } from '../types.js'
import { applyServiceLabel } from './service-label.js'

/**
 * The HomeKit service an on/off device becomes. A switch's sub-role is read
 * only through the `@camstack/types` accessors (operator decision 2026-11-12:
 * every switch sub-role is exported as its own service, on/off only):
 *  - a dimmable light (brightness on a Light / Generic) → Lightbulb + Brightness;
 *  - a relay driving a lamp (`switch-light`) → Lightbulb, no Brightness;
 *  - an outlet → Outlet (`OutletInUse` mirrors power: the plug reports no load);
 *  - a fan behind a switch (`switch-fan`) → Fan, `On` only, no RotationSpeed;
 *  - a plug-in heater (`switch-heater`) → Switch: HomeKit's only heater
 *    service (HeaterCooler) requires a current temperature and a target state
 *    the device does not have, and a fake thermostat would lie;
 *  - a helper boolean (`binary-helper`), a siren, any other switch → Switch.
 */
export type OnOffServiceKind = 'dimmable-lightbulb' | 'lightbulb' | 'outlet' | 'fan' | 'switch'

export function onOffServiceKind(
  deviceType: DeviceType,
  role: string | null,
  hasBrightness: boolean,
): OnOffServiceKind {
  // Only true lighting devices map onto a dimmable Lightbulb. A siren also
  // exposes `brightness` (alarm volume), and iOS Home would render it as a
  // light — wrong icon, wrong scenes, wrong Siri intents.
  const isLightingDevice = deviceType === DeviceType.Light || deviceType === DeviceType.Generic
  if (hasBrightness && isLightingDevice) return 'dimmable-lightbulb'
  if (isSwitchLight(deviceType, role)) return 'lightbulb'
  if (isOutlet(deviceType, role)) return 'outlet'
  if (isSwitchFan(deviceType, role)) return 'fan'
  return 'switch'
}

function addOnOffService(
  accessory: BuilderContext['accessory'],
  kind: OnOffServiceKind,
  displayName: string,
  subtype: string,
): Service {
  if (kind === 'dimmable-lightbulb' || kind === 'lightbulb') {
    return accessory.addService(Service.Lightbulb, displayName, subtype)
  }
  if (kind === 'outlet') return accessory.addService(Service.Outlet, displayName, subtype)
  if (kind === 'fan') return accessory.addService(Service.Fan, displayName, subtype)
  return accessory.addService(Service.Switch, displayName, subtype)
}

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
  role: string | null = null,
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

  const kind = onOffServiceKind(deviceType, role, hasBrightness)
  const dimmable = kind === 'dimmable-lightbulb'
  // `displayName` is already resolved by `child-accessory.ts` through
  // `childServiceName`, so it is HAP-valid and device-derived. It is published
  // on BOTH `Name` and `ConfiguredName` — see `service-label.ts`.
  const service = addOnOffService(accessory, kind, displayName, subtype)
  applyServiceLabel(service, displayName)
  const setOn = (on: boolean): void => {
    service.updateCharacteristic(Characteristic.On, on)
    if (kind === 'outlet') service.updateCharacteristic(Characteristic.OutletInUse, on)
  }

  // Hydrate on-state
  try {
    const switchStatus = (await proxy.switch?.getStatus({})) as SwitchStatus | null
    if (switchStatus && typeof switchStatus.on === 'boolean') {
      setOn(switchStatus.on)
    }
  } catch (err) {
    log.debug('export-hap: child switch.getStatus failed (non-fatal)', {
      meta: { error: errMsg(err) },
    })
  }

  // Hydrate brightness
  if (dimmable) {
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
  if (dimmable) {
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
        setOn(value.on)
      }
    })
    unsubscribes.push(unsubSwitch)
  }
  if (dimmable && proxy.state.brightness) {
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
