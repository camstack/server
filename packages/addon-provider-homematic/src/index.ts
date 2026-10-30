export { HomematicProviderAddon } from './addon.js'
export {
  homematicConfigSchema,
  homematicGatewayDeviceSchema,
  toHomematicOptions,
  buildConnectionFormSchema,
  connectionFromSettings,
} from './config.js'
export type { HomematicConfig, HomematicGatewayDeviceConfig } from './config.js'
export {
  mapHmChannel,
  mapHmDeviceChannels,
  inferHmDeviceType,
} from './homematic-mapping.js'
export type { HmChannelMapping, MappedChannel } from './homematic-mapping.js'
export { deriveHmEntitySpecs } from './devices/hm-entity-spec.js'
export type { HmEntitySpec, HmEntitySpecSource } from './devices/hm-entity-spec.js'
