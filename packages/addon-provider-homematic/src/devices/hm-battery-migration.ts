import type { DeviceManagerApi, IScopedLogger } from '@dominevo/types'
import type { HmCustomEntity, HmDevice } from 'nodehomematic'
import { HM_BATTERY_CAP } from './hm-battery.js'
import { deriveHmEntitySpecs } from './hm-entity-spec.js'

/**
 * A functional child adopted BEFORE the battery cap existed persisted its
 * `capabilities` without `battery`, and the kernel persists an accessory spec
 * only on the first spawn. The derived config is therefore re-applied here, the
 * same way the other providers re-derive a persisted shape
 * (`applyDerivedSpec`): the kernel merges the patch and rebuilds the live
 * instance, so the constructor sees `battery` and registers the cap. The same
 * pass REMOVES `battery` from a non-primary child of an earlier release.
 */

export interface BatteryMigrationArgs {
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'applyDerivedSpec'>
  readonly logger: IScopedLogger
  readonly hmDevice: HmDevice
  readonly customEntities: readonly HmCustomEntity[]
  /** The child's device id. */
  readonly deviceId: number
  /** The `HmEntitySpec.key` of the child (`act-…` / `sensor-…`). */
  readonly specKey: string
}

function namesBattery(value: unknown): boolean {
  return Array.isArray(value) && value.includes(HM_BATTERY_CAP)
}

/** True when the child was re-derived (its persisted config gained `battery`). */
export async function migrateBatteryConfig(args: BatteryMigrationArgs): Promise<boolean> {
  const spec = deriveHmEntitySpecs(args.hmDevice, args.customEntities).find(
    (candidate) => candidate.key === args.specKey,
  )
  const derived = spec?.config['capabilities']
  if (!Array.isArray(derived)) return false
  const persisted = await args.devices.loadConfig(args.deviceId)
  const gains = namesBattery(derived)
  if (namesBattery(persisted['capabilities']) === gains) return false
  await args.devices.applyDerivedSpec(args.deviceId, { config: { capabilities: derived } })
  args.logger.info(
    gains
      ? 'Homematic child gained the battery capability'
      : 'Homematic child lost the battery capability (not the primary child)',
    {
      tags: { deviceId: args.deviceId },
      meta: { address: args.hmDevice.address, key: args.specKey },
    },
  )
  return true
}
