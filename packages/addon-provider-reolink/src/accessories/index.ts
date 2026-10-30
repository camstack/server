/**
 * Reolink accessory subsystem barrel export — kind-keyed factory +
 * concrete classes. The provider addon imports `createAccessoryDevice`
 * to instantiate a child by `kind`, and never has to know which
 * concrete class implements each kind.
 *
 * Autotrack is NOT modelled here — it's an extension of PTZ exposed
 * via the `ptz-autotrack` cap on the parent camera, not a child
 * device. See `ReolinkCamera.registerPtzAutotrackIfSupported()`.
 */

import type { AccessoryKindValue, DeviceContext, IDevice } from '@camstack/types'
import { AccessoryKind } from '@camstack/types'
import { type ReolinkAccessoryHost } from './base.js'
import { FloodlightAccessory } from './floodlight.js'
import { PirAccessory } from './pir.js'
import { SirenAccessory } from './siren.js'

export {
  isReolinkSupportedAccessoryKind,
  type ReolinkAccessoryHost,
  reolinkAccessoryBaseSchema,
} from './base.js'
export {
  FloodlightAccessory,
  type FloodlightAccessoryConfig,
  floodlightAccessorySchema,
} from './floodlight.js'
export {
  PirAccessory,
  type PirAccessoryConfig,
  pirAccessorySchema,
} from './pir.js'
export {
  SirenAccessory,
  type SirenAccessoryConfig,
  sirenAccessorySchema,
} from './siren.js'

/**
 * Factory — pick the right concrete class for an `AccessoryKindValue`
 * and instantiate it with the shared `(ctx, parent)` pair. The
 * accessory's persisted config has already been written to the DB
 * by `kernel.devices.persistInitialConfig` (for create) or is
 * already there (for restore); the constructor reads it via
 * `ctx.persistedConfig`.
 *
 * Throws on `AccessoryKindValue`s Reolink doesn't model as accessories
 * (Autotrack lives on the parent via `ptz-autotrack` cap; Spotlight /
 * Chime / Nightvision / PrivacyMask aren't implemented yet) — callers
 * should gate with `isReolinkSupportedAccessoryKind` before invoking
 * the factory in restore paths where saved rows might carry stale or
 * cross-vendor kinds.
 */
export function createAccessoryDevice(
  kind: AccessoryKindValue,
  ctx: DeviceContext,
  parent: ReolinkAccessoryHost,
): IDevice {
  switch (kind) {
    case AccessoryKind.Siren:
      return new SirenAccessory(ctx, parent)
    case AccessoryKind.Floodlight:
      return new FloodlightAccessory(ctx, parent)
    case AccessoryKind.PirSensor:
      return new PirAccessory(ctx, parent)
    default:
      throw new Error(`Reolink provider does not implement accessory kind "${String(kind)}"`)
  }
}
