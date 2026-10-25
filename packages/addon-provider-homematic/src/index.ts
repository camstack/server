export { HomematicProviderAddon } from './addon.js'
export { HomematicDevice, homematicDeviceSchema } from './homematic-device.js'
export type { HomematicDeviceConfig } from './homematic-device.js'
export {
  homematicConfigSchema,
  homematicAddonConfigSchema,
  toHomematicOptions,
  buildConnectionFormSchema,
} from './config.js'
export type { HomematicConfig, HomematicAddonConfigV2 } from './config.js'
export {
  mapHmChannel,
  mapHmDeviceChannels,
  inferHmDeviceType,
} from './homematic-mapping.js'
export type { HmChannelMapping, MappedChannel } from './homematic-mapping.js'
export { deriveHmEntitySpecs } from './devices/hm-entity-spec.js'
export type { HmEntitySpec, HmEntitySpecSource } from './devices/hm-entity-spec.js'
