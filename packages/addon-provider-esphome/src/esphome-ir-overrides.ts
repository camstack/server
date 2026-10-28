import type { IScopedLogger } from '@camstack/types'
import { parseIrServices, type IrServicesSetting } from './esphome-ir-plan.js'

/**
 * The per-board `irServices` override as the container reads it. The settings
 * live in the board's device settings store (the only home of per-device
 * config); the addon loads them here because a container derives its children
 * synchronously (`getAccessoryChildren`) and cannot await a store read.
 * Keyed by the container's device id; absent = automatic.
 */
export class EspIrOverrides {
  private readonly byDevice = new Map<number, IrServicesSetting>()

  get(deviceId: number): IrServicesSetting {
    return this.byDevice.get(deviceId) ?? 'auto'
  }

  set(deviceId: number, setting: IrServicesSetting): void {
    this.byDevice.set(deviceId, setting)
  }

  delete(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }

  clear(): void {
    this.byDevice.clear()
  }
}

export const espIrOverrides = new EspIrOverrides()

export interface LoadIrOverridesDeps {
  readonly deviceIds: readonly number[]
  readonly overrides: EspIrOverrides
  readonly logger: IScopedLogger
  /** One batched read of the per-device settings store. */
  readonly readStores: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, Record<string, unknown>>>
}

/**
 * Refresh the override of each device from its settings store. A value that
 * does not parse is logged and treated as automatic: the boards keep their
 * transmitters rather than lose them to a typo.
 */
export async function loadIrOverrides(deps: LoadIrOverridesDeps): Promise<void> {
  if (deps.deviceIds.length === 0) return
  const stores = await deps.readStores(deps.deviceIds)
  for (const deviceId of deps.deviceIds) {
    const raw = stores.get(deviceId)?.['irServices']
    const setting = parseIrServices(raw)
    if (setting === null) {
      deps.logger.warn('esphome: irServices setting is malformed; using automatic', {
        tags: { deviceId },
        meta: { value: JSON.stringify(raw) },
      })
    }
    deps.overrides.set(deviceId, setting ?? 'auto')
  }
}
