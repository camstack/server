/**
 * The ONE fleet-default resolver (D986 point 3), shared by hub-main's settings view and the forked
 * runner's, over the same two stores both already use (D870):
 *
 *   device row (`addon-device-settings`)  ->  fleet-default row (`addon-settings`)  ->  schema default
 *
 * `readDeviceStore` keeps returning the device's RAW overrides; this is a separate, additive read
 * that says, per field, the value AND where it came from (`device` | `fleet-default` |
 * `schema-default`), so a device form can mark an inherited field and offer Reset. Reset is "delete
 * the device row" (`writeDeviceStore(id, { field: undefined })`): an override equal to the default
 * stays an override.
 *
 * Both layers are read THREE-way: a store that did not answer THROWS. Falling back to the schema
 * default on a failed read would show, and let a caller act on, a value nobody chose (D49).
 */
import { resolveDeviceSettings, type ResolvedSettings } from '@camstack/types/addon'
import { readUnscopedAddonSettings } from './addon-settings-store.js'
import {
  createDeviceSettingsStore,
  readDeviceOrThrow,
  type DeviceSettingsDoor,
} from './device-settings-store.js'

/** The door slice the resolver needs: the per-device store's, which already carries `query`. */
export type DeviceSettingsResolverDoor = DeviceSettingsDoor

export interface DeviceSettingsResolver {
  /**
   * @param schemaDefaults the device form's field defaults; they name the fields resolved.
   * @throws when either store could not be read.
   */
  resolve(
    deviceId: number,
    schemaDefaults: Readonly<Record<string, unknown>>,
  ): Promise<ResolvedSettings>
}

export function createDeviceSettingsResolver(
  door: DeviceSettingsResolverDoor,
  addonId: string,
): DeviceSettingsResolver {
  const deviceStore = createDeviceSettingsStore(door, addonId)
  return {
    async resolve(deviceId, schemaDefaults) {
      const [fleet, deviceOverrides] = await Promise.all([
        readUnscopedAddonSettings(door, addonId),
        readDeviceOrThrow(deviceStore, deviceId),
      ])
      if (fleet.kind === 'unreadable') {
        throw new Error(`fleet defaults of "${addonId}" could not be read: ${fleet.error}`)
      }
      return resolveDeviceSettings({
        schemaDefaults,
        fleetDefaults: fleet.kind === 'present' ? fleet.value : {},
        deviceOverrides,
      })
    },
  }
}
