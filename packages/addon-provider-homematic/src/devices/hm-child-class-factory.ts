import type { DeviceConstructor, DeviceContext, IDevice } from '@camstack/types'
import { HmActuatorDevice } from './hm-actuator-device.js'
import { HmSensorDevice } from './hm-sensor-device.js'
import { HmEventEmitterDevice } from './hm-event-emitter-device.js'
import { HmDiagnosticDevice } from './hm-diagnostic-device.js'
import { HmUpdateDevice } from './hm-update-device.js'
import type { HmEntitySpec } from './hm-entity-spec.js'

/** Constructor shape every Homematic accessory child satisfies. */
export type HmChildConstructor = new (ctx: DeviceContext) => IDevice

/**
 * Pick the concrete Homematic accessory-child class for a restored child whose
 * parent Container has not yet re-derived it. Mirrors `pickHaChildClass`:
 * resolve the class purely from the persisted config (capabilities + the
 * diagnostic provenance marker `sourceParams`). Used by the `addon.ts`
 * restore dispatcher so a child row restores into the right class even before
 * the Container's `getAccessoryChildren()` reconcile runs.
 *
 * Order (first match wins):
 *   1. actuator caps (switch/cover/lock-control/climate-control) → HmActuatorDevice
 *   2. event-emitter                                             → HmEventEmitterDevice
 *   3. update                                                    → HmUpdateDevice
 *   4. sensor/binary/temperature caps WITH `sourceParams`        → HmDiagnosticDevice
 *   5. any remaining sensor caps                                 → HmSensorDevice
 *
 * Diagnostics and plain sensors share the same cap names (`numeric-sensor` /
 * `binary` / `temperature-sensor`) — the MAINTENANCE-provenance `sourceParams`
 * marker on the config disambiguates them.
 */
export function pickHmChildClass(
  capabilities: readonly string[],
  isDiagnostic: boolean,
): HmChildConstructor {
  if (
    capabilities.includes('switch') ||
    capabilities.includes('cover') ||
    capabilities.includes('lock-control') ||
    capabilities.includes('climate-control')
  ) {
    return HmActuatorDevice
  }
  if (capabilities.includes('event-emitter')) return HmEventEmitterDevice
  if (capabilities.includes('update')) return HmUpdateDevice
  if (isDiagnostic) return HmDiagnosticDevice
  return HmSensorDevice
}

/**
 * Pick the concrete child class for a derived {@link HmEntitySpec} (the
 * `'devices'` Container path + the `'entities'` standalone path share this).
 * Diagnostic provenance is carried on the spec config's `sourceParams` — the
 * SAME disambiguator {@link pickHmChildClass} uses for restore — so a diagnostic
 * sensor and a plain sensor (identical cap names) resolve to different classes.
 */
export function hmChildClassForSpec(spec: HmEntitySpec): HmChildConstructor {
  return pickHmChildClass(spec.capabilities, hasDiagnosticProvenance(spec.config))
}

/** A factory for a derived child spec — `new`s the resolved concrete class. */
export function hmChildFactoryForSpec(spec: HmEntitySpec): (ctx: DeviceContext) => IDevice {
  const Klass = hmChildClassForSpec(spec)
  return (ctx) => new Klass(ctx)
}

/** Read the `capabilities` string array from a persisted config blob. */
function readCapabilities(config: Record<string, unknown> | undefined): readonly string[] {
  const raw = config?.['capabilities']
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is string => typeof c === 'string')
}

/** A child carries MAINTENANCE diagnostic provenance when its config has a
 *  non-empty `sourceParams` array (only diagnostic children persist that). */
function hasDiagnosticProvenance(config: Record<string, unknown> | undefined): boolean {
  const raw = config?.['sourceParams']
  return Array.isArray(raw) && raw.length > 0
}

/**
 * Cap-re-derive dispatcher used as the `DeviceClass` for an accessory child in
 * the `addon.ts` restore map. The kernel restores a child row by `deviceClasses[type]`;
 * mapping every child DeviceType (Switch / Cover / Thermostat / Lock / Sensor /
 * EventEmitter / Update) to THIS dispatcher means restore re-reads the
 * persisted config and re-derives the concrete child class via
 * `pickHmChildClass` — so a child whose parent Container hasn't reconciled yet
 * still restores into the right class, mirroring HA's `standaloneEntityDeviceClass`.
 *
 * A JS constructor that returns an object replaces the `new` result, so
 * `new HmChildDispatcher(ctx)` yields a real `HmActuatorDevice` / `HmSensorDevice`
 * / … instance. TS types the class's `new` as its own (member-less) instance, so
 * the export carries a single documented `DeviceConstructor<IDevice>` boundary
 * cast (CLAUDE.md sanctions documented type-boundary `as X`). `instanceof
 * HmChildDispatcher` is always false — it is a dispatch shim, never a real type.
 */
// Must be a `new`-able class to satisfy the kernel's `DeviceConstructor` restore-map
// contract; the constructor returns a different concrete instance — a plain function cannot.
// oxlint-disable-next-line typescript/no-extraneous-class -- intentional dispatch shim, see above
class HmChildDispatcher {
  constructor(ctx: DeviceContext) {
    const caps = readCapabilities(ctx.persistedConfig)
    const Klass = pickHmChildClass(caps, hasDiagnosticProvenance(ctx.persistedConfig))
    // A constructor returning an object replaces the `new` result: the produced
    // instance IS the per-origin IDevice.
    return new Klass(ctx)
  }
}

/** The documented boundary-cast export used in the `deviceClasses` restore map. */
export const hmChildDeviceClass = HmChildDispatcher as DeviceConstructor<IDevice>
