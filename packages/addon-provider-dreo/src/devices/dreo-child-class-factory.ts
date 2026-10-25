import type { DeviceContext, IDevice } from '@camstack/types'
import { classifyDreoModel } from '../dreo-domain-mapping.js'
import { DreoFanDevice } from './dreo-fan-device.js'
import { DreoPurifierDevice } from './dreo-purifier-device.js'
import { DreoHeaterDevice } from './dreo-heater-device.js'
import { DreoHumidifierDevice } from './dreo-humidifier-device.js'

/**
 * Resolve the concrete Dreo accessory-child class from the persisted child
 * config's `model` string. Mirrors the Dreame `dreoChildFactory` seam: the
 * Container's `getAccessoryChildren()` hands the kernel this factory, which picks
 * the device class from the model classification.
 *
 * Throws a descriptive error for an unsupported model — the discovery/adoption
 * layer already filters those out, so this only fires on a corrupt persisted row.
 */
export function dreoChildFactory(ctx: DeviceContext): IDevice {
  const model = readModel(ctx.persistedConfig)
  const kind = classifyDreoModel(model)
  switch (kind) {
    case 'fan':
      return new DreoFanDevice(ctx)
    case 'purifier':
      return new DreoPurifierDevice(ctx)
    case 'heater':
      return new DreoHeaterDevice(ctx)
    case 'humidifier':
      return new DreoHumidifierDevice(ctx)
    case 'unsupported':
      throw new Error(`dreo child factory: unsupported model "${model}" (id=${ctx.id})`)
  }
}

function readModel(config: Record<string, unknown> | undefined): string {
  const model = config?.['model']
  return typeof model === 'string' ? model : ''
}
