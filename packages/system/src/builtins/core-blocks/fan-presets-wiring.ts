/**
 * Builds the `fan-presets` runtime out of what core-blocks owns: the
 * per-device settings store (D865: a fan's presets live under the key
 * `fanPresets`) and the cluster API (a device's type and container, the
 * current readings, the cap call a step makes).
 *
 * Kept out of `core-blocks.addon.ts` so the seams are read and specced
 * without booting the addon.
 */
import {
  type AddonApi,
  type AddonContext,
  ControlStatusSchema,
  FanControlStatusSchema,
  type FanPreset,
  FanPresetSchema,
  type IScopedLogger,
  SwitchStatusSchema,
} from '@camstack/types'
import { z } from 'zod'
import { FanPresetActionSource } from './fan-presets-action-source.js'
import {
  FanPresetsService,
  type FanPresetsDevices,
  type FanPresetsReadings,
  type FanPresetsStore,
} from './fan-presets-service.js'
import { invokeCapOver } from './actions-wiring.js'
import { templateDoorOver } from './device-template-door.js'

/** The key of the device's settings store that holds a fan's presets. */
export const FAN_PRESETS_STORE_KEY = 'fanPresets'

type DeviceSettings = Pick<
  NonNullable<AddonContext['settings']>,
  'readDeviceStore' | 'writeDeviceStore' | 'readDeviceStoreBatch' | 'listDeviceStoreIds'
>

export interface FanPresetsRuntimeDeps {
  readonly settings: DeviceSettings
  readonly api: () => AddonApi | undefined
  readonly addonId: string
  readonly logger: IScopedLogger
}

export interface FanPresetsRuntime {
  readonly presets: FanPresetsService
  readonly actionSource: FanPresetActionSource
}

const PresetListSchema = z.array(FanPresetSchema)

/** A stored list that no longer parses reads as "no presets", loudly, never as a throw. */
function parseStored(raw: unknown, deviceId: number, logger: IScopedLogger): readonly FanPreset[] {
  if (raw === undefined) return []
  const parsed = PresetListSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  logger.warn('fan presets: a stored list no longer parses, the fan reads as having none', {
    tags: { deviceId },
    meta: { issues: parsed.error.issues.length },
  })
  return []
}

export function fanPresetsStoreOver(
  settings: DeviceSettings,
  logger: IScopedLogger,
): FanPresetsStore {
  return {
    read: async (deviceId) =>
      parseStored(
        (await settings.readDeviceStore(deviceId))[FAN_PRESETS_STORE_KEY],
        deviceId,
        logger,
      ),
    write: async (deviceId, presets) => {
      await settings.writeDeviceStore(deviceId, { [FAN_PRESETS_STORE_KEY]: presets })
    },
    listAll: async () => {
      const ids = await settings.listDeviceStoreIds()
      const out = new Map<number, readonly FanPreset[]>()
      if (ids.length === 0) return out
      for (const [deviceId, row] of await settings.readDeviceStoreBatch(ids)) {
        const presets = parseStored(row[FAN_PRESETS_STORE_KEY], deviceId, logger)
        if (presets.length > 0) out.set(deviceId, presets)
      }
      return out
    },
  }
}

export function fanPresetsDevicesOver(api: () => AddonApi | undefined): FanPresetsDevices {
  const need = (): AddonApi => {
    const current = api()
    if (current === undefined) throw new Error('core-blocks: no ctx.api — devices cannot be read')
    return current
  }
  return {
    describe: async (deviceId) => {
      const found = await need().deviceManager.getDevice.query({ deviceId })
      return found === null || found === undefined
        ? null
        : { name: found.name, type: found.type, parentDeviceId: found.parentDeviceId }
    },
    childrenOf: async (parentDeviceId) => {
      const rows = await need().deviceManager.getChildren.query({ parentDeviceId })
      return rows.map((row) => row.id)
    },
  }
}

/** A reading that errors or does not parse is unknown (null), never a default (D393). */
export function fanPresetsReadingsOver(
  api: () => AddonApi | undefined,
  logger: IScopedLogger,
): FanPresetsReadings {
  const read = async <T>(
    deviceId: number,
    what: string,
    query: (current: AddonApi) => Promise<unknown>,
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    const current = api()
    if (current === undefined) return null
    try {
      const parsed = schema.safeParse(await query(current))
      return parsed.success ? parsed.data : null
    } catch (err: unknown) {
      logger.debug(`fan presets: no ${what} reading for the device`, {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
  return {
    fan: (deviceId) =>
      read(
        deviceId,
        'fan-control',
        (a) => a.fanControl.getStatus.query({ deviceId }),
        FanControlStatusSchema,
      ),
    control: (deviceId) =>
      read(
        deviceId,
        'control',
        (a) => a.control.getStatus.query({ deviceId }),
        ControlStatusSchema,
      ),
    switchState: (deviceId) =>
      read(deviceId, 'switch', (a) => a.switch.getStatus.query({ deviceId }), SwitchStatusSchema),
  }
}

export function buildFanPresetsRuntime(deps: FanPresetsRuntimeDeps): FanPresetsRuntime {
  const store = fanPresetsStoreOver(deps.settings, deps.logger.child('fan-presets'))
  const devices = fanPresetsDevicesOver(deps.api)
  const presets = new FanPresetsService({
    store,
    devices,
    readings: fanPresetsReadingsOver(deps.api, deps.logger.child('fan-presets')),
    invoke: invokeCapOver(deps.api),
    templates: templateDoorOver(deps.api),
    logger: deps.logger.child('fan-presets'),
  })
  const actionSource = new FanPresetActionSource({
    presets,
    devices,
    store,
    addonId: deps.addonId,
    logger: deps.logger.child('fan-presets'),
  })
  return { presets, actionSource }
}
