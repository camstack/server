/**
 * Hikvision accessory subsystem barrel — kind-keyed factory + concrete
 * classes. The provider/parent imports `createAccessoryDevice` to
 * instantiate a child by `AccessoryKind`, and never has to know which
 * concrete class implements each kind.
 */

import type { DeviceContext, IDevice, AccessoryKindValue } from '@camstack/types'
import { AccessoryKind } from '@camstack/types'
import { HikvisionLightAccessory, type HikvisionLightHost } from './light.js'
import { HikvisionSirenAccessory, type HikvisionSirenHost } from './siren.js'

export {
  HikvisionLightAccessory,
  lightAccessorySchema,
  type LightAccessoryConfig,
  type HikvisionLightHost,
} from './light.js'
export {
  HikvisionSirenAccessory,
  sirenAccessorySchema,
  type SirenAccessoryConfig,
  type HikvisionSirenHost,
} from './siren.js'
export {
  hikvisionAccessoryBaseSchema,
  isHikvisionSupportedAccessoryKind,
  type HikvisionAccessoryHost,
} from './base.js'

/**
 * Factory — pick the right concrete class for an `AccessoryKindValue`
 * and instantiate it with the shared `(ctx, parent)` pair. The
 * accessory's persisted config has already been written to the DB
 * by the kernel's `spawnAccessoryChild` (for create) or is already
 * there (for restore); the constructor reads it via
 * `ctx.persistedConfig`.
 *
 * The host parameter must satisfy the union of every per-kind host
 * requirement (light wants `lightSupportedModes`, siren wants
 * `alarmInputPorts`). Hikvision's parent camera implements both
 * directly so the same camera object is passed regardless of kind.
 *
 * Throws on `AccessoryKindValue`s Hikvision doesn't model
 * (PIR / Autotrack / Spotlight / Chime / Nightvision / PrivacyMask)
 * — callers should gate with `isHikvisionSupportedAccessoryKind`
 * before invoking the factory in restore paths where saved rows
 * might carry stale or cross-vendor kinds.
 */
export function createAccessoryDevice(
  kind: AccessoryKindValue,
  ctx: DeviceContext,
  parent: HikvisionLightHost & HikvisionSirenHost,
): IDevice {
  switch (kind) {
    case AccessoryKind.Floodlight:
      return new HikvisionLightAccessory(ctx, parent)
    case AccessoryKind.Siren:
      return new HikvisionSirenAccessory(ctx, parent)
    default:
      throw new Error(`Hikvision provider does not implement accessory kind "${String(kind)}"`)
  }
}
